/**
 * Message protocol between the inspector panel (in the app) and the inspector agent injected into the
 * live preview (see agent.ts, run by the preview shim). All messages are plain structured-cloneable objects.
 *
 * Parent → frame: the app posts requests to the preview iframe's window with
 *   `frame.contentWindow.postMessage({ ...request, token: previewToken }, '*')`.
 * Frame → parent: the agent posts with `parent.postMessage({ ...event, token }, '*')`, like the existing
 * `console` / `navigate` messages, so the app's token check applies unchanged.
 *
 * Requests that expect an answer carry a numeric `rid`; the answer echoes it.
 */

/** Prefix of every inspector message type. */
export const INSPECT_PREFIX = 'inspect:';

/** Maximum number of network entries the agent keeps for `inspect:network-all`. */
export const NETWORK_BUFFER = 300;

// ------------------------------------------------------------------ data

/** One step of a breadcrumb path (html → … → element). */
export interface Crumb {
  id: number;
  /** `div#main.card` */
  label: string;
}

export interface TreeText {
  k: 't';
  /** Whitespace-collapsed text, at most 80 characters. */
  text: string;
}

export interface TreeElement {
  k: 'e';
  /** Stable id of the element for the lifetime of the document. */
  id: number;
  /** Lower-case tag name. */
  tag: string;
  /** Attributes in document order; values are cut at 200 characters. */
  attrs: [string, string][];
  /** Number of child items (elements and non-empty text nodes). */
  count: number;
  /** Child items, or undefined when not loaded yet (request `inspect:tree` with `id`). */
  children?: TreeChild[];
  /** Child items left out because the node has too many children. */
  more?: number;
}

export type TreeChild = TreeElement | TreeText;

export interface Decl {
  name: string;
  value: string;
  important: boolean;
  /** Overridden by a declaration with higher priority (inline style, specificity, order). */
  overridden?: boolean;
  /** The value was shortened for display (long data: URLs); it cannot be edited. */
  truncated?: boolean;
}

export interface MatchedRule {
  /** Address of the rule for `inspect:edit-style` (`s<sheet>/<index>/<index>…`). */
  key: string;
  /** Full selector of the rule. */
  selector: string;
  /** The parts of the selector list that match the element. */
  matched: string;
  specificity: [number, number, number];
  decls: Decl[];
  /** Project file the rule comes from (`data-codevia-src` of the inlined <style>, or the page itself). */
  src: string | null;
  /** `file`: a linked CSS file; `page`: a <style> written in the page; `external`: a stylesheet from the network. */
  origin: 'file' | 'page' | 'external';
  /** Enclosing @media / @supports / @container / @layer conditions, outermost first. */
  conditions?: string[];
}

export interface Edges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface BoxModel {
  /** Content box size. */
  width: number;
  height: number;
  margin: Edges;
  border: Edges;
  padding: Edges;
  /** Border box position in the viewport. */
  x: number;
  y: number;
  boxSizing: string;
  display: string;
  position: string;
}

export type NetworkKind = 'fetch' | 'xhr' | 'resource';
export type NetworkType = 'document' | 'json' | 'text' | 'css' | 'script' | 'image' | 'font' | 'media' | 'other';

export interface NetworkEntry {
  /** Id of the entry, unique within the document. Updates of an entry reuse it. */
  nid: number;
  kind: NetworkKind;
  method: string;
  /** URL as requested (project paths stay relative). */
  url: string;
  /** Project file served for the request, when it was resolved against the project. */
  path?: string;
  /** `project`: served from the project files; `network`: a real request. */
  source: 'project' | 'network';
  /** HTTP status; 0 while pending or when the request failed. */
  status: number;
  statusText: string;
  type: NetworkType;
  mime: string;
  /** Response size in bytes, -1 when unknown. */
  size: number;
  /** Milliseconds from start to completion (0 while pending). */
  duration: number;
  /** performance.now() at start. */
  start: number;
  pending: boolean;
  error?: string;
  /** Resource initiator (img, script, link, css…) for resource entries. */
  initiator?: string;
  reqHeaders?: [string, string][];
  resHeaders?: [string, string][];
  /** Whether a response preview may be available through `inspect:response`. */
  hasBody?: boolean;
}

// ------------------------------------------------------------------ parent → frame

export type InspectorRequest =
  /** Starts observers (DOM changes, resource loads) and live network events. Answer: `inspect:enabled`. */
  | { type: 'inspect:enable' }
  /** Stops everything: overlay, pick mode, observers. No answer. */
  | { type: 'inspect:disable' }
  /**
   * DOM tree. Without `id`: from <html>; with `id`: that element and its children.
   * `depth` levels are loaded (default 3); `expanded` ids and the ancestors of `reveal` always get their children.
   */
  | { type: 'inspect:tree'; rid: number; id?: number; depth?: number; expanded?: number[]; reveal?: number }
  /** Highlights the element (null clears). `scroll` scrolls it into view. Answer: `inspect:selected`. */
  | { type: 'inspect:select'; id: number | null; scroll?: boolean }
  /** Matched rules, inline style, computed style, box model and attributes. Answer: `inspect:styles`. */
  | { type: 'inspect:styles'; rid: number; id: number; allComputed?: boolean }
  /** Pick-by-tap mode. Answer: `inspect:pick` with the new state; a tap posts `inspect:picked`. */
  | { type: 'inspect:pick'; on: boolean }
  /**
   * Live style edit (not saved). With `rule` (a MatchedRule key) the rule is changed, otherwise the inline style.
   * An empty value removes the property. Answer: `inspect:edited`.
   */
  | { type: 'inspect:edit-style'; rid: number; id: number; prop: string; value: string; important?: boolean; rule?: string }
  /** Live attribute edit: `value` null removes it; `oldName` renames. Answer: `inspect:edited`. */
  | { type: 'inspect:edit-attr'; rid: number; id: number; name: string; value: string | null; oldName?: string }
  /** document.querySelectorAll in the page. Answer: `inspect:query`. */
  | { type: 'inspect:query'; rid: number; selector: string }
  /** The buffered network log (last NETWORK_BUFFER entries). Answer: `inspect:network-all`. */
  | { type: 'inspect:network-all'; rid: number }
  /** Clears the network log. No answer. */
  | { type: 'inspect:network-clear' }
  /** Response preview of an entry. Answer: `inspect:response`. */
  | { type: 'inspect:response'; rid: number; nid: number };

// ------------------------------------------------------------------ frame → parent

export type InspectorEvent =
  /** Posted once when a preview document starts: the panel re-enables itself after a reload. */
  | { type: 'inspect:hello'; page: string }
  | { type: 'inspect:enabled'; page: string; title: string }
  | { type: 'inspect:tree'; rid: number; node: TreeElement | null; path?: Crumb[] }
  | { type: 'inspect:selected'; id: number | null; path: Crumb[]; box: BoxModel | null }
  | {
      type: 'inspect:styles';
      rid: number;
      id: number;
      found: boolean;
      tag: string;
      path: Crumb[];
      inline: Decl[];
      rules: MatchedRule[];
      computed: [string, string][];
      box: BoxModel | null;
      attrs: [string, string][];
      /** Names of attributes whose value was shortened (cannot be edited). */
      attrsTruncated: string[];
      error?: string;
    }
  | { type: 'inspect:pick'; on: boolean }
  | { type: 'inspect:picked'; id: number; path: Crumb[] }
  | { type: 'inspect:edited'; rid: number; ok: boolean; error?: string }
  | { type: 'inspect:query'; rid: number; results: Crumb[]; total: number; error?: string }
  | { type: 'inspect:network'; entry: NetworkEntry }
  | { type: 'inspect:network-all'; rid: number; entries: NetworkEntry[] }
  | { type: 'inspect:response'; rid: number; nid: number; mime: string; text?: string; dataUrl?: string; url?: string; truncated?: boolean }
  /** The DOM changed (debounced): refresh the tree. */
  | { type: 'inspect:dom-changed' };

/** Message forwarded by the app from the preview: inspector events and the existing console messages. */
export type PreviewMessage = InspectorEvent | { type: 'console'; level: string; args: string[] };

/** Bridge between the panel and the live preview frame. The app implements it (see README of the tool). */
export interface InspectorBridge {
  /** Posts a request to the preview frame (the app adds the frame token). No-op when there is no preview. */
  send(msg: InspectorRequest): void;
  /** Subscribes to messages from the preview frame (already token-checked by the app). Returns unsubscribe. */
  onMessage(handler: (msg: PreviewMessage) => void): () => void;
  /** Console lines already shown in the app's preview console (optional, to prefill the Console tab). */
  consoleHistory?(): { level: string; text: string }[];
  /**
   * Called when pick-by-tap mode starts or ends (optional). On a phone the panel covers the preview, so the app
   * should reveal the preview while `on` is true (e.g. minimize the panel) and restore the panel afterwards.
   */
  onPickChange?(on: boolean): void;
}

export const isInspectorType = (type: unknown): type is InspectorEvent['type'] =>
  typeof type === 'string' && type.startsWith(INSPECT_PREFIX);

/** Whether `msg` is something the panel understands (inspector event or console line). */
export function isPreviewMessage(msg: unknown): msg is PreviewMessage {
  if (!msg || typeof msg !== 'object') return false;
  const type = (msg as { type?: unknown }).type;
  return isInspectorType(type) || type === 'console';
}

/** Adds the frame token, as the app must before posting a request to the preview. */
export const withToken = <T extends InspectorRequest>(msg: T, token: string): T & { token: string } => ({ ...msg, token });

// ------------------------------------------------------------------ helpers shared by the panel and tests

/** `selector {\n  prop: value;\n}` — the "copy CSS rule" helper. */
export function cssRuleText(selector: string, decls: Pick<Decl, 'name' | 'value' | 'important'>[]): string {
  const body = decls
    .filter((d) => d.name && d.value !== '')
    .map((d) => `  ${d.name}: ${d.value}${d.important ? ' !important' : ''};`)
    .join('\n');
  return `${selector} {\n${body}${body ? '\n' : ''}}`;
}

/** A selector for an element from its crumb label (`div#main.card` → `#main`, else the label). */
export function selectorFromLabel(label: string): string {
  const id = /#([^.#\s]+)/.exec(label);
  return id ? `#${id[1]}` : label;
}

/** Category of a network entry for the Network filter chips. */
export type NetworkFilter = 'all' | 'fetch' | 'document' | 'css' | 'script' | 'image' | 'media' | 'font' | 'other';

export function networkFilterOf(e: Pick<NetworkEntry, 'kind' | 'type'>): Exclude<NetworkFilter, 'all'> {
  if (e.kind === 'fetch' || e.kind === 'xhr') return 'fetch';
  if (e.type === 'json' || e.type === 'text') return 'other';
  return e.type;
}

/** Finds the 1-based line of a CSS rule with `selector` in a source text (whitespace-insensitive), or undefined. */
export function findRuleLine(source: string, selector: string): number | undefined {
  const sel = selector.trim();
  if (!sel) return undefined;
  let pattern = '';
  for (const part of sel.split(/(\s*[>+~,]\s*|\s+)/)) {
    if (!part) continue;
    const comb = part.trim();
    if (!comb) pattern += '\\s+';
    else if (/^[>+~,]$/.test(comb)) pattern += `\\s*\\${comb}\\s*`;
    else pattern += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"|'/g, `["']`);
  }
  let re: RegExp;
  try {
    // The selector must start a rule: at the start, after `{`, `}`, `;`, a comment or an HTML <style> tag.
    re = new RegExp(`(^|[{};]|\\*/|<style[^>]*>)(\\s*)(${pattern})\\s*\\{`, 'i');
  } catch {
    return undefined;
  }
  const m = re.exec(source);
  if (!m) return undefined;
  const at = m.index + m[1]!.length + m[2]!.length;
  return source.slice(0, at).split('\n').length;
}

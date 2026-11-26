import { Facet, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { extOf } from '../core/paths';

/**
 * Go to definition: ⌘/Ctrl-click and a long press (≈500 ms, finger held still) on a word call the
 * app's `onGoToDefinition`, which looks the word up (symbols.ts) and navigates. The key-bar command
 * goToDefinitionAtCursor() uses the word at the cursor.
 */
export type DefinitionTrigger = 'click' | 'longpress' | 'command';

export interface DefinitionOptions {
  /** Called with the word and its document offset. The app finds the definition and opens it. */
  onGoToDefinition?: (word: string, pos: number, path: string, via: DefinitionTrigger) => void;
  /**
   * Optional filter for the long press: return false when the word has no known definition, so a
   * long press on other words keeps its usual meaning (text selection, the magnifier).
   */
  hasDefinition?: (word: string, path: string) => boolean;
}

interface DefinitionConfig extends DefinitionOptions {
  path: string;
}

const definitionConfig = Facet.define<DefinitionConfig, DefinitionConfig | null>({
  combine: (values) => values[values.length - 1] ?? null,
});

export const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 10;

/** Word characters: CSS/HTML names contain dashes (`--accent`, `btn-primary`), code uses `$`. */
function wordChar(path: string): RegExp {
  return /^(css|scss|less|html|htm|svg|xml|vue)$/.test(extOf(path)) ? /[\w-]/ : /[\w$]/;
}

/** The identifier-like word around `pos` (null on whitespace, punctuation or numbers). */
export function wordAt(state: EditorState, pos: number, path: string): { word: string; from: number; to: number } | null {
  const line = state.doc.lineAt(pos);
  const re = wordChar(path);
  const text = line.text;
  let start = pos - line.from;
  let end = start;
  while (start > 0 && re.test(text[start - 1]!)) start--;
  while (end < text.length && re.test(text[end]!)) end++;
  const word = text.slice(start, end).replace(/^-(?!-)/, '');
  if (!word || /^\d/.test(word) || !/[A-Za-z_$]/.test(word)) return null;
  return { word, from: line.from + start + (text.slice(start, end).length - word.length), to: line.from + end };
}

function trigger(view: EditorView, pos: number, via: DefinitionTrigger): boolean {
  const cfg = view.state.facet(definitionConfig);
  if (!cfg?.onGoToDefinition) return false;
  const hit = wordAt(view.state, pos, cfg.path);
  if (!hit) return false;
  if (via === 'longpress' && cfg.hasDefinition && !cfg.hasDefinition(hit.word, cfg.path)) return false;
  cfg.onGoToDefinition(hit.word, hit.from, cfg.path, via);
  return true;
}

/** Key-bar button: go to the definition of the word at the cursor. */
export function goToDefinitionAtCursor(view: EditorView): boolean {
  return trigger(view, view.state.selection.main.head, 'command');
}

/** The word at the cursor (for "find all references"). */
export function wordAtCursor(view: EditorView): string | null {
  const cfg = view.state.facet(definitionConfig);
  return wordAt(view.state, view.state.selection.main.head, cfg?.path ?? '')?.word ?? null;
}

const longPress = ViewPlugin.define((view) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let startX = 0;
  let startY = 0;
  let fired = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const onStart = (e: TouchEvent) => {
    cancel();
    fired = false;
    if (e.touches.length !== 1 || !view.state.facet(definitionConfig)?.onGoToDefinition) return;
    const touch = e.touches[0]!;
    startX = touch.clientX;
    startY = touch.clientY;
    timer = setTimeout(() => {
      timer = undefined;
      const pos = view.posAtCoords({ x: startX, y: startY });
      if (pos !== null && trigger(view, pos, 'longpress')) fired = true;
    }, LONG_PRESS_MS);
  };
  const onMove = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (!touch || Math.hypot(touch.clientX - startX, touch.clientY - startY) > MOVE_TOLERANCE) cancel();
  };
  const onEnd = (e: TouchEvent) => {
    cancel();
    // Keep the tap that ends a long press from also moving the cursor or opening the callout.
    if (fired && e.cancelable) e.preventDefault();
    fired = false;
  };
  const dom = view.contentDOM;
  dom.addEventListener('touchstart', onStart, { passive: true });
  dom.addEventListener('touchmove', onMove, { passive: true });
  dom.addEventListener('touchend', onEnd);
  dom.addEventListener('touchcancel', cancel);
  return {
    destroy() {
      cancel();
      dom.removeEventListener('touchstart', onStart);
      dom.removeEventListener('touchmove', onMove);
      dom.removeEventListener('touchend', onEnd);
      dom.removeEventListener('touchcancel', cancel);
    },
  };
});

export function definitionExtension(path: string, opts: DefinitionOptions): Extension {
  return [
    definitionConfig.of({ ...opts, path }),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (e.button !== 0 || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null || !trigger(view, pos, 'click')) return false;
        e.preventDefault();
        return true;
      },
    }),
    longPress,
    // ⌘/Ctrl-click is taken by "go to definition"; Alt-click adds a cursor (as in VS Code).
    EditorView.clickAddsSelectionRange.of((e) => e.altKey),
  ];
}

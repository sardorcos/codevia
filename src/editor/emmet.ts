import {
  acceptCompletion,
  pickedCompletion,
  selectedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { cssLanguage } from '@codemirror/lang-css';
import { phpLanguage } from '@codemirror/lang-php';
import { EditorState, Prec, type Extension, type StateCommand } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import {
  abbreviationTracker,
  balanceInward as emmetBalanceInward,
  balanceOutward as emmetBalanceOutward,
  emmetCompletionSource,
  emmetConfig,
  EmmetKnownSyntax,
  expandAbbreviation as emmetExpand,
  goToTagPair as emmetGoToTagPair,
  wrapWithAbbreviation as emmetWrapExtension,
} from '@emmetio/codemirror6-plugin';
import expand, { extract } from 'emmet';
import { t } from '../i18n';
import { emmetModeFor } from './emmet-mode';

/**
 * Emmet (official @emmetio/codemirror6-plugin): abbreviation tracker with preview while typing,
 * Tab / Enter (via the "Emmet abbreviation" autocomplete entry) to expand, wrap with abbreviation,
 * balance and go to matching tag. Markdown gets a lighter mode (see markdownEmmet()).
 */
export { emmetModeFor, type EmmetMode } from './emmet-mode';

/** Key the wrap-with-abbreviation prompt is bound to; the key-bar helper triggers the same binding. */
const WRAP_KEY = 'Ctrl-w';

type TrackerCompletion = Completion & { tracker?: { simple?: boolean; forced?: boolean } };

/**
 * The plugin's completion entry, outside CSS (the plugin registers CSS itself). Single-word
 * abbreviations ("hello") are left out, so Enter after a plain word still inserts a new line.
 */
const markupEmmetSource: CompletionSource = (ctx: CompletionContext) => {
  if (cssLanguage.isActiveAt(ctx.state, ctx.pos)) return null;
  const r = emmetCompletionSource(ctx) as CompletionResult | null;
  if (!r) return null;
  const opt = r.options[0] as TrackerCompletion | undefined;
  if (!opt || (opt.tracker?.simple && !opt.tracker.forced)) return null;
  const update = r.update;
  return {
    ...r,
    update:
      update &&
      ((current, from, to, context) => {
        const next = update(current, from, to, context);
        const o = next?.options[0] as TrackerCompletion | undefined;
        return next && o && !(o.tracker?.simple && !o.tracker.forced) ? next : null;
      }),
  };
};

/**
 * The tracker treats any non-HTML region of an HTML-based document as markup; inside PHP code that
 * would underline every identifier. Marking the edit as a picked completion makes the tracker reset.
 */
const noTrackingInPhpCode = EditorState.transactionExtender.of((tr) => {
  if (!tr.docChanged) return null;
  let inPhp = false;
  tr.changes.iterChangedRanges((fromA) => {
    if (!inPhp && phpLanguage.isActiveAt(tr.startState, fromA, -1)) inPhp = true;
  });
  return inPhp ? { annotations: pickedCompletion.of({ label: '' }) } : null;
});

const KNOWN_TAGS = new Set(
  'a abbr article aside audio b blockquote br button canvas caption code dd details div dl dt em figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr i iframe img input label legend li main mark nav ol option p pre section select small span strong sub summary sup table tbody td textarea tfoot th thead tr u ul video'.split(
    ' ',
  ),
);

/** Whether `abbr` clearly is an Emmet abbreviation and not prose (used in Markdown). */
export function looksLikeAbbreviation(abbr: string): boolean {
  if (abbr === '!') return true;
  if (/^[a-z][\w-]*(\*\d+)?$/i.test(abbr)) return false;
  if (/[>+*]/.test(abbr) && /^[a-z.#([!]/i.test(abbr)) return true;
  const m = /^([a-z][\w-]*)[.#[]/i.exec(abbr);
  return !!m && KNOWN_TAGS.has(m[1]!.toLowerCase());
}

/** Abbreviation that ends at the cursor and starts the line (after indentation), for Markdown. */
function lineAbbreviation(state: EditorState, pos: number): { from: number; abbr: string } | null {
  const line = state.doc.lineAt(pos);
  const col = pos - line.from;
  const text = line.text;
  if (col < 1) return null;
  const found = extract(text, col, { type: 'markup', lookAhead: false });
  if (!found || found.end !== col || text.slice(0, found.start).trim()) return null;
  return looksLikeAbbreviation(found.abbreviation) ? { from: line.from + found.start, abbr: found.abbreviation } : null;
}

const markdownSource: CompletionSource = (ctx) => {
  const hit = lineAbbreviation(ctx.state, ctx.pos);
  if (!hit) return null;
  let preview = '';
  try {
    preview = expand(hit.abbr, { syntax: 'html', options: { 'output.field': (_i: number, p: string) => p } });
  } catch {
    return null;
  }
  return {
    from: hit.from,
    to: ctx.pos,
    filter: false,
    options: [
      {
        label: t('Развернуть Emmet'),
        detail: hit.abbr,
        type: 'emmet',
        boost: 99,
        info: () => {
          const pre = document.createElement('pre');
          pre.className = 'cm-emmet-md-preview';
          pre.textContent = preview;
          return pre;
        },
        apply: (view) => {
          emmetExpand(view);
        },
      },
    ],
  };
};

function markdownEmmet(): Extension {
  return [
    emmetTab,
    emmetConfig.of({ syntax: EmmetKnownSyntax.html }),
    EditorState.languageData.of(() => [{ autocomplete: markdownSource }]),
    keymap.of([
      {
        key: 'Tab',
        run: (view) => {
          const sel = view.state.selection.main;
          return sel.empty && !!lineAbbreviation(view.state, sel.head) && emmetExpand(view);
        },
      },
    ]),
  ];
}

/**
 * Tab on a selected Emmet suggestion. The plugin's own handler swallows Tab when CodeMirror refuses
 * to accept a completion during its 75 ms interaction delay (fast typing); apply it directly then.
 */
const emmetTab = Prec.high(
  keymap.of([
    {
      key: 'Tab',
      run: (view) => {
        const c = selectedCompletion(view.state);
        if (c?.type !== 'emmet' || typeof c.apply !== 'function') return false;
        if (!acceptCompletion(view)) {
          const sel = view.state.selection.main;
          c.apply(view, c, sel.from, sel.to);
        }
        return true;
      },
    },
  ]),
);

/** Emmet extensions for a file (empty for languages without Emmet). */
export function emmetExtension(path: string): Extension {
  const mode = emmetModeFor(path);
  if (!mode) return [];
  if (mode === 'markdown') return markdownEmmet();
  const stylesheet = mode === 'css' || mode === 'scss' || mode === 'less';
  return [
    emmetTab,
    abbreviationTracker({
      syntax: mode as EmmetKnownSyntax,
      mark: true,
      // The expanded markup is shown in the autocomplete entry's info; a second preview would cover it.
      previewEnabled: false,
      autocompleteTab: true,
      // In stylesheets real property names should win over the Emmet entry ("col" → color, not columns).
      completionBoost: stylesheet ? -5 : 99,
    }),
    emmetWrapExtension(WRAP_KEY),
    stylesheet ? [] : EditorState.languageData.of(() => [{ autocomplete: markupEmmetSource }]),
    /\.(php|phtml)$/i.test(path) ? noTrackingInPhpCode : [],
  ];
}

const run = (cmd: StateCommand) => (view: EditorView): boolean => {
  const ok = cmd(view);
  view.focus();
  return ok;
};

/** Expands the abbreviation left of the cursor (key-bar button). Works in any context of the file. */
export const expandAbbreviation = run(emmetExpand);
/** Selects the enclosing tag pair (outward) / the tag contents (inward). */
export const balanceOutward = run(emmetBalanceOutward);
export const balanceInward = run(emmetBalanceInward);
/** Moves the cursor between an opening tag and its closing tag. */
export const goToMatchingPair = run(emmetGoToTagPair);

/**
 * Opens the "wrap with abbreviation" prompt for the selection (or the tag around the cursor).
 * Only works in files with Emmet markup (HTML, PHP, JSX/TSX, XML/SVG).
 */
export function wrapWithAbbreviation(view: EditorView): boolean {
  const ev = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', keyCode: 87, ctrlKey: true, bubbles: true, cancelable: true });
  const ok = runScopeHandlers(view, ev, 'editor');
  const input = view.dom.querySelector<HTMLInputElement>('.emmet-wrap-with-abbreviation input');
  if (input) {
    input.placeholder = t('Сокращение Emmet, например div.box');
    input.setAttribute('aria-label', t('Сокращение Emmet'));
    for (const [k, v] of Object.entries({ autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'done' })) {
      input.setAttribute(k, v);
    }
    input.focus();
  }
  return ok;
}

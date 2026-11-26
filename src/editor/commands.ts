import { acceptCompletion, completionStatus, hasNextSnippetField, nextSnippetField, prevSnippetField } from '@codemirror/autocomplete';
import { indentLess as cmIndentLess, indentMore as cmIndentMore, toggleComment as cmToggleComment } from '@codemirror/commands';
import { getIndentUnit, indentString } from '@codemirror/language';
import { selectNextOccurrence as cmSelectNextOccurrence } from '@codemirror/search';
import type { Command, EditorView } from '@codemirror/view';
import { runScopeHandlers } from '@codemirror/view';

/**
 * Key-bar helpers: each takes the EditorView, runs the action, keeps the editor focused (so the
 * keyboard stays up) and returns whether something happened.
 */
export { balanceInward, balanceOutward, expandAbbreviation, goToMatchingPair, wrapWithAbbreviation } from './emmet-lazy';
export { formatDocument } from './format';
export { diagnosticsCount, nextDiagnostic } from './lint';
export { goToDefinitionAtCursor, wordAtCursor } from './definition';
export { showDiagnosticAt } from './lint';

const focused = (cmd: Command) => (view: EditorView): boolean => {
  const ok = cmd(view);
  view.focus();
  return ok;
};

/** Comments / uncomments the selected lines in the comment syntax of the language at the cursor. */
export const toggleComment = focused(cmToggleComment);
/** Adds the next occurrence of the selected word to the selection (multi-cursor editing). */
export const selectNextOccurrence = focused(cmSelectNextOccurrence);
/** Indents / unindents the selected lines by one unit. */
export const indentMore = focused(cmIndentMore);
export const indentLess = focused(cmIndentLess);
/** Moves to the next / previous field of an inserted snippet. */
export const nextField = focused(nextSnippetField);
export const prevField = focused(prevSnippetField);

/**
 * What a Tab key would do, for the key-bar "⇥" button (phones have no Tab): next snippet field,
 * accept the selected completion, expand a tracked Emmet abbreviation, otherwise insert one indent
 * unit at the cursor.
 */
export function smartTab(view: EditorView): boolean {
  const { state } = view;
  let ok = false;
  if (hasNextSnippetField(state)) ok = nextSnippetField(view);
  else if (completionStatus(state) === 'active') ok = acceptCompletion(view);
  if (!ok && view.contentDOM.querySelector('.emmet-tracker')) {
    const before = view.state.doc;
    runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true }), 'editor');
    ok = view.state.doc !== before;
  }
  if (!ok) {
    const unit = indentString(view.state, getIndentUnit(view.state));
    view.dispatch(view.state.replaceSelection(unit), { userEvent: 'input.type', scrollIntoView: true });
    ok = true;
  }
  view.focus();
  return ok;
}

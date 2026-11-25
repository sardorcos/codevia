import type { EditorView } from '@codemirror/view';

/**
 * Emmet (plugin + engine, ~150 kB) is not part of the startup bundle: it loads the first time a file
 * with Emmet support is opened (createEditor does that), or when a key-bar Emmet action is used.
 */
type EmmetModule = typeof import('./emmet');

let loading: Promise<EmmetModule> | null = null;
let loaded: EmmetModule | null = null;

export function loadEmmet(): Promise<EmmetModule> {
  loading ??= import('./emmet').then((m) => (loaded = m));
  loading.catch(() => (loading = null));
  return loading;
}

/** The Emmet module if it is already loaded. */
export const emmetIfLoaded = (): EmmetModule | null => loaded;

type Action = 'expandAbbreviation' | 'wrapWithAbbreviation' | 'balanceOutward' | 'balanceInward' | 'goToMatchingPair';

const lazy = (name: Action) => (view: EditorView): boolean => {
  if (loaded) return loaded[name](view);
  void loadEmmet().then((m) => m[name](view));
  return true;
};

/** Expands the abbreviation left of the cursor (key-bar button). Works in any context of the file. */
export const expandAbbreviation = lazy('expandAbbreviation');
/** Opens the "wrap with abbreviation" prompt for the selection or the tag around the cursor (HTML-like files). */
export const wrapWithAbbreviation = lazy('wrapWithAbbreviation');
/** Selects the enclosing tag pair (outward) / the tag contents (inward). */
export const balanceOutward = lazy('balanceOutward');
export const balanceInward = lazy('balanceInward');
/** Moves the cursor between an opening tag and its closing tag. */
export const goToMatchingPair = lazy('goToMatchingPair');

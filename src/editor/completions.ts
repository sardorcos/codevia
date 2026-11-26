import { completeFromList, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { cssLanguage } from '@codemirror/lang-css';
import { htmlLanguage } from '@codemirror/lang-html';
import { javascriptLanguage } from '@codemirror/lang-javascript';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { phpLanguage } from '@codemirror/lang-php';
import { pythonLanguage } from '@codemirror/lang-python';
import { syntaxTree } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { langIdOf } from './languages';
import { snippetCompletions, type SnippetLang } from './snippets';

/** Node names where snippets would only get in the way. */
const NO_SNIPPETS_CSS = /(String|Comment)$/;
const NO_SNIPPETS =
  /(String|Comment)$|^(RegExp|AttributeValue|PropertyName|VariableDefinition|PropertyDefinition|TagName|CodeText|InlineCode|CodeBlock|FencedCode)$/;

/** Which snippet set applies at `pos` (follows embedded languages: <style>, <script>, <?php ?>). */
export function snippetLangAt(state: EditorState, pos: number, path: string): SnippetLang | null {
  const fileLang = langIdOf(path);
  if (cssLanguage.isActiveAt(state, pos)) return 'css';
  if (javascriptLanguage.isActiveAt(state, pos)) return fileLang === 'typescript' ? 'typescript' : 'javascript';
  if (pythonLanguage.isActiveAt(state, pos)) return 'python';
  if (phpLanguage.isActiveAt(state, pos)) return 'php';
  if (htmlLanguage.isActiveAt(state, pos)) return 'html';
  if (markdownLanguage.isActiveAt(state, pos)) return 'markdown';
  return null;
}

function snippetSource(path: string): CompletionSource {
  const cache = new Map<string, CompletionSource>();
  const sourceFor = (lang: SnippetLang, phpFile: boolean): CompletionSource => {
    const key = lang + (phpFile ? ':php' : '');
    let src = cache.get(key);
    if (!src) {
      // PHP files also offer the <?php tag in their HTML parts.
      const list = phpFile && lang === 'html' ? [...snippetCompletions('html'), ...snippetCompletions('php').slice(0, 1)] : snippetCompletions(lang);
      src = completeFromList(list);
      cache.set(key, src);
    }
    return src;
  };
  return (ctx: CompletionContext) => {
    const lang = snippetLangAt(ctx.state, ctx.pos, path);
    if (!lang) return null;
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
    const skip = lang === 'css' ? NO_SNIPPETS_CSS : NO_SNIPPETS;
    for (let n: typeof node | null = node; n; n = n.parent) if (skip.test(n.name)) return null;
    const word = ctx.matchBefore(/[\w$:@-]+$/);
    if (!word && !ctx.explicit) return null;
    return sourceFor(lang, langIdOf(path) === 'php')(ctx) as CompletionResult | null;
  };
}

/** Snippet completions for the file (added to every language at every position, filtered by context). */
export function snippetExtension(path: string): Extension {
  const source = snippetSource(path);
  return EditorState.languageData.of(() => [{ autocomplete: source }]);
}

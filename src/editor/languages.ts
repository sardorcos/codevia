import { completeFromList, ifNotIn, type Completion, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { css } from '@codemirror/lang-css';
import { autoCloseTags as htmlAutoCloseTags, htmlCompletionSourceWith, htmlLanguage } from '@codemirror/lang-html';
import {
  autoCloseTags,
  javascriptLanguage,
  jsxLanguage,
  localCompletionSource as jsLocalCompletion,
  tsxLanguage,
  typescriptLanguage,
} from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { globalCompletion as pyGlobalCompletion, localCompletionSource as pyLocalCompletion, pythonLanguage } from '@codemirror/lang-python';
import { LanguageSupport } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { extOf } from '../core/paths';
import { snippetLabels } from './snippets';

/** Language families the editor features (snippets, lint, symbols, Emmet) are keyed by. */
export type LangId = 'html' | 'css' | 'javascript' | 'typescript' | 'json' | 'php' | 'python' | 'markdown' | 'xml' | 'yaml' | 'text';

export function langIdOf(path: string): LangId {
  switch (extOf(path)) {
    case 'html':
    case 'htm':
      return 'html';
    case 'css':
    case 'scss':
    case 'less':
      return 'css';
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'mts':
    case 'cts':
    case 'tsx':
      return 'typescript';
    case 'json':
    case 'webmanifest':
    case 'map':
      return 'json';
    case 'php':
    case 'phtml':
      return 'php';
    case 'py':
      return 'python';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'svg':
    case 'xml':
      return 'xml';
    case 'yml':
    case 'yaml':
      return 'yaml';
    default:
      return 'text';
  }
}

// Keyword completions of @codemirror/lang-javascript, without its built-in snippets
// (ours in snippets.ts replace them, so the popup does not list "for" or "class" twice).
const JS_DONT_COMPLETE = [
  'TemplateString', 'String', 'RegExp', 'LineComment', 'BlockComment', 'VariableDefinition', 'TypeDefinition', 'Label',
  'PropertyDefinition', 'PropertyName', 'PrivatePropertyDefinition', 'PrivatePropertyName', 'JSXText', 'JSXAttributeValue',
  'JSXOpenTag', 'JSXCloseTag', 'JSXSelfClosingTag', '.', '?.',
];
const kw = (label: string): Completion => ({ label, type: 'keyword' });
const JS_KEYWORDS = 'break case const continue default delete export extends false finally in instanceof let new return static super switch this throw true typeof var yield await async of null undefined'
  .split(' ')
  .map(kw);
const TS_KEYWORDS = JS_KEYWORDS.concat('declare implements private protected public readonly abstract keyof'.split(' ').map(kw));

function jsSupport(typescript: boolean, jsx: boolean): LanguageSupport {
  const lang = jsx ? (typescript ? tsxLanguage : jsxLanguage) : typescript ? typescriptLanguage : javascriptLanguage;
  return new LanguageSupport(lang, [
    javascriptLanguage.data.of({ autocomplete: ifNotIn(JS_DONT_COMPLETE, completeFromList(typescript ? TS_KEYWORDS : JS_KEYWORDS)) }),
    javascriptLanguage.data.of({ autocomplete: jsLocalCompletion }),
    jsx ? autoCloseTags : [],
  ]);
}

/** Drops the built-in Python snippets whose labels our snippets reuse (keeps globals such as print, len, range). */
const ourPython = new Set(snippetLabels('python'));
const pyGlobals: CompletionSource = async (ctx) => {
  const r = (await pyGlobalCompletion(ctx)) as CompletionResult | null;
  return r && { ...r, options: r.options.filter((o) => !(o.type === 'keyword' && ourPython.has(o.label))) };
};
/**
 * HTML as in lang-html's html(), but the nested JavaScript uses jsSupport() (so <script> blocks
 * do not show the built-in JS snippets next to ours).
 */
function htmlExtras(): Extension[] {
  return [
    htmlLanguage.data.of({ autocomplete: htmlCompletionSourceWith({}) }),
    htmlAutoCloseTags,
    jsSupport(false, false).support,
    css().support,
  ];
}
const htmlSupport = (): LanguageSupport => new LanguageSupport(htmlLanguage, htmlExtras());
const xmlSupport = (): LanguageSupport =>
  new LanguageSupport(htmlLanguage.configure({ dialect: 'selfClosing' }), htmlExtras());
const phpSupport = (): LanguageSupport => {
  const base = php({ baseLanguage: htmlLanguage.configure({ dialect: 'noMatch' }) });
  return new LanguageSupport(base.language, [base.support, htmlExtras()]);
};

function pythonSupport(): LanguageSupport {
  return new LanguageSupport(pythonLanguage, [
    pythonLanguage.data.of({ autocomplete: pyLocalCompletion }),
    pythonLanguage.data.of({ autocomplete: pyGlobals }),
  ]);
}

export function languageFor(path: string): LanguageSupport | Extension {
  switch (extOf(path)) {
    case 'html':
    case 'htm':
      return htmlSupport();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'js':
    case 'mjs':
    case 'cjs':
      return jsSupport(false, false);
    case 'jsx':
      return jsSupport(false, true);
    case 'ts':
    case 'mts':
    case 'cts':
      return jsSupport(true, false);
    case 'tsx':
      return jsSupport(true, true);
    case 'json':
    case 'webmanifest':
    case 'map':
      return json();
    case 'php':
    case 'phtml':
      return phpSupport();
    case 'py':
      return pythonSupport();
    case 'md':
    case 'markdown':
      return markdown();
    case 'svg':
    case 'xml':
      return xmlSupport();
    default:
      return [];
  }
}

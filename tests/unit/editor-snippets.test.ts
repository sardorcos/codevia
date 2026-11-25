import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { snippetLangAt } from '../../src/editor/completions';
import { languageFor } from '../../src/editor/languages';
import { SNIPPETS, snippetCompletions, snippetLabels, snippetsFor, type SnippetLang } from '../../src/editor/snippets';
import { englishTexts, setLang } from '../../src/i18n';

const LANGS: SnippetLang[] = ['html', 'css', 'javascript', 'typescript', 'python', 'php', 'markdown'];

describe('snippets', () => {
  it('every language has entries', () => {
    for (const lang of LANGS) expect(snippetsFor(lang).length, lang).toBeGreaterThan(4);
  });

  it('covers the requested snippets', () => {
    const has = (lang: SnippetLang, ...labels: string[]) => {
      for (const l of labels) expect(snippetLabels(lang), `${lang}: ${l}`).toContain(l);
    };
    has('html', 'html5', 'link:css', 'script:src', 'meta:vp', 'form', 'table', 'img', 'a', 'button', 'nav', 'section');
    has('css', 'flex-center', 'grid', '@media', '@keyframes', ':root');
    has('javascript', 'for', 'forEach', 'map', 'fetch', 'async', 'class', 'try', 'log', 'setTimeout', 'import', 'export', 'arrow', 'addEventListener');
    has('typescript', 'interface', 'forEach');
    has('python', 'def', 'class', 'ifmain', 'for', 'while', 'try', 'with', 'listcomp', 'fprint', 'dataclass');
    has('php', 'php', 'echo', 'foreach', 'function', 'class', 'if', 'isset', 'post', 'h');
    has('markdown', 'h2', 'link', 'img', 'code', 'table', 'task');
  });

  it('labels are unique per language and templates have fields', () => {
    for (const lang of LANGS) {
      const labels = snippetLabels(lang);
      expect(new Set(labels).size, lang).toBe(labels.length);
    }
    for (const list of Object.values(SNIPPETS)) {
      for (const s of list) if (/^(html5|form|fetch|forEach|def|dataclass|foreach|post|table|@media)$/.test(s.label)) expect(s.template, s.label).toMatch(/\$\{/);
    }
  });

  it('templates insert no Russian text into code', () => {
    for (const list of Object.values(SNIPPETS)) for (const s of list) expect(s.template, s.label).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('every description has an English text', () => {
    const en = englishTexts();
    const missing = Object.values(SNIPPETS)
      .flat()
      .map((s) => s.detail)
      .filter((d) => !Object.prototype.hasOwnProperty.call(en, d));
    expect(missing).toEqual([]);
    setLang('en');
    expect(snippetCompletions('html').find((c) => c.label === 'html5')?.detail).toBe('page boilerplate');
    setLang('ru');
  });

  it('builds completions with snippet fields', () => {
    const c = snippetCompletions('javascript').find((x) => x.label === 'fetch')!;
    expect(c.type).toBe('snippet');
    expect(typeof c.apply).toBe('function');
  });

  it('picks the snippet set of the embedded language', () => {
    const doc = '<style>a{}</style>\n<script>let x</script>\n<p>hi</p>';
    const state = EditorState.create({ doc, extensions: [languageFor('index.html')] });
    expect(snippetLangAt(state, doc.indexOf('a{') + 1, 'index.html')).toBe('css');
    expect(snippetLangAt(state, doc.indexOf('let') + 2, 'index.html')).toBe('javascript');
    expect(snippetLangAt(state, doc.indexOf('hi') + 1, 'index.html')).toBe('html');
    const php = '<p>x</p><?php echo 1; ?>';
    const ps = EditorState.create({ doc: php, extensions: [languageFor('a.php')] });
    expect(snippetLangAt(ps, php.indexOf('echo') + 2, 'a.php')).toBe('php');
    const ts = EditorState.create({ doc: 'let a', extensions: [languageFor('a.ts')] });
    expect(snippetLangAt(ts, 3, 'a.ts')).toBe('typescript');
  });
});

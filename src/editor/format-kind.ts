/** Which formatter handles a file (tiny module, safe to import from the main bundle). */
export type ParserName = 'babel' | 'typescript' | 'json' | 'json5' | 'jsonc' | 'json-stringify' | 'html' | 'css' | 'scss' | 'less' | 'markdown' | 'yaml' | 'php' | 'vue';

const ext = (path: string) => {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};
const base = (path: string) => path.split('/').pop() ?? '';

/** Prettier parser for a file, `'python'` for the built-in Python formatter, null when unsupported. */
export function formatterFor(path: string): ParserName | 'python' | null {
  const name = base(path);
  if (name === 'package.json' || name === 'package-lock.json' || name === 'composer.json') return 'json-stringify';
  if (/^(tsconfig|jsconfig)(\..*)?\.json$/i.test(name) || /^\.(eslintrc|babelrc|swcrc)(\.json)?$/i.test(name) || /(^|\/)\.vscode\//.test(path)) return 'jsonc';
  if (name === '.prettierrc') return 'json';
  switch (ext(path)) {
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'babel';
    case 'ts':
    case 'mts':
    case 'cts':
    case 'tsx':
      return 'typescript';
    case 'json':
    case 'webmanifest':
    case 'map':
      return 'json';
    case 'jsonc':
      return 'jsonc';
    case 'json5':
      return 'json5';
    case 'html':
    case 'htm':
      return 'html';
    case 'vue':
      return 'vue';
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'less':
      return 'less';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'php':
    case 'phtml':
      return 'php';
    case 'py':
      return 'python';
    default:
      return null;
  }
}

export const canFormat = (path: string): boolean => formatterFor(path) !== null;


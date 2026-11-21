import { extOf, isExternalRef, resolveRelative } from './paths';
import type { Files, Language } from './types';

export type Severity = 'error' | 'warning' | 'info';
export interface Issue {
  severity: Severity;
  title: string;
  path: string;
  details: string;
  line?: number;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

const REF_PATTERNS: Record<string, RegExp[]> = {
  html: [/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi],
  css: [/url\(\s*["']?([^"')]+?)["']?\s*\)/gi, /@import\s+["']([^"']+)["']/gi],
  js: [/\bimport\s+(?:[^'"]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/g],
};

export function scanProject(files: Files, language: Language, entry?: string): Issue[] {
  const issues: Issue[] = [];
  const paths = Object.keys(files);
  if (!paths.length) {
    issues.push({ severity: 'warning', title: 'Проект пуст', path: '', details: 'Создайте или импортируйте файлы.' });
    return issues;
  }
  if (language === 'web' && !paths.some((p) => /\.html?$/i.test(p))) {
    issues.push({ severity: 'warning', title: 'Нет HTML-страницы', path: '', details: 'Для предпросмотра нужен файл .html.' });
  }
  if (language === 'python' && !paths.some((p) => p.endsWith('.py'))) {
    issues.push({ severity: 'warning', title: 'Нет файла .py', path: '', details: 'Добавьте main.py для запуска.' });
  }
  if (language === 'php' && !paths.some((p) => p.endsWith('.php'))) {
    issues.push({ severity: 'warning', title: 'Нет файла .php', path: '', details: 'Добавьте index.php для запуска.' });
  }
  if (entry && !files[entry]) {
    issues.push({ severity: 'warning', title: 'Файл запуска не найден', path: entry, details: 'Выберите другой файл для запуска.' });
  }

  for (const path of paths) {
    const f = files[path]!;
    if (!f.text) continue;
    const ext = extOf(path);
    const text = f.content;
    if (ext === 'json' || ext === 'webmanifest') {
      try {
        JSON.parse(text);
      } catch (e) {
        const m = /position (\d+)/.exec(String(e));
        issues.push({
          severity: 'error',
          title: 'Некорректный JSON',
          path,
          details: (e as Error).message,
          line: m ? lineOf(text, Number(m[1])) : undefined,
        });
      }
    }
    const kind = ['html', 'htm'].includes(ext) ? 'html' : ext === 'css' ? 'css' : ['js', 'mjs'].includes(ext) ? 'js' : null;
    if (!kind) continue;
    for (const re of REF_PATTERNS[kind]!) {
      re.lastIndex = 0;
      for (let m; (m = re.exec(text)); ) {
        const ref = (m[1] ?? '').trim();
        if (!ref || isExternalRef(ref) || ref.includes('${') || ref.includes('{{') || ref.startsWith('<?')) continue;
        const resolved = resolveRelative(path, ref);
        if (resolved === null) {
          issues.push({ severity: 'error', title: 'Ссылка выходит за пределы проекта', path, details: ref, line: lineOf(text, m.index) });
        } else if (!files[resolved] && !files[`${resolved}/index.html`]) {
          issues.push({ severity: 'error', title: 'Не найден локальный файл', path, details: `${ref} → ${resolved}`, line: lineOf(text, m.index) });
        }
      }
    }
    if (kind === 'html' && !/<meta[^>]+name=["']viewport["']/i.test(text) && /<html/i.test(text)) {
      issues.push({ severity: 'info', title: 'Нет meta viewport', path, details: 'Страница может выглядеть мелко на телефоне.' });
    }
  }
  return issues;
}

export function reportText(name: string, files: Files, issues: Issue[]): string {
  return [
    `Codevia Pocket · отчёт о проекте «${name}»`,
    `Дата: ${new Date().toLocaleString('ru-RU')}`,
    `Файлов: ${Object.keys(files).length}`,
    `Замечаний: ${issues.length}`,
    '',
    ...issues.map((x, i) => `${i + 1}. [${x.severity}] ${x.title}: ${x.path}${x.line ? `:${x.line}` : ''} ${x.details}`),
  ].join('\n');
}

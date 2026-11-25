import { extOf, isExternalRef, resolveRelative } from './paths';
import type { Files, Language } from './types';
import { locale, t } from '../i18n';

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
    issues.push({ severity: 'warning', title: t('Проект пуст'), path: '', details: t('Создайте или импортируйте файлы.') });
    return issues;
  }
  if (language === 'web' && !paths.some((p) => /\.html?$/i.test(p))) {
    issues.push({ severity: 'warning', title: t('Нет HTML-страницы'), path: '', details: t('Для предпросмотра нужен файл .html.') });
  }
  if (language === 'python' && !paths.some((p) => p.endsWith('.py'))) {
    issues.push({ severity: 'warning', title: t('Нет файла .py'), path: '', details: t('Добавьте main.py для запуска.') });
  }
  if (language === 'php' && !paths.some((p) => p.endsWith('.php'))) {
    issues.push({ severity: 'warning', title: t('Нет файла .php'), path: '', details: t('Добавьте index.php для запуска.') });
  }
  if (entry && !files[entry]) {
    issues.push({ severity: 'warning', title: t('Файл запуска не найден'), path: entry, details: t('Выберите другой файл для запуска.') });
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
          title: t('Некорректный JSON'),
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
          issues.push({ severity: 'error', title: t('Ссылка выходит за пределы проекта'), path, details: ref, line: lineOf(text, m.index) });
        } else if (!files[resolved] && !files[`${resolved}/index.html`]) {
          issues.push({ severity: 'error', title: t('Не найден локальный файл'), path, details: `${ref} → ${resolved}`, line: lineOf(text, m.index) });
        }
      }
    }
    if (kind === 'html' && !/<meta[^>]+name=["']viewport["']/i.test(text) && /<html/i.test(text)) {
      issues.push({ severity: 'info', title: t('Нет meta viewport'), path, details: t('Страница может выглядеть мелко на телефоне.') });
    }
  }
  return issues;
}

export function reportText(name: string, files: Files, issues: Issue[]): string {
  return [
    t('Codevia Pocket · отчёт о проекте «{name}»', { name }),
    t('Дата: {date}', { date: new Date().toLocaleString(locale()) }),
    t('Файлов: {count}', { count: Object.keys(files).length }),
    t('Замечаний: {count}', { count: issues.length }),
    '',
    ...issues.map((x, i) => `${i + 1}. [${x.severity}] ${x.title}: ${x.path}${x.line ? `:${x.line}` : ''} ${x.details}`),
  ].join('\n');
}

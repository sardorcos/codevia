import { snippetCompletion, type Completion } from '@codemirror/autocomplete';
import { t } from '../i18n';

/**
 * Code snippets shown in autocomplete. Templates use CodeMirror's snippet syntax: `${name}` is a field
 * (Tab / the "next field" button moves between them, equal names are edited together), `${}` an empty
 * field and `\t` one indent unit. `detail` is a Russian i18n key (English in i18n/en/editor.ts).
 */
export type SnippetLang = 'html' | 'css' | 'javascript' | 'typescript' | 'python' | 'php' | 'markdown';

export interface SnippetDef {
  label: string;
  detail: string;
  template: string;
}

const html: SnippetDef[] = [
  {
    label: 'html5',
    detail: 'шаблон страницы',
    template:
      '<!DOCTYPE html>\n<html lang="${en}">\n<head>\n\t<meta charset="UTF-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0">\n\t<title>${Document}</title>\n\t<link rel="stylesheet" href="${style.css}">\n</head>\n<body>\n\t${}\n\t<script src="${script.js}"></script>\n</body>\n</html>',
  },
  { label: 'link:css', detail: 'подключить CSS', template: '<link rel="stylesheet" href="${style.css}">' },
  { label: 'script:src', detail: 'подключить JS', template: '<script src="${script.js}"></script>' },
  { label: 'script', detail: 'встроенный скрипт', template: '<script>\n\t${}\n</script>' },
  { label: 'meta:vp', detail: 'meta viewport', template: '<meta name="viewport" content="width=device-width, initial-scale=1.0">' },
  {
    label: 'form',
    detail: 'форма',
    template:
      '<form action="${}" method="${post}">\n\t<label for="${name}">${Name}</label>\n\t<input type="text" id="${name}" name="${name}" required>\n\t<button type="submit">${Send}</button>\n</form>',
  },
  {
    label: 'table',
    detail: 'таблица',
    template:
      '<table>\n\t<thead>\n\t\t<tr>\n\t\t\t<th>${Title}</th>\n\t\t</tr>\n\t</thead>\n\t<tbody>\n\t\t<tr>\n\t\t\t<td>${}</td>\n\t\t</tr>\n\t</tbody>\n</table>',
  },
  { label: 'img', detail: 'изображение', template: '<img src="${}" alt="${}">' },
  { label: 'a', detail: 'ссылка', template: '<a href="${#}">${text}</a>' },
  { label: 'button', detail: 'кнопка', template: '<button type="${button}">${Button}</button>' },
  {
    label: 'nav',
    detail: 'навигация',
    template: '<nav>\n\t<ul>\n\t\t<li><a href="${#}">${Home}</a></li>\n\t\t<li><a href="${#about}">${About}</a></li>\n\t</ul>\n</nav>',
  },
  { label: 'section', detail: 'раздел', template: '<section class="${section}">\n\t<h2>${Title}</h2>\n\t${}\n</section>' },
];

const css: SnippetDef[] = [
  { label: 'flex-center', detail: 'центрирование flex', template: 'display: flex;\njustify-content: center;\nalign-items: center;' },
  { label: 'grid', detail: 'сетка grid', template: 'display: grid;\ngrid-template-columns: repeat(${3}, 1fr);\ngap: ${16px};' },
  { label: '@media', detail: 'медиазапрос', template: '@media (max-width: ${600px}) {\n\t${}\n}' },
  {
    label: '@keyframes',
    detail: 'анимация',
    template: '@keyframes ${name} {\n\tfrom {\n\t\t${opacity: 0;}\n\t}\n\tto {\n\t\t${opacity: 1;}\n\t}\n}',
  },
  { label: ':root', detail: 'CSS-переменные', template: ':root {\n\t--${primary}: ${#40c8f6};\n\t--${bg}: ${#0c1016};\n}' },
  { label: 'var', detail: 'использовать переменную', template: 'var(--${name})' },
];

const javascript: SnippetDef[] = [
  { label: 'for', detail: 'цикл со счётчиком', template: 'for (let ${i} = 0; ${i} < ${array}.length; ${i}++) {\n\t${}\n}' },
  { label: 'forof', detail: 'цикл for…of', template: 'for (const ${item} of ${items}) {\n\t${}\n}' },
  { label: 'forEach', detail: 'перебор массива', template: '${array}.forEach((${item}) => {\n\t${}\n});' },
  { label: 'map', detail: 'преобразовать массив', template: '${array}.map((${item}) => ${item})' },
  {
    label: 'fetch',
    detail: 'запрос с await',
    template:
      'const ${response} = await fetch(${url});\nif (!${response}.ok) throw new Error(`HTTP $\\{${response}.status\\}`);\nconst ${data} = await ${response}.json();',
  },
  { label: 'async', detail: 'асинхронная функция', template: 'async function ${name}(${params}) {\n\t${}\n}' },
  { label: 'function', detail: 'функция', template: 'function ${name}(${params}) {\n\t${}\n}' },
  { label: 'arrow', detail: 'стрелочная функция', template: 'const ${name} = (${params}) => {\n\t${}\n};' },
  { label: 'class', detail: 'класс', template: 'class ${Name} {\n\tconstructor(${params}) {\n\t\t${}\n\t}\n}' },
  { label: 'try', detail: 'try / catch', template: 'try {\n\t${}\n} catch (${error}) {\n\tconsole.error(${error});\n}' },
  { label: 'log', detail: 'console.log', template: 'console.log(${});' },
  { label: 'setTimeout', detail: 'отложенный вызов', template: 'setTimeout(() => {\n\t${}\n}, ${1000});' },
  { label: 'import', detail: 'импорт', template: "import { ${names} } from '${./module.js}';" },
  { label: 'export', detail: 'экспорт функции', template: 'export function ${name}(${params}) {\n\t${}\n}' },
  {
    label: 'addEventListener',
    detail: 'обработчик события',
    template: "${element}.addEventListener('${click}', (${event}) => {\n\t${}\n});",
  },
  { label: 'if', detail: 'условие', template: 'if (${condition}) {\n\t${}\n}' },
  { label: 'ifelse', detail: 'условие с else', template: 'if (${condition}) {\n\t${}\n} else {\n\t${}\n}' },
  { label: 'while', detail: 'цикл while', template: 'while (${condition}) {\n\t${}\n}' },
];

const typescript: SnippetDef[] = [
  { label: 'interface', detail: 'интерфейс', template: 'interface ${Name} {\n\t${key}: ${string};\n}' },
  { label: 'type', detail: 'тип', template: 'type ${Name} = ${};' },
  { label: 'enum', detail: 'перечисление', template: 'enum ${Name} {\n\t${A},\n}' },
];

const python: SnippetDef[] = [
  { label: 'def', detail: 'функция', template: 'def ${name}(${params}):\n\t${pass}' },
  { label: 'class', detail: 'класс', template: 'class ${Name}:\n\tdef __init__(self, ${params}):\n\t\t${pass}' },
  { label: 'ifmain', detail: 'if __name__ == "__main__"', template: 'if __name__ == "__main__":\n\t${main()}' },
  { label: 'for', detail: 'цикл for', template: 'for ${item} in ${items}:\n\t${pass}' },
  { label: 'while', detail: 'цикл while', template: 'while ${condition}:\n\t${pass}' },
  { label: 'try', detail: 'try / except', template: 'try:\n\t${pass}\nexcept ${Exception} as ${e}:\n\tprint(${e})' },
  { label: 'with', detail: 'открыть файл', template: 'with open("${file.txt}", encoding="utf-8") as ${f}:\n\t${data} = ${f}.read()' },
  { label: 'listcomp', detail: 'генератор списка', template: '[${x} for ${x} in ${items}]' },
  { label: 'fprint', detail: 'print с f-строкой', template: 'print(f"${name} = {${name}}")' },
  {
    label: 'dataclass',
    detail: 'класс данных',
    template: 'from dataclasses import dataclass\n\n\n@dataclass\nclass ${Name}:\n\t${field}: ${str}',
  },
  { label: 'if', detail: 'условие', template: 'if ${condition}:\n\t${pass}' },
  { label: 'import', detail: 'импорт', template: 'import ${module}' },
  { label: 'from', detail: 'импорт имён', template: 'from ${module} import ${name}' },
];

const php: SnippetDef[] = [
  { label: 'php', detail: 'тег PHP', template: '<?php\n${}\n?>' },
  { label: 'echo', detail: 'вывод', template: 'echo ${$value};' },
  { label: 'foreach', detail: 'цикл foreach', template: 'foreach (${$items} as ${$item}) {\n\t${}\n}' },
  { label: 'function', detail: 'функция', template: 'function ${name}(${$param}) {\n\t${}\n}' },
  {
    label: 'class',
    detail: 'класс',
    template: 'class ${Name}\n{\n\tpublic function __construct(${$param})\n\t{\n\t\t${}\n\t}\n}',
  },
  { label: 'if', detail: 'условие', template: 'if (${$condition}) {\n\t${}\n}' },
  { label: 'isset', detail: 'параметр из $_GET', template: "${$name} = isset($_GET['${name}']) ? $_GET['${name}'] : '${}';" },
  {
    label: 'post',
    detail: 'обработка формы',
    template:
      "if ($_SERVER['REQUEST_METHOD'] === 'POST') {\n\t${$name} = trim($_POST['${name}'] ?? '');\n\tif (${$name} === '') {\n\t\t$error = '${This field is required}';\n\t} else {\n\t\t${}\n\t}\n}",
  },
  { label: 'h', detail: 'экранировать HTML', template: "htmlspecialchars(${$value}, ENT_QUOTES, 'UTF-8')" },
];

const markdown: SnippetDef[] = [
  { label: 'h2', detail: 'заголовок', template: '## ${Title}' },
  { label: 'link', detail: 'ссылка', template: '[${text}](${https://})' },
  { label: 'img', detail: 'изображение', template: '![${alt text}](${image.png})' },
  { label: 'code', detail: 'блок кода', template: '```${js}\n${}\n```' },
  { label: 'table', detail: 'таблица', template: '| ${Column} | ${Column 2} |\n| --- | --- |\n| ${} | ${} |' },
  { label: 'task', detail: 'список задач', template: '- [ ] ${Task}\n- [x] ${Done}' },
];

export const SNIPPETS: Readonly<Record<Exclude<SnippetLang, 'typescript'>, readonly SnippetDef[]>> & { typescript: readonly SnippetDef[] } = {
  html,
  css,
  javascript,
  typescript,
  python,
  php,
  markdown,
};

/** Snippets of one language. TypeScript gets the JavaScript snippets plus its own. */
export function snippetsFor(lang: SnippetLang): SnippetDef[] {
  return lang === 'typescript' ? [...javascript, ...typescript] : [...SNIPPETS[lang]];
}

export const snippetLabels = (lang: SnippetLang): string[] => snippetsFor(lang).map((s) => s.label);

/** Autocomplete entries (with fields) for a language, details in the interface language. */
export function snippetCompletions(lang: SnippetLang): Completion[] {
  return snippetsFor(lang).map((s) => snippetCompletion(s.template, { label: s.label, detail: t(s.detail), type: 'snippet', boost: -1 }));
}

import { t } from '../../i18n';
import { esc, icon } from '../../ui/dom';
import type { Tool, ToolContext } from '../types';
import { checkFiles, checkOutput, COURSES, courseById, type CheckResult, type Course, type Lesson } from './lessons';
import './learn.css';

/** Progress is a per-device convenience (localStorage); losing it only clears the checkmarks. */
interface Progress {
  done: string[];
  /** Project created for each course. */
  projects: Record<string, string>;
  /** Last opened lesson per course. */
  last: Record<string, string>;
}
const KEY = 'codevia.learn';

function load(): Progress {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Progress>;
    return { done: v.done ?? [], projects: v.projects ?? {}, last: v.last ?? {} };
  } catch {
    return { done: [], projects: {}, last: {} };
  }
}
function save(p: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: progress is not kept */
  }
}

/** Lesson texts are Russian keys; code-only hints are shown as they are. */
const tx = (s: string) => (/[А-Яа-яЁё]/.test(s) ? t(s) : s);

function mount(root: HTMLElement, ctx: ToolContext): () => void {
  let progress = load();
  let disposed = false;
  root.classList.add('learn-root');

  const courseOfProject = (): Course | undefined => {
    const p = ctx.project();
    return p ? COURSES.find((c) => progress.projects[c.id] === p.id) : undefined;
  };

  function showCourses(): void {
    const active = courseOfProject();
    root.innerHTML = `<div class="learn-pad">
      <p class="subtxt">${esc(t('Короткие уроки с заданием и автоматической проверкой. Пишите код в редакторе, затем нажмите «Проверить».'))}</p>
      <div class="list" role="list">${COURSES.map((c) => {
        const done = c.lessons.filter((l) => progress.done.includes(l.id)).length;
        return `<button class="row-button" role="listitem" data-course="${c.id}">${icon(c.icon)}
          <span class="row-main"><span class="row-title">${esc(t(c.title))}${active?.id === c.id ? ` <span class="pill cyan">${esc(t('открыт'))}</span>` : ''}</span>
          <span class="row-description">${esc(t(c.description))} · ${esc(t('{done} из {total}', { done, total: c.lessons.length }))}</span></span>
          <span class="learn-meter" style="--p:${Math.round((done / c.lessons.length) * 100)}%"></span>${icon('chevron', 'sm')}</button>`;
      }).join('')}</div></div>`;
    root.querySelectorAll<HTMLElement>('[data-course]').forEach((b) => b.addEventListener('click', () => showCourse(courseById(b.dataset.course!)!)));
  }

  function showCourse(course: Course): void {
    root.innerHTML = `<div class="learn-pad">
      <button class="btn ghost tiny" data-back>${icon('back', 'sm')} ${esc(t('Все курсы'))}</button>
      <h2 class="learn-h">${esc(t(course.title))}</h2>
      <ol class="list learn-lessons">${course.lessons
        .map((l, i) => {
          const done = progress.done.includes(l.id);
          return `<li class="row"><button class="row-button" data-lesson="${l.id}">${done ? icon('check') : `<span class="learn-num">${i + 1}</span>`}
            <span class="row-main"><span class="row-title">${esc(t(l.title))}</span></span>${icon('chevron', 'sm')}</button></li>`;
        })
        .join('')}</ol></div>`;
    root.querySelector('[data-back]')!.addEventListener('click', showCourses);
    root.querySelectorAll<HTMLElement>('[data-lesson]').forEach((b) =>
      b.addEventListener('click', () => showLesson(course, course.lessons.find((l) => l.id === b.dataset.lesson)!)),
    );
  }

  function showLesson(course: Course, lesson: Lesson, result?: CheckResult, stderr = ''): void {
    progress.last[course.id] = lesson.id;
    save(progress);
    const index = course.lessons.indexOf(lesson);
    const next = course.lessons[index + 1];
    const inCourseProject = courseOfProject()?.id === course.id;
    const done = progress.done.includes(lesson.id);
    root.innerHTML = `<div class="learn-pad">
      <button class="btn ghost tiny" data-back>${icon('back', 'sm')} ${esc(t(course.title))}</button>
      <p class="learn-step">${esc(t('Урок {n} из {total}', { n: index + 1, total: course.lessons.length }))}${done ? ` · ${icon('check', 'xs')} ${esc(t('пройден'))}` : ''}</p>
      <h2 class="learn-h">${esc(t(lesson.title))}</h2>
      <p>${esc(t(lesson.explain))}</p>
      <div class="learn-task"><strong>${esc(t('Задание'))}</strong><p>${esc(t(lesson.task))}</p></div>
      <details class="learn-hint"><summary>${esc(t('Подсказка'))}</summary><pre class="mono">${esc(tx(lesson.hint))}</pre></details>
      ${
        result
          ? result.ok
            ? `<div class="learn-result ok" role="status">${icon('check')} ${esc(t('Верно! Урок пройден.'))}</div>`
            : `<div class="learn-result bad" role="status"><strong>${esc(t('Пока не получилось'))}</strong><ul>${result.problems
                .map((p) => `<li>${lesson.check.kind === 'output' ? esc(t('В выводе нет: {text}', { text: p.replace(/\n/g, ' ⏎ ') })) : esc(t(p))}</li>`)
                .join('')}</ul>${stderr ? `<pre class="mono learn-err">${esc(stderr.slice(-600))}</pre>` : ''}</div>`
          : ''
      }
      <div class="learn-actions">
        ${
          inCourseProject
            ? `<button class="btn primary" data-check>${icon('play', 'sm')} ${esc(t('Проверить'))}</button>
               <button class="btn secondary" data-starter>${esc(t('Открыть заготовку урока'))}</button>`
            : `<button class="btn primary" data-start>${icon('plus', 'sm')} ${esc(t('Начать курс в новом проекте'))}</button>`
        }
        ${result?.ok && next ? `<button class="btn primary" data-next>${esc(t('Следующий урок'))} ${icon('chevron', 'sm')}</button>` : ''}
        ${result?.ok && !next ? `<p class="learn-final">${esc(t('Курс завершён! 🎉'))}</p>` : ''}
      </div></div>`;
    root.querySelector('[data-back]')!.addEventListener('click', () => showCourse(course));
    root.querySelector('[data-start]')?.addEventListener('click', () => void startCourse(course, lesson));
    root.querySelector('[data-starter]')?.addEventListener('click', () => void writeStarter(lesson, true));
    root.querySelector('[data-check]')?.addEventListener('click', () => void check(course, lesson));
    root.querySelector('[data-next]')?.addEventListener('click', () => void goNext(course, next!));
  }

  async function startCourse(course: Course, lesson: Lesson): Promise<void> {
    progress.last[course.id] = lesson.id;
    save(progress);
    // Creating the project opens it and closes this panel; the id is recorded right after.
    await ctx.createProject(t(course.title), course.language, { ...lesson.starter });
    const p = ctx.project();
    if (p) {
      progress = load();
      progress.projects[course.id] = p.id;
      save(progress);
    }
    ctx.toast(t('Курс открыт. Пишите код и откройте «Инструменты → Уроки», чтобы проверить.'), 'success');
  }

  async function writeStarter(lesson: Lesson, open: boolean): Promise<void> {
    await ctx.writeFiles({ ...lesson.starter }, { snapshotLabel: t('Перед уроком «{name}»', { name: t(lesson.title) }) });
    if (open) ctx.openFile(Object.keys(lesson.starter)[0]!);
  }

  async function goNext(course: Course, next: Lesson): Promise<void> {
    await writeStarter(next, false);
    if (!disposed) showLesson(course, next);
  }

  async function check(course: Course, lesson: Lesson): Promise<void> {
    const btn = root.querySelector<HTMLButtonElement>('[data-check]');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${esc(t('Проверяю…'))}`;
    }
    let result: CheckResult;
    let stderr = '';
    try {
      if (lesson.check.kind === 'files') result = checkFiles(lesson.check, ctx.project()?.files ?? {});
      else {
        const run = await ctx.runProject({ stdin: lesson.check.stdin, timeoutMs: 30_000 });
        stderr = run.stderr;
        result = checkOutput(lesson.check, run.stdout);
      }
    } catch (e) {
      result = { ok: false, problems: [] };
      stderr = String((e as Error)?.message ?? e);
    }
    if (disposed) return;
    if (result.ok && !progress.done.includes(lesson.id)) {
      progress.done.push(lesson.id);
      save(progress);
    }
    ctx.haptic(result.ok ? 'success' : 'warning');
    showLesson(course, lesson, result, stderr);
  }

  // Open the lesson of the course this project belongs to, otherwise the course list.
  const active = courseOfProject();
  if (active) {
    const last = active.lessons.find((l) => l.id === progress.last[active.id]) ?? active.lessons.find((l) => !progress.done.includes(l.id)) ?? active.lessons[0]!;
    showLesson(active, last);
  } else showCourses();

  return () => {
    disposed = true;
  };
}

export const learnTool: Tool = {
  id: 'learn',
  group: 'Учёба',
  description: 'Короткие уроки с автоматической проверкой',
  title: 'Уроки',
  icon: 'flag',
  mount,
};


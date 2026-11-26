import { describe, expect, it } from 'vitest';
import type { Files } from '../../src/core/types';
import { compileModule } from '../../src/runtime/js-core';
import { checkFiles, checkOutput, COURSES } from '../../src/tools/learn/lessons';

/** Runs a single-file JS lesson with console.log and prompt() captured (enough for the lesson programs). */
function runJs(files: Files, stdin = ''): string {
  const [path, f] = Object.entries(files).find(([p]) => p.endsWith('.js'))!;
  let out = '';
  const lines = stdin.split('\n');
  const consoleObj = { log: (...a: unknown[]) => (out += a.map(String).join(' ') + '\n') };
  const prompt = (q?: string) => {
    out += (q ?? '') + (lines[0] ?? '') + '\n';
    return lines.shift() ?? null;
  };
  new Function('console', 'prompt', 'require', 'module', 'exports', compileModule(path, f.text ? f.content : ''))(consoleObj, prompt, () => ({}), { exports: {} }, {});
  return out;
}

describe('mini-courses', () => {
  it('have unique ids and five lessons per course', () => {
    const ids = COURSES.flatMap((c) => c.lessons.map((l) => l.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of COURSES) expect(c.lessons.length).toBe(5);
  });

  for (const course of COURSES) {
    for (const lesson of course.lessons) {
      it(`${lesson.id}: the check fails on the starter and passes on the solution`, () => {
        const check = lesson.check;
        if (check.kind === 'files') {
          expect(checkFiles(check, lesson.starter).ok).toBe(false);
          expect(checkFiles(check, lesson.solution).problems).toEqual([]);
        } else if (course.language === 'javascript') {
          expect(checkOutput(check, runJs(lesson.starter, check.stdin)).ok).toBe(false);
          expect(checkOutput(check, runJs(lesson.solution, check.stdin)).problems).toEqual([]);
        } else {
          // Python runs in Pyodide (E2E); here the starter must at least not already contain the answer.
          const starter = Object.values(lesson.starter).map((f) => (f.text ? f.content : '')).join('');
          for (const c of check.contains) expect(starter.includes(`print(${JSON.stringify(c)})`)).toBe(false);
        }
      });
    }
  }

  it('ignores answers hidden in HTML comments', () => {
    const lesson = COURSES[0]!.lessons[0]!;
    if (lesson.check.kind !== 'files') throw new Error('expected a files check');
    const files = { ...lesson.starter, 'index.html': { text: true as const, content: '<!-- <h1>x</h1><p>y</p> -->' } };
    expect(checkFiles(lesson.check, files).ok).toBe(false);
  });
});

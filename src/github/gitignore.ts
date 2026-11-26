/**
 * A small `.gitignore` matcher: comments, blank lines, `!` negation, `/` anchoring, trailing `/`
 * for directories, `*`, `?`, `[...]` and `**`. As in git, a file inside an ignored directory
 * cannot be re-included by a negation.
 */

interface Rule {
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function globToRegex(glob: string, anchored: boolean): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        const atEnd = i + 2 === glob.length || glob[i + 2] === '/';
        if (atStart && atEnd) {
          if (i + 2 === glob.length) {
            re += '.*'; // trailing `**`: everything inside
            i += 1;
          } else {
            re += '(?:.*/)?'; // `**/`: zero or more directories
            i += 2;
          }
          continue;
        }
        i += 1; // `**` inside a name behaves like `*`
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) {
        re += '\\[';
        continue;
      }
      let cls = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
      if (cls[0] === '!') cls = '^' + cls.slice(1);
      re += `[${cls}]`;
      i = end;
    } else if (c === '\\' && i + 1 < glob.length) {
      re += escapeRe(glob[++i]!);
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(anchored ? `^${re}$` : `^(?:.*/)?${re}$`);
}

function parseLine(raw: string): Rule | null {
  let line = raw.replace(/\r$/, '');
  // Trailing spaces are ignored unless escaped with a backslash.
  line = line.replace(/(?<!\\)\s+$/, '').replace(/\\ $/, ' ');
  if (!line || line.startsWith('#')) return null;
  let negate = false;
  if (line.startsWith('!')) {
    negate = true;
    line = line.slice(1);
  } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
    line = line.slice(1);
  }
  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.replace(/\/+$/, '');
  }
  if (!line) return null;
  const anchored = line.includes('/');
  line = line.replace(/^\/+/, '');
  if (!line) return null;
  return { regex: globToRegex(line, anchored), negate, dirOnly };
}

export interface GitignoreMatcher {
  /** True when `path` (project-relative, `/`-separated) is ignored. */
  ignores(path: string): boolean;
}

/** Builds a matcher for the contents of a root `.gitignore`. */
export function createGitignore(text: string): GitignoreMatcher {
  const rules = text.split('\n').map(parseLine).filter((r): r is Rule => r !== null);

  const verdict = (path: string, isDir: boolean): boolean => {
    let ignored = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.negate === ignored && r.regex.test(path)) ignored = !r.negate;
    }
    return ignored;
  };

  return {
    ignores(path: string): boolean {
      if (!rules.length) return false;
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (verdict(parts.slice(0, i).join('/'), true)) return true;
      }
      return verdict(path, false);
    },
  };
}

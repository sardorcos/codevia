import { describe, expect, it } from 'vitest';
import { isExternalRef, isJunkPath, normalizePath, resolveRelative, safeFolderName, uniquePath } from '../../src/core/paths';

describe('normalizePath', () => {
  it('accepts nested relative paths and strips ./', () => {
    expect(normalizePath('./src/app.js')).toBe('src/app.js');
    expect(normalizePath('a\\b.txt')).toBe('a/b.txt');
  });
  it.each(['../x', 'a/../b', '/etc/passwd', 'C:/x', 'a//b', '', 'a/./b', 'bad\u0000name', 'x'.repeat(401)])('rejects %j', (p) => {
    expect(() => normalizePath(p)).toThrow();
  });
});

describe('resolveRelative', () => {
  it('resolves ./, ../ and root-relative references', () => {
    expect(resolveRelative('pages/about.html', '../css/a.css')).toBe('css/a.css');
    expect(resolveRelative('pages/about.html', './b.png')).toBe('pages/b.png');
    expect(resolveRelative('pages/about.html', '/img/c.png')).toBe('img/c.png');
    expect(resolveRelative('index.html', 'a.css?v=2#x')).toBe('a.css');
    expect(resolveRelative('index.html', 'my%20file.css')).toBe('my file.css');
  });
  it('returns null when escaping the project', () => {
    expect(resolveRelative('index.html', '../secret')).toBeNull();
  });
});

describe('helpers', () => {
  it('detects external references', () => {
    for (const r of ['https://x', '//cdn', 'data:image/png;base64,', 'mailto:a', '#top', 'javascript:void(0)']) expect(isExternalRef(r)).toBe(true);
    expect(isExternalRef('img/a.png')).toBe(false);
  });
  it('detects archive junk', () => {
    expect(isJunkPath('__MACOSX/._a')).toBe(true);
    expect(isJunkPath('x/.DS_Store')).toBe(true);
    expect(isJunkPath('src/._index.html')).toBe(true);
    expect(isJunkPath('src/index.html')).toBe(false);
  });
  it('makes unique, case-insensitive names', () => {
    expect(uniquePath('Logo.png', ['logo.png'])).toBe('Logo (2).png');
    expect(uniquePath('a/b', ['a/b', 'a/b (2)'])).toBe('a/b (3)');
  });
  it('makes Files-safe folder names', () => {
    expect(safeFolderName('My: site/2', [])).toBe('My site 2');
    expect(safeFolderName('...', [])).toBe('Проект');
    expect(safeFolderName('Сайт', ['Сайт'])).toBe('Сайт (2)');
  });
});

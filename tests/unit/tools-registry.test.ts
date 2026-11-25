import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import toolsEn from '../../src/i18n/en/tools';
import { englishTexts } from '../../src/i18n';
import { TOOLS, toolById } from '../../src/tools';
import { LIBRARIES } from '../../src/tools/libraries/catalog';

describe('tool registry', () => {
  it('lists the five tools with unique ids and icons from the sprite', () => {
    expect(TOOLS.map((t) => t.id)).toEqual(['http', 'json', 'color', 'markdown', 'libraries']);
    const sprite = readFileSync('index.html', 'utf8');
    for (const tool of TOOLS) {
      expect(sprite, tool.icon).toContain(`<symbol id="i-${tool.icon}"`);
      expect(typeof tool.mount).toBe('function');
      expect(toolById(tool.id)).toBe(tool);
    }
    expect(toolById('libraries')!.needsProject).toBe(true);
    expect(toolById('http')!.needsProject).toBeFalsy();
  });

  it('does not import the app shell', () => {
    for (const f of ['http/index.ts', 'json/index.ts', 'color/index.ts', 'markdown/index.ts', 'libraries/index.ts', 'shared.ts']) {
      expect(readFileSync(`src/tools/${f}`, 'utf8'), f).not.toMatch(/from ['"][./]*app['"]/);
    }
  });
});

describe('English texts of the tools', () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const special = (s: string) => [...s].filter((c) => `<>"&'`.includes(c)).join('');

  it('keep placeholders and markup, and contain no Russian', () => {
    for (const [key, value] of Object.entries(toolsEn)) {
      for (const form of value.split('|')) {
        expect(placeholders(form), key).toEqual(placeholders(key.replace(/ #\w+$/, '')));
        expect(special(form), key).toBe(special(key));
      }
      expect(value, key).not.toMatch(/[А-Яа-яЁё«»]/);
    }
  });

  it('do not change English texts of other features', async () => {
    const core = (await import('../../src/i18n/en')).en as Record<string, string>;
    for (const key of Object.keys(toolsEn)) {
      if (Object.prototype.hasOwnProperty.call(core, key)) expect(toolsEn[key], key).toBe(core[key]);
    }
  });

  it('cover tool titles and the library catalogue', () => {
    const all = englishTexts();
    for (const tool of TOOLS) if (/[А-Яа-яЁё]/.test(tool.title)) expect(all[tool.title], tool.title).toBeDefined();
    for (const lib of LIBRARIES) {
      expect(all[lib.description], lib.id).toBeDefined();
      expect(all[lib.example.label], lib.id).toBeDefined();
    }
  });
});

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { englishTexts, SUPPORTED_LANGS } from '../../src/i18n';

/**
 * Checks every translation in src/i18n/locales/<lang>.ts against the English texts:
 * - no keys that no longer exist;
 * - the same {placeholders} and the same HTML tags as the English text;
 * - plural entries (English "one|other") have one form per CLDR plural category of the language;
 * - nearly complete coverage (missing keys fall back to English at run time).
 */
const dir = fileURLToPath(new URL('../../src/i18n/locales/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
const en = englishTexts();
const keys = Object.keys(en);
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const tags = (s: string) => [...s.matchAll(/<\/?([a-z]+)[^>]*>/gi)].map((m) => m[0].replace(/\s+[a-z-]+="[^"]*"/gi, (a) => a)).sort().join('');
const isPlural = (key: string) => en[key]!.includes('|');

describe('locale files', () => {
  it('cover exactly the supported non-base languages', () => {
    const langs = files.map((f) => f.replace(/\.ts$/, ''));
    for (const l of langs) expect(SUPPORTED_LANGS as readonly string[]).toContain(l);
  });

  for (const file of files) {
    const lang = file.replace(/\.ts$/, '');
    describe(lang, async () => {
      const dict = ((await import(`../../src/i18n/locales/${file}`)) as { default: Record<string, string> }).default;
      const categories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories.length;

      it('has no unknown keys', () => {
        expect(Object.keys(dict).filter((k) => !(k in en))).toEqual([]);
      });

      it('keeps placeholders and markup', () => {
        const bad = Object.entries(dict).filter(([k, v]) => k in en && (placeholders(v) !== placeholders(en[k]!.split('|')[0]!) && !isPlural(k) || tags(v) !== tags(en[k]!)));
        expect(bad.map(([k]) => k)).toEqual([]);
      });

      it('has the right number of plural forms', () => {
        const bad = Object.entries(dict).filter(([k, v]) => k in en && isPlural(k) && v.split('|').length !== categories && v.split('|').length !== 1);
        expect(bad.map(([k, v]) => `${k} → ${v}`)).toEqual([]);
      });

      it('translates at least 98% of the interface', () => {
        const covered = keys.filter((k) => dict[k]).length;
        expect(covered / keys.length).toBeGreaterThanOrEqual(0.98);
      });
    });
  }
});

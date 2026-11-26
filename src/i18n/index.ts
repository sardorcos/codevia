import { en as enCore } from './en';

/**
 * Interface language. Russian text is the key (so the Russian UI needs no lookup).
 * - `en.ts` (plus feature files in `./en/*.ts`) maps it to English, the default and the fallback.
 * - `./locales/<lang>.ts` map it to the other languages; they are loaded on start by initI18n().
 */
export const SUPPORTED_LANGS = ['en', 'ru', 'es', 'de', 'fr', 'it', 'pt-BR', 'tr', 'uk', 'uz', 'kk', 'zh-Hans', 'ja', 'ko'] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];
export type Params = Record<string, string | number>;

/** Names shown in the language picker (each in its own language). */
export const LANG_NAMES: Record<Lang, string> = {
  en: 'English',
  ru: 'Русский',
  es: 'Español',
  de: 'Deutsch',
  fr: 'Français',
  it: 'Italiano',
  'pt-BR': 'Português (Brasil)',
  tr: 'Türkçe',
  uk: 'Українська',
  uz: 'Oʻzbekcha',
  kk: 'Қазақша',
  'zh-Hans': '简体中文',
  ja: '日本語',
  ko: '한국어',
};

const STORAGE_KEY = 'codevia.lang';

/** English texts: the core dictionary plus one file per feature (keeps parallel work conflict-free). */
const en: Record<string, string> = { ...enCore };
for (const mod of Object.values(import.meta.glob<{ default: Record<string, string> }>('./en/*.ts', { eager: true }))) {
  Object.assign(en, mod.default);
}
const localeLoaders = import.meta.glob<{ default: Record<string, string> }>('./locales/*.ts');
let dict: Record<string, string> | null = null;

/** Maps a BCP 47 tag to a supported language: exact, then by base language (pt → pt-BR, zh → zh-Hans, be → ru). */
export function matchLang(tag: string): Lang | null {
  const t = tag.trim();
  if (!t) return null;
  const exact = SUPPORTED_LANGS.find((l) => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const base = t.split(/[-_]/)[0]!.toLowerCase();
  if (base === 'be') return 'ru';
  if (base === 'zh') return /hant|tw|hk|mo/i.test(t) ? null : 'zh-Hans';
  return SUPPORTED_LANGS.find((l) => l.split('-')[0]!.toLowerCase() === base) ?? null;
}

const asLang = (v: unknown): Lang | null => (typeof v === 'string' ? (SUPPORTED_LANGS as readonly string[]).includes(v) ? (v as Lang) : null : null);

/** `?lang=…`, then the language chosen in Settings, then the system languages in order. */
export function detectLang(): Lang {
  try {
    const q = asLang(new URLSearchParams(globalThis.location?.search ?? '').get('lang'));
    if (q) return q;
  } catch {
    /* no location */
  }
  try {
    const stored = asLang(globalThis.localStorage?.getItem(STORAGE_KEY));
    if (stored) return stored;
  } catch {
    /* storage blocked */
  }
  try {
    const nav = globalThis.navigator;
    for (const tag of nav?.languages?.length ? nav.languages : [nav?.language ?? '']) {
      const m = matchLang(tag);
      if (m) return m;
    }
  } catch {
    /* no navigator */
  }
  return 'en';
}

let current: Lang | null = null;

export const getLang = (): Lang => (current ??= detectLang());

/** Overrides the language (tests); `null` detects it again. Call initI18n() afterwards for other languages. */
export function setLang(lang: Lang | null): void {
  current = lang;
  dict = null;
}

/** Remembers the language picked in Settings (applied on the next start). `null` follows the system. */
export function setPreferredLang(lang: Lang | null): void {
  try {
    if (lang) globalThis.localStorage?.setItem(STORAGE_KEY, lang);
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* storage blocked */
  }
}

export function preferredLang(): Lang | null {
  try {
    return asLang(globalThis.localStorage?.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Loads the dictionary of the current language (no-op for English and Russian). */
export async function initI18n(): Promise<void> {
  const lang = getLang();
  if (lang === 'en' || lang === 'ru') return;
  const load = localeLoaders[`./locales/${lang}.ts`];
  if (!load) return;
  try {
    dict = (await load()).default;
  } catch {
    dict = null; // English fallback
  }
}

export const locale = (): string => (getLang() === 'ru' ? 'ru-RU' : getLang() === 'en' ? 'en-US' : getLang());

const warned = new Set<string>();

const has = (o: Record<string, string>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function lookup(key: string): string | undefined {
  if (getLang() === 'ru') return key;
  if (dict && has(dict, key)) return dict[key];
  if (has(en, key)) return en[key];
  if (import.meta.env?.DEV && !warned.has(key)) {
    warned.add(key);
    console.warn(`[i18n] missing English text for: ${key}`);
  }
  return undefined;
}

const fill = (s: string, params?: Params): string =>
  params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m)) : s;

/** Translates Russian `key` into the current language. `{name}` placeholders are filled from `params`. */
export function t(key: string, params?: Params): string {
  return fill(lookup(key) ?? key, params);
}

/**
 * Like t(), for a Russian text whose English depends on where it is used. English is looked up under
 * `'<key> #<context>'` (e.g. `tc('redo', 'Повторить')` → `'Повторить #redo': 'Redo'`).
 */
export function tc(context: string, key: string, params?: Params): string {
  return fill(getLang() === 'ru' ? key : (lookup(`${key} #${context}`) ?? key), params);
}

export interface RuForms {
  one: string;
  few: string;
  many: string;
}

function ruForm(n: number, f: RuForms): string {
  const m10 = Math.abs(n) % 10;
  const m100 = Math.abs(n) % 100;
  return m10 === 1 && m100 !== 11 ? f.one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? f.few : f.many;
}

/**
 * Plural forms. Russian picks one/few/many; English looks up the `many` form in `en.ts`, whose value
 * holds `one|other` (e.g. `'{count} файлов': '{count} file|{count} files'`). A plain string means the
 * Russian text does not change with the number. `{count}` is filled with `n`.
 */
export function plural(n: number, forms: RuForms | string, params?: Params): string {
  const ru = typeof forms === 'string' ? { one: forms, few: forms, many: forms } : forms;
  const all = { count: n, ...params };
  const text = getLang() === 'ru' ? undefined : lookup(ru.many);
  if (text === undefined) return fill(ruForm(n, ru), all);
  return fill(pickPluralForm(n, text, dict && has(dict, ru.many) ? locale() : 'en-US'), all);
}

const CATEGORY_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'];

/**
 * Picks a form from `a|b|…`: the forms follow the language's CLDR plural categories in the order
 * zero, one, two, few, many, other (English: one|other; Japanese: other; Ukrainian: one|few|many|other).
 */
export function pickPluralForm(n: number, text: string, loc: string): string {
  const forms = text.split('|');
  if (forms.length === 1) return forms[0]!;
  try {
    const rules = new Intl.PluralRules(loc);
    const cats = rules.resolvedOptions().pluralCategories.slice().sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
    const i = cats.indexOf(rules.select(n));
    return forms[Math.min(i < 0 ? forms.length - 1 : i, forms.length - 1)]!;
  } catch {
    return n === 1 ? forms[0]! : forms[forms.length - 1]!;
  }
}

/** All English texts (core + feature files), for tests and the translation tooling. */
export const englishTexts = (): Readonly<Record<string, string>> => en;

export const fmtNumber = (n: number, opts?: Intl.NumberFormatOptions): string => new Intl.NumberFormat(locale(), opts).format(n);

/** Puts the language on <html> and localizes the static texts of index.html. */
export function applyDocumentLang(doc: Document = document): void {
  doc.documentElement.lang = getLang();
  doc.querySelector('meta[name="description"]')?.setAttribute('content', t('Codevia Pocket — редактор кода для iPhone: сайты, Python и PHP прямо на устройстве.'));
}

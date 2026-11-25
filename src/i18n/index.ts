import { en } from './en';

/**
 * Interface language. Russian text is the key (so the Russian UI needs no lookup) and `en.ts` maps it
 * to English. English is the default; Russian is used when the system language is Russian (or one that
 * Russian-reading users commonly set).
 */
export type Lang = 'en' | 'ru';
export type Params = Record<string, string | number>;

const STORAGE_KEY = 'codevia.lang';
const RU_LIKE = /^(ru|uk|be|kk|uz)\b/i;

const asLang = (v: unknown): Lang | null => (v === 'ru' || v === 'en' ? v : null);

/** `?lang=ru|en`, then `localStorage['codevia.lang']`, then the system language. */
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
    const first = nav?.languages?.[0] ?? nav?.language ?? '';
    if (RU_LIKE.test(first)) return 'ru';
  } catch {
    /* no navigator */
  }
  return 'en';
}

let current: Lang | null = null;

export const getLang = (): Lang => (current ??= detectLang());

/** Overrides the language (tests); `null` detects it again. */
export function setLang(lang: Lang | null): void {
  current = lang;
}

export const locale = (): string => (getLang() === 'ru' ? 'ru-RU' : 'en-US');

const warned = new Set<string>();

function lookup(key: string): string | undefined {
  if (getLang() === 'ru') return key;
  if (Object.prototype.hasOwnProperty.call(en, key)) return en[key];
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
  const english = getLang() === 'en' ? lookup(ru.many) : undefined;
  if (english === undefined) return fill(ruForm(n, ru), all);
  const [one, other = one] = english.split('|') as [string, string?];
  return fill(n === 1 ? one : other, all);
}

export const fmtNumber = (n: number, opts?: Intl.NumberFormatOptions): string => new Intl.NumberFormat(locale(), opts).format(n);

/** Puts the language on <html> and localizes the static texts of index.html. */
export function applyDocumentLang(doc: Document = document): void {
  doc.documentElement.lang = getLang();
  doc.querySelector('meta[name="description"]')?.setAttribute('content', t('Codevia Pocket — редактор кода для iPhone: сайты, Python и PHP прямо на устройстве.'));
}

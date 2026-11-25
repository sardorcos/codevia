/**
 * Pure colour conversions. RGB channels are 0–255 (floats allowed internally), alpha 0–1,
 * hue 0–360, saturation/lightness/value 0–100.
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}
export interface HSLA {
  h: number;
  s: number;
  l: number;
  a: number;
}
export interface HSVA {
  h: number;
  s: number;
  v: number;
  a: number;
}

/** CSS Color Module Level 4 named colours. */
export const NAMED_COLORS: Readonly<Record<string, string>> = {
  aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff', beige: 'f5f5dc',
  bisque: 'ffe4c4', black: '000000', blanchedalmond: 'ffebcd', blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a',
  burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00', chocolate: 'd2691e', coral: 'ff7f50',
  cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c', cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b',
  darkgoldenrod: 'b8860b', darkgray: 'a9a9a9', darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b',
  darkmagenta: '8b008b', darkolivegreen: '556b2f', darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000',
  darksalmon: 'e9967a', darkseagreen: '8fbc8f', darkslateblue: '483d8b', darkslategray: '2f4f4f', darkslategrey: '2f4f4f',
  darkturquoise: '00ced1', darkviolet: '9400d3', deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969',
  dimgrey: '696969', dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22',
  fuchsia: 'ff00ff', gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', gray: '808080',
  green: '008000', greenyellow: 'adff2f', grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c',
  indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5', lawngreen: '7cfc00',
  lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2',
  lightgray: 'd3d3d3', lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a',
  lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899', lightslategrey: '778899',
  lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32', linen: 'faf0e6', magenta: 'ff00ff',
  maroon: '800000', mediumaquamarine: '66cdaa', mediumblue: '0000cd', mediumorchid: 'ba55d3', mediumpurple: '9370db',
  mediumseagreen: '3cb371', mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc',
  mediumvioletred: 'c71585', midnightblue: '191970', mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5',
  navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6', olive: '808000', olivedrab: '6b8e23', orange: 'ffa500',
  orangered: 'ff4500', orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee',
  palevioletred: 'db7093', papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd',
  powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399', red: 'ff0000', rosybrown: 'bc8f8f', royalblue: '4169e1',
  saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460', seagreen: '2e8b57', seashell: 'fff5ee', sienna: 'a0522d',
  silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd', slategray: '708090', slategrey: '708090', snow: 'fffafa',
  springgreen: '00ff7f', steelblue: '4682b4', tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8', tomato: 'ff6347',
  turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff', whitesmoke: 'f5f5f5', yellow: 'ffff00',
  yellowgreen: '9acd32',
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const mod = (v: number, m: number) => ((v % m) + m) % m;

export const clampRgba = (c: RGBA): RGBA => ({ r: clamp(c.r, 0, 255), g: clamp(c.g, 0, 255), b: clamp(c.b, 0, 255), a: clamp(c.a, 0, 1) });

/** Rounds channels to integers and alpha to 3 decimals. */
export const roundRgba = (c: RGBA): RGBA => {
  const x = clampRgba(c);
  return { r: Math.round(x.r), g: Math.round(x.g), b: Math.round(x.b), a: round(x.a, 3) };
};

export function rgbToHsl({ r, g, b, a }: RGBA): HSLA {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100, a };
}

export function hslToRgb({ h, s, l, a }: HSLA): RGBA {
  const S = clamp(s, 0, 100) / 100;
  const L = clamp(l, 0, 100) / 100;
  const H = mod(h, 360);
  const k = (n: number) => mod(n + H / 30, 12);
  const f = (n: number) => L - S * Math.min(L, 1 - L) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a };
}

export function rgbToHsv({ r, g, b, a }: RGBA): HSVA {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  let h = 0;
  if (d) {
    if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
  }
  return { h, s: max ? (d / max) * 100 : 0, v: max * 100, a };
}

export function hsvToRgb({ h, s, v, a }: HSVA): RGBA {
  const S = clamp(s, 0, 100) / 100;
  const V = clamp(v, 0, 100) / 100;
  const H = mod(h, 360);
  const f = (n: number) => {
    const k = mod(n + H / 60, 6);
    return V - V * S * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return { r: f(5) * 255, g: f(3) * 255, b: f(1) * 255, a };
}

const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');

/** `#rrggbb`, or `#rrggbbaa` when alpha < 1 (or `alpha: 'always'`). Lower case. */
export function toHex(c: RGBA, alpha: 'auto' | 'always' | 'never' = 'auto'): string {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  const a = clamp(c.a, 0, 1);
  if (alpha === 'never' || (alpha === 'auto' && Math.round(a * 255) === 255)) return base;
  return base + hex2(a * 255);
}

/** Short form `#abc`/`#abcd` when lossless, otherwise the full hex. */
export function toShortHex(c: RGBA): string {
  const h = toHex(c);
  const digits = h.slice(1);
  if (digits.length % 2 === 0 && [...Array(digits.length / 2).keys()].every((i) => digits[i * 2] === digits[i * 2 + 1]))
    return `#${[...Array(digits.length / 2).keys()].map((i) => digits[i * 2]).join('')}`;
  return h;
}

const fmtA = (a: number) => String(round(clamp(a, 0, 1), 3));

export function toRgbString(c: RGBA): string {
  const x = roundRgba(c);
  return x.a < 1 ? `rgba(${x.r}, ${x.g}, ${x.b}, ${fmtA(x.a)})` : `rgb(${x.r}, ${x.g}, ${x.b})`;
}

export function toHslString(c: RGBA): string {
  const { h, s, l, a } = rgbToHsl(c);
  const body = `${round(mod(h, 360), 1)}, ${round(s, 1)}%, ${round(l, 1)}%`;
  return a < 1 ? `hsla(${body}, ${fmtA(a)})` : `hsl(${body})`;
}

export function toHsvString(c: RGBA): string {
  const { h, s, v, a } = rgbToHsv(c);
  const body = `${round(mod(h, 360), 1)}, ${round(s, 1)}%, ${round(v, 1)}%`;
  return a < 1 ? `hsva(${body}, ${fmtA(a)})` : `hsv(${body})`;
}

/** Name of the colour when it exactly matches a CSS named colour (opaque only). */
export function toNamed(c: RGBA): string | null {
  const x = roundRgba(c);
  if (x.a !== 1) return x.a === 0 && x.r === 0 && x.g === 0 && x.b === 0 ? 'transparent' : null;
  const hex = toHex(x).slice(1);
  for (const [name, h] of Object.entries(NAMED_COLORS)) if (h === hex) return name;
  return null;
}

/** Nearest named colour (Euclidean distance in RGB) — a hint for the user. */
export function nearestNamed(c: RGBA): { name: string; distance: number } {
  let best = { name: 'black', distance: Infinity };
  for (const [name, h] of Object.entries(NAMED_COLORS)) {
    const n = parseInt(h, 16);
    const d = Math.hypot(c.r - ((n >> 16) & 255), c.g - ((n >> 8) & 255), c.b - (n & 255));
    if (d < best.distance) best = { name, distance: d };
  }
  return best;
}

function parseHex(s: string): RGBA | null {
  const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (!m) return null;
  let h = m[1]!;
  if (h.length <= 4) h = [...h].map((x) => x + x).join('');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? round(n(6) / 255, 3) : 1 };
}

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`;

function parseArgs(body: string): string[] | null {
  const s = body.trim();
  // Modern syntax: "r g b / a"; legacy: "r, g, b, a".
  if (s.includes(',')) {
    const parts = s.split(',').map((x) => x.trim());
    return parts.every(Boolean) ? parts : null;
  }
  const [main, alpha, extra] = s.split('/').map((x) => x.trim());
  if (extra !== undefined) return null;
  const parts = main!.split(/\s+/).filter(Boolean);
  if (alpha !== undefined) {
    if (!alpha) return null;
    parts.push(alpha);
  }
  return parts;
}

function num(token: string, kind: 'channel' | 'percent' | 'alpha' | 'hue'): number | null {
  const m = new RegExp(`^(${NUM})(%|deg|grad|rad|turn)?$`, 'i').exec(token);
  if (!m) return token.toLowerCase() === 'none' ? 0 : null;
  const v = parseFloat(m[1]!);
  const unit = (m[2] ?? '').toLowerCase();
  switch (kind) {
    case 'channel':
      if (unit && unit !== '%') return null;
      return unit === '%' ? (v / 100) * 255 : v;
    case 'percent':
      if (unit && unit !== '%') return null;
      return v;
    case 'alpha':
      if (unit && unit !== '%') return null;
      return unit === '%' ? v / 100 : v;
    case 'hue':
      if (unit === '%') return null;
      if (unit === 'rad') return (v * 180) / Math.PI;
      if (unit === 'grad') return v * 0.9;
      if (unit === 'turn') return v * 360;
      return v;
  }
}

/**
 * Parses any CSS colour string we support: hex (3/4/6/8 digits), rgb()/rgba(), hsl()/hsla(),
 * hsv()/hsva() (not CSS, but common in design tools), named colours and `transparent`.
 */
export function parseColor(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('#')) return parseHex(s);
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, s)) return parseHex(NAMED_COLORS[s]!);
  const fn = /^(rgba?|hsla?|hsva?|hsb)\((.*)\)$/.exec(s);
  if (!fn) return /^[0-9a-f]{6}$|^[0-9a-f]{8}$/.test(s) ? parseHex(s) : null;
  const args = parseArgs(fn[2]!);
  if (!args || args.length < 3 || args.length > 4) return null;
  const alpha = args[3] === undefined ? 1 : num(args[3], 'alpha');
  if (alpha === null) return null;
  const a = clamp(alpha, 0, 1);
  if (fn[1]!.startsWith('rgb')) {
    const [r, g, b] = args.slice(0, 3).map((x) => num(x, 'channel'));
    if (r == null || g == null || b == null) return null;
    return clampRgba({ r, g, b, a });
  }
  const h = num(args[0]!, 'hue');
  const p1 = num(args[1]!, 'percent');
  const p2 = num(args[2]!, 'percent');
  if (h == null || p1 == null || p2 == null) return null;
  return fn[1]!.startsWith('hsl') ? hslToRgb({ h, s: p1, l: p2, a }) : hsvToRgb({ h, s: p1, v: p2, a });
}

/** WCAG 2.x relative luminance of an sRGB colour (alpha ignored). */
export function relativeLuminance({ r, g, b }: RGBA): number {
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Composites `fg` (with its alpha) over an opaque `bg`. */
export function blend(fg: RGBA, bg: RGBA): RGBA {
  const a = clamp(fg.a, 0, 1);
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

/** WCAG contrast ratio (1–21). A translucent foreground is composited over the background first. */
export function contrastRatio(fg: RGBA, bg: RGBA): number {
  const back = bg.a < 1 ? blend(bg, { r: 255, g: 255, b: 255, a: 1 }) : bg;
  const front = fg.a < 1 ? blend(fg, back) : fg;
  const l1 = relativeLuminance(front);
  const l2 = relativeLuminance(back);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export interface WcagResult {
  ratio: number;
  aa: boolean;
  aaLarge: boolean;
  aaa: boolean;
  aaaLarge: boolean;
}

export function wcag(fg: RGBA, bg: RGBA): WcagResult {
  const ratio = contrastRatio(fg, bg);
  // Compare the ratio rounded down to 2 decimals, as WCAG checkers do (4.499 fails AA).
  const r = Math.floor(ratio * 100) / 100;
  return { ratio, aa: r >= 4.5, aaLarge: r >= 3, aaa: r >= 7, aaaLarge: r >= 4.5 };
}

/** Text colour (black or white) that reads best on `bg`. */
export const readableOn = (bg: RGBA): '#000000' | '#ffffff' =>
  contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, bg) >= contrastRatio({ r: 255, g: 255, b: 255, a: 1 }, bg) ? '#000000' : '#ffffff';

/** Same colour? Compares rounded channels and alpha. */
export function sameColor(a: RGBA, b: RGBA): boolean {
  const x = roundRgba(a);
  const y = roundRgba(b);
  return x.r === y.r && x.g === y.g && x.b === y.b && Math.round(x.a * 255) === Math.round(y.a * 255);
}

export type ColorFormat = 'hex' | 'rgb' | 'hsl' | 'hsv' | 'named';

/** Formats `c` in the style of `like` (used when replacing a colour in source code). */
export function formatLike(c: RGBA, like: string): string {
  const s = like.trim().toLowerCase();
  const isUpper = like.trim() !== s && /^#/.test(like.trim());
  if (s.startsWith('#')) {
    const digits = s.length - 1;
    const out = digits === 3 || digits === 4 ? toShortHex(c) : toHex(c, digits === 8 ? 'always' : 'auto');
    return isUpper ? out.toUpperCase() : out;
  }
  if (s.startsWith('rgb')) return toRgbString(c);
  if (s.startsWith('hsl')) return toHslString(c);
  if (s.startsWith('hsv') || s.startsWith('hsb')) return toHsvString(c);
  return toNamed(c) ?? toHex(c);
}

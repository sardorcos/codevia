/**
 * CSS colour parsing and format-preserving writing (hex stays hex, rgb() stays rgb(), …),
 * used by the colour swatches in the editor. Pure functions.
 */

export const NAMED_COLORS: Readonly<Record<string, string>> = {
  aliceblue: '#f0f8ff', antiquewhite: '#faebd7', aqua: '#00ffff', aquamarine: '#7fffd4', azure: '#f0ffff', beige: '#f5f5dc',
  bisque: '#ffe4c4', black: '#000000', blanchedalmond: '#ffebcd', blue: '#0000ff', blueviolet: '#8a2be2', brown: '#a52a2a',
  burlywood: '#deb887', cadetblue: '#5f9ea0', chartreuse: '#7fff00', chocolate: '#d2691e', coral: '#ff7f50',
  cornflowerblue: '#6495ed', cornsilk: '#fff8dc', crimson: '#dc143c', cyan: '#00ffff', darkblue: '#00008b', darkcyan: '#008b8b',
  darkgoldenrod: '#b8860b', darkgray: '#a9a9a9', darkgreen: '#006400', darkgrey: '#a9a9a9', darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b', darkolivegreen: '#556b2f', darkorange: '#ff8c00', darkorchid: '#9932cc', darkred: '#8b0000',
  darksalmon: '#e9967a', darkseagreen: '#8fbc8f', darkslateblue: '#483d8b', darkslategray: '#2f4f4f', darkslategrey: '#2f4f4f',
  darkturquoise: '#00ced1', darkviolet: '#9400d3', deeppink: '#ff1493', deepskyblue: '#00bfff', dimgray: '#696969',
  dimgrey: '#696969', dodgerblue: '#1e90ff', firebrick: '#b22222', floralwhite: '#fffaf0', forestgreen: '#228b22',
  fuchsia: '#ff00ff', gainsboro: '#dcdcdc', ghostwhite: '#f8f8ff', gold: '#ffd700', goldenrod: '#daa520', gray: '#808080',
  green: '#008000', greenyellow: '#adff2f', grey: '#808080', honeydew: '#f0fff0', hotpink: '#ff69b4', indianred: '#cd5c5c',
  indigo: '#4b0082', ivory: '#fffff0', khaki: '#f0e68c', lavender: '#e6e6fa', lavenderblush: '#fff0f5', lawngreen: '#7cfc00',
  lemonchiffon: '#fffacd', lightblue: '#add8e6', lightcoral: '#f08080', lightcyan: '#e0ffff', lightgoldenrodyellow: '#fafad2',
  lightgray: '#d3d3d3', lightgreen: '#90ee90', lightgrey: '#d3d3d3', lightpink: '#ffb6c1', lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa', lightskyblue: '#87cefa', lightslategray: '#778899', lightslategrey: '#778899',
  lightsteelblue: '#b0c4de', lightyellow: '#ffffe0', lime: '#00ff00', limegreen: '#32cd32', linen: '#faf0e6', magenta: '#ff00ff',
  maroon: '#800000', mediumaquamarine: '#66cdaa', mediumblue: '#0000cd', mediumorchid: '#ba55d3', mediumpurple: '#9370db',
  mediumseagreen: '#3cb371', mediumslateblue: '#7b68ee', mediumspringgreen: '#00fa9a', mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585', midnightblue: '#191970', mintcream: '#f5fffa', mistyrose: '#ffe4e1', moccasin: '#ffe4b5',
  navajowhite: '#ffdead', navy: '#000080', oldlace: '#fdf5e6', olive: '#808000', olivedrab: '#6b8e23', orange: '#ffa500',
  orangered: '#ff4500', orchid: '#da70d6', palegoldenrod: '#eee8aa', palegreen: '#98fb98', paleturquoise: '#afeeee',
  palevioletred: '#db7093', papayawhip: '#ffefd5', peachpuff: '#ffdab9', peru: '#cd853f', pink: '#ffc0cb', plum: '#dda0dd',
  powderblue: '#b0e0e6', purple: '#800080', rebeccapurple: '#663399', red: '#ff0000', rosybrown: '#bc8f8f',
  royalblue: '#4169e1', saddlebrown: '#8b4513', salmon: '#fa8072', sandybrown: '#f4a460', seagreen: '#2e8b57',
  seashell: '#fff5ee', sienna: '#a0522d', silver: '#c0c0c0', skyblue: '#87ceeb', slateblue: '#6a5acd', slategray: '#708090',
  slategrey: '#708090', snow: '#fffafa', springgreen: '#00ff7f', steelblue: '#4682b4', tan: '#d2b48c', teal: '#008080',
  thistle: '#d8bfd8', tomato: '#ff6347', turquoise: '#40e0d0', violet: '#ee82ee', wheat: '#f5deb3', white: '#ffffff',
  whitesmoke: '#f5f5f5', yellow: '#ffff00', yellowgreen: '#9acd32',
};

export type ColorFormat = 'hex' | 'rgb' | 'hsl' | 'named';

export interface ParsedColor {
  /** 0–255 */
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
  format: ColorFormat;
  /** Source text. */
  raw: string;
  // How it was written, so a new colour can be written the same way.
  hexDigits?: 3 | 4 | 6 | 8;
  upper?: boolean;
  fn?: string;
  commas?: boolean;
  /** Alpha as written (`0.5`, `50%`), kept when the colour changes. */
  alphaText?: string;
  hueUnit?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function parseHex(raw: string): ParsedColor | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(raw);
  if (!m) return null;
  let h = m[1]!;
  const digits = h.length as 3 | 4 | 6 | 8;
  if (digits <= 4) h = [...h].map((c) => c + c).join('');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return {
    r: n(0),
    g: n(2),
    b: n(4),
    a: h.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1,
    format: 'hex',
    raw,
    hexDigits: digits,
    upper: /[A-F]/.test(m[1]!) && !/[a-f]/.test(m[1]!),
  };
}

function parseAlpha(s: string | undefined): number {
  if (s === undefined) return 1;
  const v = s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);
  return Number.isFinite(v) ? clamp(v, 0, 1) : NaN;
}

function splitArgs(inner: string): { parts: string[]; alpha?: string; commas: boolean } | null {
  const commas = inner.includes(',');
  let parts: string[];
  let alpha: string | undefined;
  if (commas) {
    parts = inner.split(',').map((s) => s.trim());
    if (parts.length === 4) alpha = parts.pop();
  } else {
    const [main, a] = inner.split('/').map((s) => s.trim());
    parts = (main ?? '').split(/\s+/).filter(Boolean);
    alpha = a;
  }
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  return { parts, alpha, commas };
}

const NUM = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i;

function parseRgb(raw: string): ParsedColor | null {
  const m = /^(rgba?)\(\s*([^()]*)\)$/i.exec(raw);
  if (!m) return null;
  const args = splitArgs(m[2]!);
  if (!args) return null;
  const ch = args.parts.map((p) => {
    if (!NUM.test(p) || !/^[^a-z]*%?$/i.test(p)) return NaN;
    return p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p);
  });
  const a = parseAlpha(args.alpha);
  if (ch.some((v) => !Number.isFinite(v)) || !Number.isFinite(a)) return null;
  const [r, g, b] = ch.map((v) => Math.round(clamp(v, 0, 255))) as [number, number, number];
  return { r, g, b, a, format: 'rgb', raw, fn: m[1], commas: args.commas, alphaText: args.alpha };
}

function hueDegrees(p: string): { deg: number; unit: string } | null {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|turn|rad|grad)?$/i.exec(p);
  if (!m) return null;
  const v = parseFloat(m[1]!);
  const unit = (m[2] ?? '').toLowerCase();
  const deg = unit === 'turn' ? v * 360 : unit === 'rad' ? (v * 180) / Math.PI : unit === 'grad' ? v * 0.9 : v;
  return { deg: ((deg % 360) + 360) % 360, unit };
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s = clamp(s, 0, 1);
  l = clamp(l, 0, 1);
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function parseHsl(raw: string): ParsedColor | null {
  const m = /^(hsla?)\(\s*([^()]*)\)$/i.exec(raw);
  if (!m) return null;
  const args = splitArgs(m[2]!);
  if (!args) return null;
  const hue = hueDegrees(args.parts[0]!);
  const pct = (p: string) => (/^[+-]?(\d+\.?\d*|\.\d+)%?$/.test(p) ? parseFloat(p) / 100 : NaN);
  const s = pct(args.parts[1]!);
  const l = pct(args.parts[2]!);
  const a = parseAlpha(args.alpha);
  if (!hue || !Number.isFinite(s) || !Number.isFinite(l) || !Number.isFinite(a)) return null;
  const [r, g, b] = hslToRgb(hue.deg, s, l);
  return { r, g, b, a, format: 'hsl', raw, fn: m[1], commas: args.commas, alphaText: args.alpha, hueUnit: hue.unit };
}

/** Parses a CSS colour: `#rgb[a]`, `#rrggbb[aa]`, `rgb()/rgba()`, `hsl()/hsla()` or a named colour. */
export function parseColor(text: string): ParsedColor | null {
  const raw = text.trim();
  if (!raw) return null;
  if (raw[0] === '#') return parseHex(raw);
  const lower = raw.toLowerCase();
  if (lower.startsWith('rgb')) return parseRgb(raw);
  if (lower.startsWith('hsl')) return parseHsl(raw);
  const hex = NAMED_COLORS[lower];
  if (!hex) return null;
  const c = parseHex(hex)!;
  return { ...c, format: 'named', raw, hexDigits: undefined, upper: raw === raw.toUpperCase() && raw !== lower };
}

const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');

/** `#rrggbb` (no alpha), the value format of `<input type="color">`. */
export const toHex6 = (c: Pick<ParsedColor, 'r' | 'g' | 'b'>): string => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;

/** CSS colour usable as a swatch background (keeps the alpha). */
export const toCss = (c: ParsedColor): string => `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;

const round = (v: number, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/**
 * Writes the colour `hex6` (`#rrggbb`, from the picker) in the format of `original`, keeping its
 * alpha and style: `#abc` stays short when possible, `rgb(1 2 3 / 50%)` keeps spaces and the alpha,
 * a named colour becomes another name when one matches, otherwise hex.
 */
export function formatColor(original: ParsedColor, hex6: string): string {
  const next = parseHex(hex6.length === 4 || hex6.length === 7 ? hex6 : '#000000')!;
  const { r, g, b } = next;
  switch (original.format) {
    case 'hex': {
      const digits = original.hexDigits ?? 6;
      const withAlpha = digits === 4 || digits === 8;
      const alphaHex = hex2(original.a * 255);
      let body = hex2(r) + hex2(g) + hex2(b) + (withAlpha ? alphaHex : '');
      const shortable = [...body].every((c, i) => i % 2 === 1 || c === body[i + 1]);
      if ((digits === 3 || digits === 4) && shortable) body = [...body].filter((_, i) => i % 2 === 0).join('');
      return `#${original.upper ? body.toUpperCase() : body}`;
    }
    case 'rgb': {
      const fn = original.fn ?? 'rgb';
      const a = original.alphaText;
      if (original.commas) return `${fn}(${r}, ${g}, ${b}${a !== undefined ? `, ${a}` : ''})`;
      return `${fn}(${r} ${g} ${b}${a !== undefined ? ` / ${a}` : ''})`;
    }
    case 'hsl': {
      const [h, s, l] = rgbToHsl(r, g, b);
      const fn = original.fn ?? 'hsl';
      const hue = `${round(h)}${original.hueUnit === 'deg' ? 'deg' : ''}`;
      const sat = `${round(s * 100)}%`;
      const light = `${round(l * 100)}%`;
      const a = original.alphaText;
      if (original.commas) return `${fn}(${hue}, ${sat}, ${light}${a !== undefined ? `, ${a}` : ''})`;
      return `${fn}(${hue} ${sat} ${light}${a !== undefined ? ` / ${a}` : ''})`;
    }
    case 'named': {
      const hex = toHex6(next);
      const name = Object.keys(NAMED_COLORS).find((k) => NAMED_COLORS[k] === hex);
      if (name) return original.upper ? name.toUpperCase() : name;
      return hex;
    }
  }
}

export interface ColorMatch {
  from: number;
  to: number;
  color: ParsedColor;
}

const TOKEN = /#[0-9a-fA-F]{3,8}(?![\w-])|\b(?:rgba?|hsla?)\([^()]*\)|(?<![\w#.$@-])[a-zA-Z]{3,20}(?![\w(-])/g;

/**
 * Colours in a CSS value or declaration list (`color: red; border: 1px solid #abc`).
 * Named colours count only after a `:` (so property names like `color` are not swatches).
 */
export function findColors(text: string, opts: { named?: boolean; offset?: number } = {}): ColorMatch[] {
  const out: ColorMatch[] = [];
  const offset = opts.offset ?? 0;
  TOKEN.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = TOKEN.exec(text)); ) {
    const raw = m[0];
    const isWord = /^[a-z]/i.test(raw) && !/^(rgba?|hsla?)\(/i.test(raw);
    if (isWord) {
      if (!opts.named) continue;
      const before = text.slice(0, m.index);
      const lastColon = before.lastIndexOf(':');
      const lastSemi = Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'));
      if (lastColon < 0 || lastColon < lastSemi) continue;
    }
    const color = parseColor(raw);
    if (color) out.push({ from: offset + m.index, to: offset + m.index + raw.length, color });
  }
  return out;
}

import { describe, expect, it } from 'vitest';
import {
  NAMED_COLORS, blend, contrastRatio, formatLike, hslToRgb, hsvToRgb, nearestNamed, parseColor, readableOn, relativeLuminance,
  rgbToHsl, rgbToHsv, roundRgba, sameColor, toHex, toHslString, toHsvString, toNamed, toRgbString, toShortHex, wcag, type RGBA,
} from '../../src/tools/color/convert';
import { findColorTokens, replaceColorInFiles, replaceColorInText, scanProjectColors, sourceKind } from '../../src/tools/color/scan';
import { textFile, binaryFile, type Files } from '../../src/core/types';

const rgb = (r: number, g: number, b: number, a = 1): RGBA => ({ r, g, b, a });

describe('parseColor', () => {
  it('parses hex in 3, 4, 6 and 8 digits', () => {
    expect(parseColor('#fff')).toEqual(rgb(255, 255, 255));
    expect(parseColor('#0f08')).toEqual(rgb(0, 255, 0, 0.533));
    expect(parseColor('#40C8F6')).toEqual(rgb(64, 200, 246));
    expect(parseColor('#40c8f680')).toEqual(rgb(64, 200, 246, 0.502));
    expect(parseColor('40c8f6')).toEqual(rgb(64, 200, 246));
    for (const bad of ['#ff', '#fffff', '#ggg', '#1234567', '']) expect(parseColor(bad), bad).toBeNull();
  });

  it('parses rgb()/rgba() in legacy and modern syntax, with percentages', () => {
    expect(parseColor('rgb(255, 0, 128)')).toEqual(rgb(255, 0, 128));
    expect(parseColor('rgba(255,0,128,0.5)')).toEqual(rgb(255, 0, 128, 0.5));
    expect(parseColor('rgb(255 0 128 / 50%)')).toEqual(rgb(255, 0, 128, 0.5));
    expect(parseColor('rgb(100% 0% 50%)')).toEqual(rgb(255, 0, 127.5));
    expect(parseColor('RGB(300, -5, 10)')).toEqual(rgb(255, 0, 10));
    expect(parseColor('rgb(1, 2)')).toBeNull();
    expect(parseColor('rgb(1, 2, 3, 4, 5)')).toBeNull();
    expect(parseColor('rgb(1 2 3 / )')).toBeNull();
    expect(parseColor('rgb(1deg, 2, 3)')).toBeNull();
  });

  it('parses hsl()/hsla() with angle units, and hsv()', () => {
    expect(roundRgba(parseColor('hsl(0, 100%, 50%)')!)).toEqual(rgb(255, 0, 0));
    expect(roundRgba(parseColor('hsl(120deg 100% 25% / 0.25)')!)).toEqual(rgb(0, 128, 0, 0.25));
    expect(roundRgba(parseColor('hsla(0.5turn, 100%, 50%, 1)')!)).toEqual(rgb(0, 255, 255));
    expect(roundRgba(parseColor('hsl(3.14159rad 100% 50%)')!)).toEqual(rgb(0, 255, 255));
    expect(roundRgba(parseColor('hsl(400grad, 100%, 50%)')!)).toEqual(rgb(255, 0, 0));
    expect(roundRgba(parseColor('hsv(240, 100%, 100%)')!)).toEqual(rgb(0, 0, 255));
    expect(parseColor('hsl(10%, 50%, 50%)')).toBeNull();
  });

  it('parses named colours and transparent', () => {
    expect(parseColor('RebeccaPurple')).toEqual(rgb(102, 51, 153));
    expect(parseColor('transparent')).toEqual(rgb(0, 0, 0, 0));
    expect(parseColor('notacolor')).toBeNull();
    expect(Object.keys(NAMED_COLORS)).toHaveLength(148);
  });
});

describe('conversions', () => {
  it('converts known values', () => {
    const c = rgb(64, 200, 246);
    const h = rgbToHsl(c);
    expect(h.h).toBeCloseTo(195.16, 1);
    expect(h.s).toBeCloseTo(91, 1);
    expect(h.l).toBeCloseTo(60.78, 1);
    const v = rgbToHsv(c);
    expect(v.h).toBeCloseTo(195.16, 1);
    expect(v.s).toBeCloseTo(73.98, 1);
    expect(v.v).toBeCloseTo(96.47, 1);
    expect(rgbToHsl(rgb(128, 128, 128))).toEqual({ h: 0, s: 0, l: expect.closeTo(50.2, 1) as unknown as number, a: 1 });
  });

  it('round-trips RGB → HSL → RGB and RGB → HSV → RGB for a grid of colours', () => {
    for (let r = 0; r <= 255; r += 17)
      for (let g = 0; g <= 255; g += 51)
        for (let b = 0; b <= 255; b += 85) {
          const c = rgb(r, g, b, 0.4);
          expect(roundRgba(hslToRgb(rgbToHsl(c))), `hsl ${r},${g},${b}`).toEqual(c);
          expect(roundRgba(hsvToRgb(rgbToHsv(c))), `hsv ${r},${g},${b}`).toEqual(c);
        }
  });

  it('round-trips through every string format', () => {
    const samples = [rgb(0, 0, 0), rgb(255, 255, 255), rgb(64, 200, 246), rgb(12, 34, 56, 0.5), rgb(250, 128, 114), rgb(1, 2, 3, 0)];
    for (const c of samples) {
      for (const s of [toHex(c), toRgbString(c), toHslString(c), toHsvString(c)]) {
        expect(sameColor(parseColor(s)!, c), s).toBe(true);
      }
    }
  });

  it('formats strings', () => {
    expect(toHex(rgb(64, 200, 246))).toBe('#40c8f6');
    expect(toHex(rgb(64, 200, 246), 'always')).toBe('#40c8f6ff');
    expect(toHex(rgb(64, 200, 246, 0.5))).toBe('#40c8f680');
    expect(toHex(rgb(64, 200, 246, 0.5), 'never')).toBe('#40c8f6');
    expect(toShortHex(rgb(255, 255, 255))).toBe('#fff');
    expect(toShortHex(rgb(255, 0, 0, 0.6))).toBe('#f009');
    expect(toShortHex(rgb(64, 200, 246))).toBe('#40c8f6');
    expect(toRgbString(rgb(1.4, 2.6, 3))).toBe('rgb(1, 3, 3)');
    expect(toRgbString(rgb(1, 2, 3, 0.25))).toBe('rgba(1, 2, 3, 0.25)');
    expect(toHslString(rgb(255, 0, 0))).toBe('hsl(0, 100%, 50%)');
    expect(toHslString(rgb(255, 0, 0, 0.5))).toBe('hsla(0, 100%, 50%, 0.5)');
    expect(toHsvString(rgb(0, 0, 255))).toBe('hsv(240, 100%, 100%)');
  });

  it('finds exact and nearest names', () => {
    expect(toNamed(rgb(255, 99, 71))).toBe('tomato');
    expect(toNamed(rgb(0, 255, 255))).toBe('aqua'); // first match wins (aqua = cyan)
    expect(toNamed(rgb(255, 99, 72))).toBeNull();
    expect(toNamed(rgb(0, 0, 0, 0))).toBe('transparent');
    expect(toNamed(rgb(255, 0, 0, 0.5))).toBeNull();
    expect(nearestNamed(rgb(255, 99, 72)).name).toBe('tomato');
  });

  it('formats like an existing token', () => {
    const c = rgb(255, 0, 0);
    expect(formatLike(c, '#abc')).toBe('#f00');
    expect(formatLike(c, '#ABCDEF')).toBe('#FF0000');
    expect(formatLike(c, '#abcdef80')).toBe('#ff0000ff');
    expect(formatLike(rgb(18, 52, 86), '#abc')).toBe('#123456');
    expect(formatLike(c, 'rgb(1,2,3)')).toBe('rgb(255, 0, 0)');
    expect(formatLike(c, 'hsl(1,2%,3%)')).toBe('hsl(0, 100%, 50%)');
    expect(formatLike(c, 'blue')).toBe('red');
    expect(formatLike(rgb(1, 2, 3), 'blue')).toBe('#010203');
  });
});

describe('WCAG contrast', () => {
  it('computes luminance and ratios', () => {
    expect(relativeLuminance(rgb(255, 255, 255))).toBeCloseTo(1, 5);
    expect(relativeLuminance(rgb(0, 0, 0))).toBe(0);
    expect(contrastRatio(rgb(0, 0, 0), rgb(255, 255, 255))).toBeCloseTo(21, 5);
    expect(contrastRatio(rgb(255, 255, 255), rgb(255, 255, 255))).toBeCloseTo(1, 5);
    expect(contrastRatio(rgb(119, 119, 119), rgb(255, 255, 255))).toBeCloseTo(4.48, 2);
  });

  it('assigns AA/AAA levels and does not round up', () => {
    const grey = wcag(rgb(119, 119, 119), rgb(255, 255, 255)); // 4.48
    expect(grey).toMatchObject({ aa: false, aaLarge: true, aaa: false, aaaLarge: false });
    const dark = wcag(rgb(0x59, 0x59, 0x59), rgb(255, 255, 255)); // ≈ 7.0
    expect(dark.aa && dark.aaLarge && dark.aaaLarge).toBe(true);
    expect(wcag(rgb(0, 0, 0), rgb(255, 255, 255))).toMatchObject({ aa: true, aaa: true });
    // App tokens: --muted on --bg is documented as ≥ 4.5.
    expect(wcag(parseColor('#a3acb9')!, parseColor('#0c0e12')!).aa).toBe(true);
  });

  it('composites translucent colours first', () => {
    expect(blend(rgb(0, 0, 0, 0.5), rgb(255, 255, 255))).toEqual(rgb(127.5, 127.5, 127.5));
    expect(contrastRatio(rgb(0, 0, 0, 0), rgb(255, 255, 255))).toBeCloseTo(1, 5);
    expect(readableOn(rgb(255, 255, 0))).toBe('#000000');
    expect(readableOn(rgb(20, 20, 80))).toBe('#ffffff');
  });
});

describe('colours in project source', () => {
  const css = `/* #bad comment */
#header, .x:hover { color: #FFF; background: rgba(0, 0, 0, .5) url("#abc.png"); }
@media (max-width: 600px) { .y { border: 1px solid red; font-family: "Red Hat"; } }
.z { --brand: #40c8f6; grid-area: red; animation: tomato 1s; box-shadow: 0 0 2px hsl(0 100% 50%); }`;

  it('finds colours only in declaration values', () => {
    const toks = findColorTokens(css, 'css').map((t) => t.raw);
    expect(toks).toEqual(['#FFF', 'rgba(0, 0, 0, .5)', 'red', '#40c8f6', 'hsl(0 100% 50%)']);
  });

  it('finds colours in <style>, style="" and presentation attributes, not in anchors or entities', () => {
    const html = `<a href="#abc">&#123;</a><style>p{color:#123}</style>
<div style="background-color: teal; width: 10px">x</div><svg><rect fill="#f00" stroke='none'/><path fill="url(#g)"/></svg>`;
    const toks = findColorTokens(html, 'html');
    expect(toks.map((t) => t.raw)).toEqual(['#123', 'teal', '#f00']);
    for (const t of toks) expect(html.slice(t.start, t.end)).toBe(t.raw);
  });

  it('counts colours across files and groups notations', () => {
    const files: Files = {
      'a.css': textFile('a{color:#fff} b{color:white} c{color:rgb(255,255,255)} d{color:#000}'),
      'b.html': textFile('<p style="color:#FFFFFF">x</p>'),
      'c.js': textFile('const c = "#fff";'),
      'd.png': binaryFile(new Uint8Array([1, 2])),
    };
    const u = scanProjectColors(files);
    expect(u[0]).toMatchObject({ key: '#ffffff', count: 4, files: ['a.css', 'b.html'] });
    expect(u[0]!.variants).toEqual({ '#fff': 1, white: 1, 'rgb(255,255,255)': 1, '#FFFFFF': 1 });
    expect(u[1]).toMatchObject({ key: '#000000', count: 1 });
    expect(sourceKind('x.scss')).toBe('css');
    expect(sourceKind('x.js')).toBeNull();
  });

  it('replaces a colour everywhere keeping each notation', () => {
    const r = replaceColorInText('a{color:#fff;border:1px solid white} b{background:rgb(255,255,255)} c{color:#fffe}', 'css', rgb(255, 255, 255), rgb(255, 0, 0));
    expect(r.count).toBe(3);
    expect(r.text).toBe('a{color:#f00;border:1px solid red} b{background:rgb(255, 0, 0)} c{color:#fffe}');
    const files: Files = { 'a.css': textFile('a{color:#fff}'), 'b.css': textFile('b{color:#000}'), 'i.html': textFile('<b style="color: #fff">') };
    const all = replaceColorInFiles(files, rgb(255, 255, 255), rgb(0, 128, 0));
    expect(all.count).toBe(2);
    expect(Object.keys(all.changed).sort()).toEqual(['a.css', 'i.html']);
    expect(all.changed['a.css']).toEqual(textFile('a{color:#008000}'));
    expect(all.changed['i.html']).toEqual(textFile('<b style="color: #008000">'));
  });
});

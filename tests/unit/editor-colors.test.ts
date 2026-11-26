import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { colorsInView } from '../../src/editor/color-swatches';
import { findColors, formatColor, hslToRgb, parseColor, rgbToHsl, toCss, toHex6 } from '../../src/editor/colors';
import { languageFor } from '../../src/editor/languages';

describe('parseColor', () => {
  it('parses hex in all lengths', () => {
    expect(parseColor('#fff')).toMatchObject({ r: 255, g: 255, b: 255, a: 1, format: 'hex', hexDigits: 3 });
    expect(parseColor('#40C8F6')).toMatchObject({ r: 64, g: 200, b: 246, a: 1, hexDigits: 6, upper: true });
    expect(parseColor('#0008')).toMatchObject({ r: 0, g: 0, b: 0, hexDigits: 4 });
    expect(parseColor('#0008')!.a).toBeCloseTo(0.533, 2);
    expect(parseColor('#ff000080')!.a).toBeCloseTo(0.502, 2);
    expect(parseColor('#ggg')).toBeNull();
    expect(parseColor('#12345')).toBeNull();
  });

  it('parses rgb() and hsl() in comma and space syntax', () => {
    expect(parseColor('rgb(255, 0, 128)')).toMatchObject({ r: 255, g: 0, b: 128, a: 1, format: 'rgb', commas: true });
    expect(parseColor('rgba(0,0,0,.5)')).toMatchObject({ a: 0.5, fn: 'rgba', alphaText: '.5' });
    expect(parseColor('rgb(10 20 30 / 50%)')).toMatchObject({ r: 10, g: 20, b: 30, a: 0.5, commas: false, alphaText: '50%' });
    expect(parseColor('rgb(100%, 0%, 50%)')).toMatchObject({ r: 255, g: 0, b: 128 });
    expect(parseColor('hsl(120, 100%, 50%)')).toMatchObject({ r: 0, g: 255, b: 0, format: 'hsl' });
    expect(parseColor('hsl(0.5turn 100% 50% / 0.25)')).toMatchObject({ r: 0, g: 255, b: 255, a: 0.25 });
    expect(parseColor('hsla(240deg, 100%, 50%, 1)')).toMatchObject({ r: 0, g: 0, b: 255, hueUnit: 'deg' });
    expect(parseColor('rgb(1, 2)')).toBeNull();
    expect(parseColor('rgb(a, b, c)')).toBeNull();
    expect(parseColor('rgb(var(--x))')).toBeNull();
  });

  it('parses named colours', () => {
    expect(parseColor('rebeccapurple')).toMatchObject({ r: 102, g: 51, b: 153, format: 'named' });
    expect(parseColor('Red')).toMatchObject({ r: 255, format: 'named' });
    expect(parseColor('solid')).toBeNull();
    expect(parseColor('transparent')).toBeNull();
  });

  it('converts between HSL and RGB', () => {
    expect(hslToRgb(210, 0.5, 0.4)).toEqual([51, 102, 153]);
    const [h, s, l] = rgbToHsl(51, 102, 153);
    expect([Math.round(h), Math.round(s * 100), Math.round(l * 100)]).toEqual([210, 50, 40]);
    expect(toHex6({ r: 64, g: 200, b: 246 })).toBe('#40c8f6');
    expect(toCss(parseColor('rgb(1 2 3 / 50%)')!)).toBe('rgba(1, 2, 3, 0.5)');
  });
});

describe('formatColor keeps the original format', () => {
  const fmt = (orig: string, hex: string) => formatColor(parseColor(orig)!, hex);

  it('hex stays hex (short when possible, case and alpha kept)', () => {
    expect(fmt('#fff', '#ff0000')).toBe('#f00');
    expect(fmt('#fff', '#123456')).toBe('#123456');
    expect(fmt('#ABCDEF', '#00ff00')).toBe('#00FF00');
    expect(fmt('#ff000080', '#0000ff')).toBe('#0000ff80');
    expect(fmt('#f008', '#00ff00')).toBe('#0f08');
  });

  it('rgb stays rgb, hsl stays hsl, alpha text kept', () => {
    expect(fmt('rgb(0, 0, 0)', '#40c8f6')).toBe('rgb(64, 200, 246)');
    expect(fmt('rgba(0,0,0,.5)', '#ffffff')).toBe('rgba(255, 255, 255, .5)');
    expect(fmt('rgb(0 0 0 / 50%)', '#ff0000')).toBe('rgb(255 0 0 / 50%)');
    expect(fmt('hsl(0, 0%, 0%)', '#336699')).toBe('hsl(210, 50%, 40%)');
    expect(fmt('hsl(0deg 0% 0% / .3)', '#ff0000')).toBe('hsl(0deg 100% 50% / .3)');
  });

  it('named becomes another name or hex', () => {
    expect(fmt('red', '#0000ff')).toBe('blue');
    expect(fmt('RED', '#008000')).toBe('GREEN');
    expect(fmt('red', '#123456')).toBe('#123456');
  });
});

describe('finding colours', () => {
  it('finds colours in declarations (named only in values)', () => {
    const text = 'color: red; border: 1px solid #abc; background: rgb(1 2 3 / 50%); red-thing: 0';
    expect(findColors(text, { named: true }).map((m) => text.slice(m.from, m.to))).toEqual(['red', '#abc', 'rgb(1 2 3 / 50%)']);
    expect(findColors(text).map((m) => m.color.raw)).toEqual(['#abc', 'rgb(1 2 3 / 50%)']);
  });

  it('finds colours in CSS, style attributes, <style> and JS strings via the syntax tree', () => {
    const view = (doc: string, path: string) => {
      const state = EditorState.create({ doc, extensions: [languageFor(path)] });
      ensureSyntaxTree(state, doc.length, 1000);
      return colorsInView(state, [{ from: 0, to: doc.length }]).map((m) => doc.slice(m.from, m.to));
    };
    expect(view('.a { color: red; border: 1px solid #ABC; transition: color 1s; background: hsl(1, 2%, 3%) }', 'a.css')).toEqual([
      'red',
      '#ABC',
      'hsl(1, 2%, 3%)',
    ]);
    expect(view('<p style="color: blue; margin: 0">x</p><style>b { color: #000 }</style><p class="red">', 'a.html')).toEqual(['blue', '#000']);
    expect(view("const c = '#40c8f6'; const d = 'red'; const e = \"rgb(0 0 0)\";", 'a.js')).toEqual(['#40c8f6', 'rgb(0 0 0)']);
  });
});

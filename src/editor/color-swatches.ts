import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { t } from '../i18n';
import { findColors, formatColor, parseColor, toCss, toHex6, type ColorMatch } from './colors';

/**
 * Colour swatches before CSS colours (CSS files, <style>, style="…" attributes, and colour strings in
 * JS such as `'#40c8f6'`). The swatch is a native `<input type="color">` drawn as a small square, so a
 * tap opens the system colour picker directly (iOS needs the tap on the input itself). The picked
 * colour is written back in the format of the original (hex stays hex, rgb() stays rgb()).
 */
class SwatchWidget extends WidgetType {
  constructor(
    readonly css: string,
    readonly hex: string,
    readonly raw: string,
  ) {
    super();
  }

  eq(other: SwatchWidget): boolean {
    return other.css === this.css && other.raw === this.raw;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-color-swatch';
    const fill = document.createElement('span');
    fill.className = 'cm-color-swatch-fill';
    const input = document.createElement('input');
    input.type = 'color';
    input.tabIndex = -1;
    wrap.append(fill, input);
    this.paint(wrap);
    input.addEventListener('input', () => applyPicked(view, wrap, input.value));
    input.addEventListener('change', () => applyPicked(view, wrap, input.value));
    return wrap;
  }

  /** Reuses the DOM (and an open picker) when only the colour changed. */
  updateDOM(dom: HTMLElement): boolean {
    this.paint(dom);
    return true;
  }

  private paint(dom: HTMLElement) {
    const fill = dom.firstElementChild as HTMLElement;
    const input = dom.lastElementChild as HTMLInputElement;
    fill.style.backgroundColor = this.css;
    if (input.value !== this.hex) input.value = this.hex;
    input.setAttribute('aria-label', t('Изменить цвет {color}', { color: this.raw }));
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const COLOR_AT = /^(#[0-9a-fA-F]{3,8}(?![\w-])|(?:rgba?|hsla?)\([^()]*\)|[a-zA-Z]+)/;

/** Replaces the colour right after the swatch with `hex6` written in the same format. */
function applyPicked(view: EditorView, dom: HTMLElement, hex6: string): void {
  let pos: number;
  try {
    pos = view.posAtDOM(dom);
  } catch {
    return;
  }
  const line = view.state.doc.lineAt(pos);
  const m = COLOR_AT.exec(line.text.slice(pos - line.from));
  const original = m ? parseColor(m[1]!) : null;
  if (!m || !original) return;
  const next = formatColor(original, hex6);
  if (next === m[1]) return;
  view.dispatch({ changes: { from: pos, to: pos + m[1]!.length, insert: next }, userEvent: 'input.color' });
}

const CSS_CALLEE = /^(rgba?|hsla?)$/i;

/** Colours in the visible part of the document. */
export function colorsInView(state: EditorState, ranges: readonly { from: number; to: number }[]): ColorMatch[] {
  const out: ColorMatch[] = [];
  const tree = syntaxTree(state);
  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        const name = node.name;
        if (name === 'ColorLiteral' || name === 'ValueName') {
          const raw = state.sliceDoc(node.from, node.to);
          const color = parseColor(raw);
          if (color && (name === 'ColorLiteral' || node.node.parent?.name === 'Declaration')) out.push({ from: node.from, to: node.to, color });
          return false;
        }
        if (name === 'CallExpression') {
          const callee = node.node.getChild('Callee');
          if (callee && CSS_CALLEE.test(state.sliceDoc(callee.from, callee.to))) {
            const color = parseColor(state.sliceDoc(node.from, node.to));
            if (color) out.push({ from: node.from, to: node.to, color });
            return false;
          }
          return undefined;
        }
        if (name === 'AttributeValue') {
          const attr = node.node.parent;
          const attrName = attr?.getChild('AttributeName');
          if (attrName && state.sliceDoc(attrName.from, attrName.to).toLowerCase() === 'style') {
            out.push(...findColors(state.sliceDoc(node.from, node.to), { named: true, offset: node.from }));
          }
          return false;
        }
        if (name === 'String' && node.to - node.from <= 64) {
          // JS/TS/Python/PHP string that is exactly one colour: '#fff', "rgb(0 0 0)".
          const text = state.sliceDoc(node.from + 1, node.to - 1);
          if (/^(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\([^()]*\))$/.test(text)) {
            const color = parseColor(text);
            if (color) out.push({ from: node.from + 1, to: node.to - 1, color });
          }
          return false;
        }
        return undefined;
      },
    });
  }
  return out;
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const m of colorsInView(view.state, view.visibleRanges).sort((a, b) => a.from - b.from)) {
    if (m.from === last) continue;
    last = m.from;
    builder.add(m.from, m.from, Decoration.widget({ widget: new SwatchWidget(toCss(m.color), toHex6(m.color), m.color.raw), side: -1 }));
  }
  return builder.finish();
}

const swatches = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export function colorSwatches(): Extension {
  return swatches;
}

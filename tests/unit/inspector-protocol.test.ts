import { describe, expect, it } from 'vitest';
import {
  cssRuleText,
  findRuleLine,
  isInspectorType,
  isPreviewMessage,
  networkFilterOf,
  selectorFromLabel,
  withToken,
  NETWORK_BUFFER,
} from '../../src/tools/inspector/protocol';

describe('inspector protocol', () => {
  it('recognizes inspector events and console lines', () => {
    expect(isInspectorType('inspect:tree')).toBe(true);
    expect(isInspectorType('navigate')).toBe(false);
    expect(isPreviewMessage({ type: 'inspect:dom-changed' })).toBe(true);
    expect(isPreviewMessage({ type: 'console', level: 'log', args: [] })).toBe(true);
    expect(isPreviewMessage({ type: 'navigate', path: 'a.html' })).toBe(false);
    expect(isPreviewMessage(null)).toBe(false);
    expect(isPreviewMessage('inspect:tree')).toBe(false);
  });

  it('adds the frame token to requests', () => {
    expect(withToken({ type: 'inspect:select', id: 3 }, 'tok')).toEqual({ type: 'inspect:select', id: 3, token: 'tok' });
    expect(NETWORK_BUFFER).toBe(300);
  });

  it('formats a CSS rule for copying', () => {
    expect(
      cssRuleText('.card', [
        { name: 'color', value: 'red', important: false },
        { name: 'padding', value: '8px', important: true },
        { name: 'margin', value: '', important: false },
      ]),
    ).toBe('.card {\n  color: red;\n  padding: 8px !important;\n}');
    expect(cssRuleText('p', [])).toBe('p {\n}');
  });

  it('derives a selector from a breadcrumb label', () => {
    expect(selectorFromLabel('div#main.wrap')).toBe('#main');
    expect(selectorFromLabel('li.item.active')).toBe('li.item.active');
  });

  it('groups network entries for the filter chips', () => {
    expect(networkFilterOf({ kind: 'fetch', type: 'json' })).toBe('fetch');
    expect(networkFilterOf({ kind: 'xhr', type: 'image' })).toBe('fetch');
    expect(networkFilterOf({ kind: 'resource', type: 'image' })).toBe('image');
    expect(networkFilterOf({ kind: 'resource', type: 'text' })).toBe('other');
  });

  it('finds the source line of a rule, tolerating formatting differences', () => {
    const css = `/* header */\nbody{margin:0}\n\n.card  >  h2,\n.card h3 {\n  color: red;\n}\n.card h2 { x: 1 }\n@media (min-width: 600px) {\n  .grid { display: grid }\n}\ninput[type=text] { a: b }`;
    expect(findRuleLine(css, 'body')).toBe(2);
    expect(findRuleLine(css, '.card > h2, .card h3')).toBe(4);
    // A selector inside another selector does not count: ".card h2" starts at line 8, not inside line 4.
    expect(findRuleLine(css, '.card h2')).toBe(8);
    expect(findRuleLine(css, '.grid')).toBe(10);
    expect(findRuleLine(css, '.missing')).toBeUndefined();
    expect(findRuleLine('<style>\n  .a { color: red }\n</style>', '.a')).toBe(2);
    expect(findRuleLine(css, '')).toBeUndefined();
  });
});

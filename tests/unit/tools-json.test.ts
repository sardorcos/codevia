import { describe, expect, it } from 'vitest';
import {
  formatJson, getAtPath, jsonPath, jsonType, locateJsonError, minifyJson, offsetToLineCol, parseJson, searchJson, sortKeysDeep, type JsonValue,
} from '../../src/tools/json/format';

const err = (text: string) => {
  const r = parseJson(text);
  if (r.ok) throw new Error('expected an error');
  return r.error;
};

describe('parseJson', () => {
  it('parses valid JSON, ignoring a BOM', () => {
    expect(parseJson('{"a":[1,2,{"b":null}]}')).toEqual({ ok: true, value: { a: [1, 2, { b: null }] } });
    expect(parseJson('﻿[true]')).toEqual({ ok: true, value: [true] });
  });

  it('reports line and column of errors', () => {
    expect(err('{\n  "a": 1,\n  "b": 2,\n}')).toMatchObject({ line: 4, column: 1, message: 'Лишняя запятая перед «}»' });
    expect(err('{"a" 1}')).toMatchObject({ line: 1, column: 6, message: 'Ожидалось двоеточие' });
    expect(err('[1, 2 3]')).toMatchObject({ line: 1, column: 7, message: 'Ожидалась запятая или «]»' });
    expect(err("{'a': 1}")).toMatchObject({ line: 1, column: 2, message: 'Ожидалось имя ключа в двойных кавычках' });
    expect(err("['a']")).toMatchObject({ column: 2, message: 'Строки в JSON пишутся в двойных кавычках' });
    expect(err('{"a": tru}')).toMatchObject({ column: 7 });
    expect(err('[01]')).toMatchObject({ column: 2, message: 'Недопустимое число' });
    expect(err('{"a": "x\ny"}')).toMatchObject({ line: 1, column: 9, message: 'Управляющий символ внутри строки' });
    expect(err('"\\x"')).toMatchObject({ column: 2, message: 'Недопустимая escape-последовательность' });
    expect(err('{"a": [1, 2')).toMatchObject({ message: 'Неожиданный конец данных' });
    expect(err('{} []')).toMatchObject({ column: 4, message: 'Лишние данные после JSON' });
    expect(err('   ')).toMatchObject({ message: 'Пустой ввод' });
  });

  it('locateJsonError agrees with JSON.parse on what is valid', () => {
    for (const s of ['0', '-1.5e+10', '"\\u00e9\\n"', '{"a":{"b":[[],{}]}}', ' [ 1 , 2 ] ']) expect(locateJsonError(s), s).toBeNull();
    for (const s of ['01', '1.', '.5', '+1', 'NaN', '[,]', '{"a":1,,}', '"abc']) expect(locateJsonError(s), s).not.toBeNull();
  });

  it('maps offsets to lines and columns', () => {
    expect(offsetToLineCol('ab\ncd', 0)).toEqual({ line: 1, column: 1 });
    expect(offsetToLineCol('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
  });
});

describe('formatting', () => {
  const v = { b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } } as JsonValue;

  it('pretty prints with 2, 4 or tab indentation and minifies', () => {
    expect(formatJson({ a: [1] }, 2)).toBe('{\n  "a": [\n    1\n  ]\n}');
    expect(formatJson({ a: 1 }, 4)).toBe('{\n    "a": 1\n}');
    expect(formatJson({ a: 1 }, '\t')).toBe('{\n\t"a": 1\n}');
    expect(minifyJson(v)).toBe('{"b":1,"a":{"d":[3,{"z":1,"y":2}],"c":"x"}}');
  });

  it('sorts keys deeply, keeping array order', () => {
    expect(minifyJson(sortKeysDeep(v))).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
    expect(sortKeysDeep([3, 1, 2])).toEqual([3, 1, 2]);
  });
});

describe('paths and search', () => {
  it('builds JSONPath strings', () => {
    expect(jsonPath([])).toBe('$');
    expect(jsonPath(['a', 0, 'b'])).toBe('$.a[0].b');
    expect(jsonPath(['first name', 'x-y', '$ok', '_1', 2])).toBe('$["first name"]["x-y"].$ok._1[2]');
    expect(jsonPath(['quo"te'])).toBe('$["quo\\"te"]');
  });

  it('reads values by path', () => {
    const v = { a: [{ b: 5 }], 'x y': null } as JsonValue;
    expect(getAtPath(v, ['a', 0, 'b'])).toBe(5);
    expect(getAtPath(v, ['x y'])).toBeNull();
    expect(getAtPath(v, ['a', 'b'])).toBeUndefined();
    expect(getAtPath(v, ['missing'])).toBeUndefined();
    expect(getAtPath(v, ['toString'])).toBeUndefined();
    expect(jsonType([])).toBe('array');
    expect(jsonType(null)).toBe('null');
  });

  it('finds keys and values case-insensitively in document order', () => {
    const v = { Name: 'Ann', list: [{ name: 'Bob' }, { title: 'anna' }], n: 12 } as JsonValue;
    const hits = searchJson(v, 'an');
    expect(hits.map((h) => jsonPath(h.path))).toEqual(['$.Name', '$.list[1].title']);
    expect(hits[0]).toMatchObject({ inKey: false, inValue: true });
    expect(searchJson(v, 'name').map((h) => [jsonPath(h.path), h.inKey])).toEqual([
      ['$.Name', true],
      ['$.list[0].name', true],
    ]);
    expect(searchJson(v, '12').map((h) => jsonPath(h.path))).toEqual(['$.n']);
    expect(searchJson(v, '')).toEqual([]);
    expect(searchJson({ a: Array.from({ length: 50 }, () => 'x') }, 'x', 10)).toHaveLength(10);
  });
});

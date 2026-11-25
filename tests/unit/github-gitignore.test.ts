import { describe, expect, it } from 'vitest';
import { binaryFile, textFile } from '../../src/core/types';
import { createGitignore } from '../../src/github/gitignore';
import { detectSecret, secretByName, secretInText } from '../../src/github/secrets';

const check = (rules: string, cases: Record<string, boolean>) => {
  const m = createGitignore(rules);
  for (const [path, expected] of Object.entries(cases)) expect([path, m.ignores(path)]).toEqual([path, expected]);
};

describe('gitignore matcher', () => {
  it('ignores comments and blank lines', () => {
    check('# comment\n\n   \n', { '# comment': false, 'a.txt': false });
    check('\\#hash', { '#hash': true });
  });

  it('matches basenames at any depth without a slash', () => {
    check('*.log\nnode_modules', {
      'debug.log': true,
      'a/b/debug.log': true,
      'debug.log.txt': false,
      'node_modules/x/index.js': true,
      'src/node_modules/y.js': true,
    });
  });

  it('anchors patterns that contain a slash', () => {
    check('/build\ndocs/*.md', {
      'build/out.js': true,
      'src/build/out.js': false,
      'docs/a.md': true,
      'docs/sub/a.md': false,
      'x/docs/a.md': false,
    });
  });

  it('trailing slash matches directories only', () => {
    check('cache/', { 'cache/a': true, 'x/cache/b': true, cache: false });
  });

  it('supports ** forms', () => {
    check('**/temp\nlogs/**\na/**/z.txt', {
      temp: true,
      'x/y/temp': true,
      'logs/a/b.txt': true,
      logs: false,
      'a/z.txt': true,
      'a/b/c/z.txt': true,
      'b/a/z.txt': false,
    });
  });

  it('supports ? and character classes', () => {
    check('file?.txt\n*.[oa]\n[!x]y', { 'file1.txt': true, 'file10.txt': false, 'm.o': true, 'm.a': true, 'm.c': false, ay: true, xy: false });
  });

  it('negation re-includes files, but not inside an ignored directory', () => {
    check('*.log\n!keep.log', { 'a.log': true, 'keep.log': false, 'x/keep.log': false });
    check('build/*\n!build/keep.txt', { 'build/a.txt': true, 'build/keep.txt': false });
    check('build/\n!build/keep.txt', { 'build/keep.txt': true });
  });

  it('handles CRLF and trailing spaces', () => {
    check('*.tmp  \r\nsecret.txt\r\n', { 'a.tmp': true, 'secret.txt': true });
  });

  it('empty rules ignore nothing', () => {
    check('', { 'a.txt': false });
  });
});

describe('secret detection', () => {
  it('flags file names', () => {
    expect(secretByName('.env')).toBe('env_file');
    expect(secretByName('config/.env.production')).toBe('env_file');
    expect(secretByName('.env.example')).toBeNull();
    expect(secretByName('certs/server.pem')).toBe('key_file');
    expect(secretByName('AuthKey_ABC.p8')).toBe('key_file');
    expect(secretByName('dist.p12')).toBe('key_file');
    expect(secretByName('id_rsa')).toBe('key_file');
    expect(secretByName('id_rsa_work')).toBe('key_file');
    expect(secretByName('id_rsa.pub')).toBeNull();
    expect(secretByName('index.html')).toBeNull();
  });

  it('flags token-like content', () => {
    expect(secretInText(`token = "ghp_${'a'.repeat(36)}"`)).toBe('github_token');
    expect(secretInText(`github_pat_${'A1_'.repeat(10)}`)).toBe('github_token');
    expect(secretInText('OPENAI=sk-proj-abcdefghijklmnopqrstuvwx')).toBe('api_key');
    expect(secretInText('key: AKIAIOSFODNN7EXAMPLE')).toBe('aws_key');
    expect(secretInText('-----BEGIN RSA PRIVATE KEY-----\nMII...')).toBe('private_key');
    expect(secretInText('-----BEGIN PRIVATE KEY-----')).toBe('private_key');
  });

  it('does not flag ordinary text', () => {
    expect(secretInText('a risk-free desk-top task-list, sk-short')).toBeNull();
    expect(secretInText('ghp_ is the prefix of GitHub tokens')).toBeNull();
    expect(secretInText('-----BEGIN PUBLIC KEY-----')).toBeNull();
  });

  it('checks names first and skips binary contents', () => {
    expect(detectSecret('.env', textFile('nothing'))).toBe('env_file');
    expect(detectSecret('a.bin', binaryFile(new TextEncoder().encode('AKIAIOSFODNN7EXAMPLE')))).toBeNull();
    expect(detectSecret('a.js', textFile('AKIAIOSFODNN7EXAMPLE'))).toBe('aws_key');
  });
});

/**
 * Warns before pushing files that look like secrets: by file name (`.env`, keys, certificates)
 * and by content (GitHub/OpenAI/AWS tokens, private keys). A warning, not a block.
 */
import { basename } from '../core/paths';
import type { ProjectFile } from '../core/types';

export type SecretReason = 'env_file' | 'key_file' | 'github_token' | 'api_key' | 'aws_key' | 'private_key';

/** English user-facing explanations, keyed by reason (the UI can translate by key). */
export const SECRET_MESSAGES: Record<SecretReason, string> = {
  env_file: 'Environment file: usually contains passwords and API keys.',
  key_file: 'Key or certificate file.',
  github_token: 'Contains something that looks like a GitHub token.',
  api_key: 'Contains something that looks like an API key.',
  aws_key: 'Contains something that looks like an AWS access key.',
  private_key: 'Contains a private key.',
};

/** Templates that are meant to be committed. */
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);

const CONTENT_PATTERNS: Array<[RegExp, SecretReason]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, 'private_key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'github_token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'github_token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'aws_key'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'api_key'],
];

/** Only the start of very large text files is scanned. */
const MAX_SCAN = 1024 * 1024;

export function secretByName(path: string): SecretReason | null {
  const name = basename(path).toLowerCase();
  if (name.startsWith('.env') && !ENV_TEMPLATES.has(name)) return 'env_file';
  if (/\.(pem|p8|p12|pfx)$/.test(name)) return 'key_file';
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(name) && !name.endsWith('.pub')) return 'key_file';
  return null;
}

export function secretInText(text: string): SecretReason | null {
  const sample = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  for (const [re, reason] of CONTENT_PATTERNS) if (re.test(sample)) return reason;
  return null;
}

/** The first reason `file` at `path` looks like a secret, or null. */
export function detectSecret(path: string, file: ProjectFile): SecretReason | null {
  return secretByName(path) ?? (file.text ? secretInText(file.content) : null);
}

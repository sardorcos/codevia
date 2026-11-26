/** Public surface of the GitHub integration (no UI). See docs/GITHUB.md. */
export * from './errors';
export { ALLOWED_HOSTS, githubRequest, type GitHubRequest, type GitHubResponse } from './http';
export * from './api';
export * from './auth';
export { getSecureStore, setSecureStore, createMemoryStore, type SecureStore } from './secure-store';
export * from './sync';
export { createGitignore, type GitignoreMatcher } from './gitignore';
export { SECRET_MESSAGES, detectSecret, type SecretReason } from './secrets';

/**
 * Secret storage for GitHub credentials.
 *
 * - iOS: the Keychain, through the app's own `CodeviaKeychain` plugin
 *   (ios/App/App/CodeviaKeychainPlugin.swift): this-device-only, never synced to iCloud.
 * - Web/dev/tests: memory only. Tokens are deliberately NOT persisted there: a reload signs out.
 *
 * Tokens never go to IndexedDB, localStorage, project files or logs.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

interface KeychainPlugin {
  get(options: { key: string }): Promise<{ value?: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

const Keychain = registerPlugin<KeychainPlugin>('CodeviaKeychain');

/** Keychain-backed store (native only). */
export const keychainStore: SecureStore = {
  async get(key) {
    const res = await Keychain.get({ key });
    return typeof res?.value === 'string' ? res.value : null;
  },
  set: (key, value) => Keychain.set({ key, value }),
  remove: (key) => Keychain.remove({ key }),
};

/** In-memory store: used on web/dev and in tests. Nothing survives a reload, by design. */
export function createMemoryStore(): SecureStore {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
  };
}

let current: SecureStore | null = null;

/** The store for this platform: Keychain on native, memory elsewhere. */
export function getSecureStore(): SecureStore {
  current ??= Capacitor.isNativePlatform() ? keychainStore : createMemoryStore();
  return current;
}

/** Replaces the store (tests). Pass null to go back to the platform default. */
export function setSecureStore(store: SecureStore | null): void {
  current = store;
}

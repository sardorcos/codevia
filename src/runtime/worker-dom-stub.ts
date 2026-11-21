/// <reference lib="webworker" />
// php-wasm's web build touches a few DOM globals (SDL/fullscreen helpers) that PHP itself never needs.
// A tiny inert stub lets it run inside a worker, where execution can be stopped without freezing the UI.
const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.document === 'undefined') {
  const noop = () => undefined;
  const el = (): Record<string, unknown> => ({
    style: {},
    addEventListener: noop,
    removeEventListener: noop,
    appendChild: noop,
    removeChild: noop,
    setAttribute: noop,
    getContext: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  });
  g.document = {
    addEventListener: noop,
    removeEventListener: noop,
    createElement: el,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    body: el(),
    documentElement: el(),
    hidden: true,
    visibilityState: 'hidden',
    fullscreenElement: null,
    fullscreenEnabled: false,
    exitFullscreen: noop,
    exitPointerLock: noop,
    title: '',
  };
}
if (typeof g.window === 'undefined') g.window = globalThis;
export {};

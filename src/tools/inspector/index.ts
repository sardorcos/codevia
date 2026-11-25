import type { Tool } from '../types';
import { InspectorPanel } from './panel';
import type { InspectorBridge } from './protocol';
import './inspector.css';

export { cssRuleText, findRuleLine, isPreviewMessage, withToken } from './protocol';
export type { InspectorBridge, InspectorEvent, InspectorRequest, PreviewMessage } from './protocol';

/**
 * Web inspector for the live preview: DOM tree, matched CSS rules, box model, network log, console.
 *
 * The app provides the bridge to the preview frame:
 * - `send(msg)`: `frame.contentWindow.postMessage({ ...msg, token: previewToken }, '*')` (no-op without a frame);
 * - `onMessage(handler)`: call `handler(e.data)` for every message from the preview frame that passes the token
 *   check and whose type starts with `inspect:` or equals `console`;
 * - optional `consoleHistory()` and `onPickChange(on)` (see protocol.ts).
 */
export function createInspectorTool(bridge: InspectorBridge): Tool {
  return {
    id: 'inspector',
    title: 'Инспектор',
    icon: 'search',
    needsProject: true,
    mount(root, ctx) {
      return new InspectorPanel(root, ctx, bridge).mount();
    },
  };
}

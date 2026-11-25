/**
 * GitHub tools: Account, Clone and Source control, plus the top-bar badge helpers.
 * The app mounts each Tool in a full-screen panel (phone) or a side pane (iPad); see ../types.ts.
 */
import './github.css';
import type { Tool } from '../types';
import { mountAccountTool } from './account';
import { mountCloneTool } from './clone';
import { mountSyncTool } from './sync-panel';

export { githubBadge, quickStatus, type QuickStatus } from './model';

export const githubTools: Tool[] = [
  {
    id: 'github-account',
    title: 'Аккаунт GitHub',
    icon: 'user',
    mount: (root, ctx) => mountAccountTool(root, ctx),
  },
  {
    id: 'github-clone',
    title: 'Клонировать с GitHub',
    icon: 'download',
    mount: (root, ctx) => mountCloneTool(root, ctx),
  },
  {
    id: 'github-sync',
    title: 'GitHub',
    icon: 'branch',
    needsProject: true,
    mount: (root, ctx) => mountSyncTool(root, ctx),
  },
];

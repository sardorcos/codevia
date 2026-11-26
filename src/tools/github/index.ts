/**
 * GitHub in one tool: the open project's source control, cloning and the account, as sections.
 * The app mounts it in a full-screen panel (phone) or a side pane (iPad); see ../types.ts.
 */
import './github.css';
import { t } from '../../i18n';
import { esc, icon } from '../../ui/dom';
import type { Tool, ToolContext } from '../types';
import { mountAccountTool } from './account';
import { mountCloneTool } from './clone';
import { mountSyncTool } from './sync-panel';

export { githubBadge, quickStatus, type QuickStatus } from './model';

/** The sections, also usable on their own (tests mount them directly). */
export const githubPanels: Tool[] = [
  { id: 'github-sync', title: 'Проект', icon: 'branch', needsProject: true, mount: (root, ctx) => mountSyncTool(root, ctx) },
  { id: 'github-clone', title: 'Клонировать', icon: 'download', mount: (root, ctx) => mountCloneTool(root, ctx) },
  { id: 'github-account', title: 'Аккаунт', icon: 'user', mount: (root, ctx) => mountAccountTool(root, ctx) },
];

function mountHub(root: HTMLElement, ctx: ToolContext): () => void {
  const sections = githubPanels.filter((p) => !p.needsProject || ctx.project());
  root.classList.add('gh-hub');
  root.innerHTML = `<div class="segmented gh-hub-tabs" role="tablist" aria-label="GitHub">${sections
    .map((p) => `<button role="tab" data-section="${p.id}" aria-selected="false">${icon(p.icon, 'sm')} ${esc(t(p.title))}</button>`)
    .join('')}</div><div class="gh-hub-body" role="tabpanel"></div>`;
  const body = root.querySelector<HTMLElement>('.gh-hub-body')!;
  let cleanup: void | (() => void);
  const show = (id: string) => {
    try {
      cleanup?.();
    } catch (e) {
      console.error(e);
    }
    body.replaceChildren();
    root.querySelectorAll<HTMLElement>('[data-section]').forEach((b) => {
      const on = b.dataset.section === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    cleanup = sections.find((p) => p.id === id)!.mount(body, ctx);
  };
  root.querySelectorAll<HTMLElement>('[data-section]').forEach((b) => b.addEventListener('click', () => b.classList.contains('active') || show(b.dataset.section!)));
  show(sections[0]!.id);
  return () => {
    try {
      cleanup?.();
    } catch (e) {
      console.error(e);
    }
  };
}

export const githubTool: Tool = {
  id: 'github',
  title: 'GitHub',
  icon: 'branch',
  group: 'GitHub',
  description: 'Клонирование, коммиты, ветки и pull request’ы',
  mount: mountHub,
};

export const githubTools: Tool[] = [githubTool];

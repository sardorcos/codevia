import { t } from '../i18n';
import type { Tool, ToolContext } from '../tools/types';
import { esc, icon } from './dom';
import { openSheet } from './sheet';

/**
 * Hosts feature tools (HTTP client, JSON, colours, Markdown, libraries, GitHub, inspector).
 * A tool lives in its own layer outside the app's re-rendered root, so app renders never destroy
 * its state. Phones get a full-screen panel; wide screens (iPad, Mac) dock it on the right.
 */
const registry: Tool[] = [];
let open: { tool: Tool; cleanup?: () => void; layer: HTMLElement } | null = null;

export function registerTools(tools: Tool[]): void {
  for (const tool of tools) if (!registry.some((x) => x.id === tool.id)) registry.push(tool);
}

export const registeredTools = (): readonly Tool[] => registry;
export const openToolId = (): string | null => open?.tool.id ?? null;

export function closeTool(): void {
  if (!open) return;
  try {
    open.cleanup?.();
  } catch (e) {
    console.error(e);
  }
  open.layer.remove();
  document.documentElement.classList.remove('tool-docked');
  open = null;
}

/** Shows the list of tools (those needing a project only when one is open). */
export async function pickTool(hasProject: boolean, makeContext: () => ToolContext): Promise<void> {
  const tools = registry.filter((x) => hasProject || !x.needsProject);
  if (!tools.length) return;
  const id = await openSheet<string>({
    title: t('Инструменты'),
    body: `<div class="list tool-list" role="list">${tools
      .map(
        (x) => `<button class="row-button" role="listitem" data-tool="${esc(x.id)}">${icon(x.icon)}<span class="row-main"><span class="row-title">${esc(t(x.title))}</span></span>${icon('chevron', 'sm')}</button>`,
      )
      .join('')}</div>`,
    onMount: (root, close) =>
      root.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tool]');
        if (b) close(b.dataset.tool);
      }),
  });
  const tool = tools.find((x) => x.id === id);
  if (tool) openTool(tool, makeContext());
}

export function openTool(tool: Tool, ctx: ToolContext): void {
  closeTool();
  const layer = document.createElement('section');
  layer.className = 'tool-layer';
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-label', t(tool.title));
  layer.innerHTML = `<header class="tool-head">
      <button class="icon-btn" data-tool-close aria-label="${esc(t('Закрыть'))}">${icon('close')}</button>
      <h2 class="tool-title">${esc(t(tool.title))}</h2><span class="tool-head-spacer"></span></header>
    <div class="tool-body"></div>`;
  document.body.append(layer);
  const body = layer.querySelector<HTMLElement>('.tool-body')!;
  layer.querySelector('[data-tool-close]')!.addEventListener('click', () => ctx.close());
  layer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('.sheet-layer')) ctx.close();
  });
  document.documentElement.classList.add('tool-docked');
  open = { tool, layer };
  try {
    const cleanup = tool.mount(body, ctx);
    if (open?.tool === tool) open.cleanup = cleanup || undefined;
  } catch (e) {
    body.innerHTML = `<p class="empty-state">${esc((e as Error)?.message ?? String(e))}</p>`;
  }
  (layer.querySelector('[data-tool-close]') as HTMLElement).focus({ preventScroll: true });
}

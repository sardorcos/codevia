import '../../styles/app.css';
import { esc } from '../../ui/dom';
import { setLang, t, type Lang } from '../../i18n';
import { TOOLS } from '../index';
import { createFakeContext } from './fake-context';

/**
 * Dev page (tools.html): mounts one tool with an in-memory project.
 * Query: ?tool=<id>&project=0 (no project)&width=375|420&lang=en|ru&active=<path>
 */

const params = new URLSearchParams(location.search);
setLang((params.get('lang') as Lang | null) ?? 'en');

async function injectSprite() {
  // Reuse the icon sprite of the real index.html instead of copying it.
  try {
    const html = await (await fetch('./index.html')).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const sprite = doc.querySelector('svg.icon-defs');
    if (sprite) document.body.prepend(document.importNode(sprite, true));
  } catch {
    /* icons missing: still usable */
  }
}

function start() {
  const app = document.getElementById('app')!;
  const id = params.get('tool') ?? TOOLS[0]!.id;
  const width = params.get('width');
  const link = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    return `?${p}`;
  };
  app.innerHTML = `<header class="toolbar" style="flex-wrap:wrap;padding:8px 12px">
      ${TOOLS.map((tool) => `<a class="chip ${tool.id === id ? 'active' : ''}" style="display:inline-flex;align-items:center;text-decoration:none" href="${esc(link({ tool: tool.id }))}">${esc(t(tool.title))}</a>`).join('')}
      <span class="grow"></span>
      <a class="chip" style="display:inline-flex;align-items:center;text-decoration:none" href="${esc(link({ width: width === '375' ? null : '375' }))}">${width === '375' ? 'full width' : '375 px'}</a>
      <a class="chip" style="display:inline-flex;align-items:center;text-decoration:none" href="${esc(link({ project: params.get('project') === '0' ? null : '0' }))}">${params.get('project') === '0' ? 'with project' : 'no project'}</a>
    </header>
    <main data-tool-host style="height:calc(100vh - 64px);${width ? `width:${Number(width)}px;border-right:1px solid var(--stroke);` : ''}"></main>`;
  const host = app.querySelector<HTMLElement>('[data-tool-host]')!;
  const tool = TOOLS.find((x) => x.id === id) ?? TOOLS[0]!;
  const { ctx, log } = createFakeContext({ project: params.get('project') === '0' ? null : undefined, activeFile: params.get('active') });
  (window as unknown as { __toolLog: typeof log }).__toolLog = log;
  if (tool.needsProject && !ctx.project()) {
    host.innerHTML = '<p class="empty-state">This tool needs a project.</p>';
    return;
  }
  tool.mount(host, ctx);
  document.title = `${t(tool.title)} · tools (dev)`;
}

void injectSprite().then(start);

import type { Files, Language, Project } from '../../core/types';
import { textFile } from '../../core/types';
import { confirmSheet, promptSheet } from '../../ui/sheet';
import { toast } from '../../ui/dom';
import type { ToolContext } from '../types';

/**
 * An in-memory ToolContext for the dev page (tools.html) and tests: one project, writes applied to it,
 * snapshots recorded in `log`. Not used by the app.
 */
export interface FakeContextLog {
  writes: Array<{ files: string[]; remove: string[]; snapshotLabel?: string }>;
  opened: Array<{ path: string; line?: number }>;
  external: string[];
  toasts: Array<{ message: string; kind?: string }>;
  shared: string[];
}

export interface FakeContextOptions {
  project?: Project | null;
  activeFile?: string | null;
  confirm?: ToolContext['confirm'];
  prompt?: ToolContext['prompt'];
  onClose?: () => void;
}

export function sampleProject(): Project {
  const now = new Date().toISOString();
  const files: Files = {
    'index.html': textFile(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sample</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1 style="color: #40c8f6">Hello</h1>
  <svg width="20" height="20"><rect width="20" height="20" fill="#ff8a92"/></svg>
  <script src="app.js"></script>
</body>
</html>
`),
    'style.css': textFile(`body { background: #0c0e12; color: #f2f4f7; font-family: system-ui; }
a { color: #40c8f6; }
.card { border: 1px solid rgba(255, 255, 255, 0.1); box-shadow: 0 2px 8px hsl(220 30% 5% / 50%); }
.warn { color: orange; }
`),
    'app.js': textFile(`console.log('hello');\n`),
    'data.json': textFile(JSON.stringify({ name: 'Codevia', version: 1, tags: ['editor', 'ios'], nested: { ok: true, none: null, list: Array.from({ length: 250 }, (_, i) => ({ id: i, label: `item ${i}` })) } }, null, 2)),
    'README.md': textFile(`# Sample project

A **Markdown** file with a [link](https://example.com), a [relative link](docs/guide.md) and an image:

![pixel](img/pixel.png)

## Tasks

- [x] Write the README
- [ ] Ship it

## Table

| Tool | Status |
|------|--------|
| HTTP | ok |
| JSON | ok |

\`\`\`js
const answer = 42;
\`\`\`
`),
    'docs/guide.md': textFile('# Guide\n\nBack to the [README](../README.md).\n'),
    // 2×2 PNG: red, green / blue, white
    'img/pixel.png': {
      text: false,
      data: Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP4z8DAcAKIGf4DAQAd/wXE3IBfUQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)),
    },
  };
  return {
    id: 'sample',
    name: 'Sample',
    language: 'web',
    createdAt: now,
    updatedAt: now,
    folder: 'Sample',
    fileCount: Object.keys(files).length,
    size: 0,
    entry: 'index.html',
    schema: 2,
    files,
  };
}

export function createFakeContext(opts: FakeContextOptions = {}): { ctx: ToolContext; log: FakeContextLog; project: () => Project | null } {
  let project: Project | null = opts.project === undefined ? sampleProject() : opts.project;
  const log: FakeContextLog = { writes: [], opened: [], external: [], toasts: [], shared: [] };
  const ctx: ToolContext = {
    project: () => project,
    activeFile: () => opts.activeFile ?? null,
    async writeFiles(files, o) {
      if (!project) throw new Error('No project');
      const next = { ...project.files, ...files };
      for (const p of o?.remove ?? []) delete next[p];
      project = { ...project, files: next, updatedAt: new Date().toISOString() };
      log.writes.push({ files: Object.keys(files), remove: o?.remove ?? [], snapshotLabel: o?.snapshotLabel });
    },
    async replaceAllFiles(files, label) {
      if (!project) throw new Error('No project');
      project = { ...project, files };
      log.writes.push({ files: Object.keys(files), remove: [], snapshotLabel: label });
    },
    async updateMeta(patch) {
      if (project) project = { ...project, ...patch };
    },
    async createProject(name: string, language: Language, files: Files) {
      project = { ...sampleProject(), name, language, files };
    },
    openFile(path, line) {
      log.opened.push({ path, line });
    },
    toast(message, kind) {
      log.toasts.push({ message, kind });
      toast(message, kind);
    },
    confirm: opts.confirm ?? ((o) => confirmSheet({ title: o.title, message: o.message ?? '', confirm: o.ok, danger: o.destructive })),
    prompt: opts.prompt ?? ((o) => promptSheet({ title: o.title, label: o.label, value: o.value, confirm: o.ok, mono: true })),
    async share(_data, filename) {
      log.shared.push(filename);
    },
    openExternal(url) {
      log.external.push(url);
    },
    haptic() {},
    close() {
      opts.onClose?.();
    },
  };
  return { ctx, log, project: () => project };
}

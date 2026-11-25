import { describe, expect, it } from 'vitest';
import { GALLERY, galleryFiles } from '../../src/core/gallery';
import { compileModule } from '../../src/runtime/js-core';

describe('project gallery', () => {
  it('has unique ids and every library file referenced by the HTML is included', async () => {
    expect(new Set(GALLERY.map((g) => g.id)).size).toBe(GALLERY.length);
    for (const tpl of GALLERY) {
      const files = await galleryFiles(tpl, async () => new TextEncoder().encode('/* lib */'));
      const html = Object.entries(files)
        .filter(([p]) => /\.(html|php)$/.test(p))
        .map(([, f]) => (f.text ? f.content : ''))
        .join('\n');
      for (const ref of html.matchAll(/(?:src|href)="(libs\/[^"]+)"/g)) expect(files, `${tpl.id}: ${ref[1]}`).toHaveProperty([ref[1]!]);
      for (const ref of html.matchAll(/(?:src|href)="((?!libs\/|#|https?:)[^"]+\.(?:js|css|json))"/g)) expect(files, `${tpl.id}: ${ref[1]}`).toHaveProperty([ref[1]!]);
    }
  });

  it('script files parse', () => {
    for (const tpl of GALLERY) {
      for (const [path, f] of Object.entries(tpl.files())) {
        if (f.text && /\.(m?js|ts)$/.test(path)) expect(() => compileModule(path, f.content), `${tpl.id}/${path}`).not.toThrow();
      }
    }
  });
});

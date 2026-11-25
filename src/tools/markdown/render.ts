import { Marked, type Tokens } from 'marked';
import createDOMPurify, { type DOMPurify } from 'dompurify';
import { isExternalRef } from '../../core/paths';
import { esc } from '../../ui/dom';

/**
 * Markdown → safe HTML: marked (GitHub-flavoured: tables, task lists, fenced code, autolinks), then
 * DOMPurify with a strict profile, because the result is shown inside the app's own document.
 * No scripts, event handlers, styles, forms, frames or SVG survive; links keep their href (the host
 * decides how to open them) and relative images can be resolved to data: URLs of project files.
 */

export interface MarkdownOptions {
  /** Resolves a relative image `src` (as written) to a URL to show, e.g. a data: URL; null keeps it. */
  resolveImage?: (src: string) => string | null;
  /** Prefix of heading ids (default `md-`), so they never clash with the app's own ids. */
  idPrefix?: string;
}

let opts: MarkdownOptions = {};
let slugs = new Map<string, number>();

/** GitHub-style heading slug: lower case, letters/digits kept (any script), spaces → dashes. */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/&[a-z0-9#]+;/gi, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s+/g, '-') || 'section'
  );
}

function uniqueSlug(text: string): string {
  const base = slugify(text);
  const n = slugs.get(base) ?? 0;
  slugs.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    heading(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, { tokens, depth }: Tokens.Heading) {
      const inner = this.parser.parseInline(tokens);
      const id = `${opts.idPrefix ?? 'md-'}${uniqueSlug(inner)}`;
      return `<h${depth} id="${esc(id)}">${inner}</h${depth}>\n`;
    },
    code({ text, lang }: Tokens.Code) {
      const language = (lang ?? '').trim().split(/\s+/)[0] ?? '';
      return `<pre><code${language ? ` class="language-${esc(language)}"` : ''}>${esc(text)}</code></pre>\n`;
    },
  },
});

let purifier: DOMPurify | null = null;

function getPurifier(): DOMPurify | null {
  if (purifier) return purifier;
  if (typeof window === 'undefined') return null;
  const p = createDOMPurify(window);
  if (!p.isSupported) return null;
  p.addHook('uponSanitizeElement', (node, data) => {
    // Task-list checkboxes are the only inputs allowed, and they are read-only.
    if (data.tagName === 'input' && (node as Element).getAttribute('type') !== 'checkbox') node.parentNode?.removeChild(node);
  });
  p.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (el.tagName === 'A' && el.hasAttribute('href')) {
      el.setAttribute('rel', 'noopener noreferrer');
      el.removeAttribute('target');
    } else if (el.tagName === 'INPUT') {
      el.setAttribute('disabled', '');
    } else if (el.tagName === 'IMG') {
      el.setAttribute('loading', 'lazy');
      const src = el.getAttribute('src') ?? '';
      if (src && !isExternalRef(src) && opts.resolveImage) {
        const resolved = opts.resolveImage(src);
        if (resolved && /^(data:image\/|blob:)/i.test(resolved)) el.setAttribute('src', resolved);
      }
    }
  });
  purifier = p;
  return p;
}

const CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base', 'template', 'dialog'],
  FORBID_ATTR: ['style', 'srcset', 'formaction', 'autofocus', 'tabindex'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: true,
};

/** Renders Markdown to sanitized HTML (synchronous). */
export function renderMarkdown(md: string, options: MarkdownOptions = {}): string {
  opts = options;
  slugs = new Map();
  try {
    const html = marked.parse(md, { async: false }) as string;
    const p = getPurifier();
    // Without a DOM (never the case in the app) nothing unsanitized is ever returned.
    if (!p) return `<pre>${esc(md)}</pre>`;
    return p.sanitize(html, CONFIG) as string;
  } finally {
    opts = {};
  }
}

export interface Heading {
  level: number;
  text: string;
  id: string;
}

/** Headings of rendered HTML (for an outline). */
export function headingsOf(root: ParentNode): Heading[] {
  return [...root.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]')].map((h) => ({
    level: Number(h.tagName[1]),
    text: h.textContent ?? '',
    id: h.id,
  }));
}

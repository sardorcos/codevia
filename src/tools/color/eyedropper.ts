import { esc, icon } from '../../ui/dom';
import { t } from '../../i18n';
import type { RGBA } from './convert';

/**
 * Picks colours from an image on a canvas. One finger (or the mouse) picks, with a magnifier loupe;
 * two fingers pan and pinch-zoom; the wheel and the +/− buttons zoom. Pixels are read from a copy of
 * the image at up to 2048 px on its longest side.
 */

const MAX_SIDE = 2048;
const LOUPE_PX = 11; // source pixels across the loupe
const LOUPE_SIZE = 121; // CSS px

export interface ImagePickerHandle {
  load(src: Blob): Promise<void>;
  destroy(): void;
}

export function mountImagePicker(host: HTMLElement, onPick: (c: RGBA, final: boolean) => void): ImagePickerHandle {
  host.innerHTML = `<div class="tool-eye">
    <div class="tool-eye-stage">
      <canvas class="tool-eye-canvas" aria-label="${esc(t('Изображение: коснитесь пикселя, чтобы взять цвет; двумя пальцами — масштаб'))}" role="img"></canvas>
      <canvas class="tool-eye-loupe" width="${LOUPE_SIZE}" height="${LOUPE_SIZE}" hidden aria-hidden="true"></canvas>
    </div>
    <div class="tool-bar">
      <button type="button" class="icon-btn" data-eye="out" aria-label="${esc(t('Уменьшить'))}">${icon('minus', 'sm')}</button>
      <button type="button" class="icon-btn" data-eye="in" aria-label="${esc(t('Увеличить'))}">${icon('plus', 'sm')}</button>
      <button type="button" class="btn tiny ghost" data-eye="fit">${esc(t('Вписать'))}</button>
      <span class="tool-muted" data-eye-info></span>
    </div>
  </div>`;
  const stage = host.querySelector<HTMLElement>('.tool-eye-stage')!;
  const canvas = host.querySelector<HTMLCanvasElement>('.tool-eye-canvas')!;
  const loupe = host.querySelector<HTMLCanvasElement>('.tool-eye-loupe')!;
  const info = host.querySelector<HTMLElement>('[data-eye-info]')!;
  const g = canvas.getContext('2d')!;
  const lg = loupe.getContext('2d')!;

  let src: HTMLCanvasElement | null = null;
  let pixels: Uint8ClampedArray | null = null;
  let iw = 0;
  let ih = 0;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let cw = 0;
  let ch = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; mx: number; my: number } | null = null;
  let picking = false;

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (!src) return;
    g.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * tx, dpr * ty);
    g.imageSmoothingEnabled = scale < 3;
    g.drawImage(src, 0, 0);
    info.textContent = `${iw}×${ih} · ${Math.round(scale * 100)}%`;
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const nw = Math.max(1, Math.round(r.width));
    const nh = Math.max(1, Math.round(r.height));
    if (nw === cw && nh === ch) return;
    const first = !cw;
    cw = nw;
    ch = nh;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    if (first) fit();
    else draw();
  }

  function fit() {
    if (!iw || !cw) return draw();
    scale = Math.min(cw / iw, ch / ih, 8);
    tx = (cw - iw * scale) / 2;
    ty = (ch - ih * scale) / 2;
    draw();
  }

  function zoomAt(factor: number, x: number, y: number) {
    const next = Math.min(64, Math.max(0.05, scale * factor));
    tx = x - ((x - tx) * next) / scale;
    ty = y - ((y - ty) * next) / scale;
    scale = next;
    draw();
  }

  const local = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function pixelAt(x: number, y: number): RGBA | null {
    if (!pixels) return null;
    const px = Math.floor((x - tx) / scale);
    const py = Math.floor((y - ty) / scale);
    if (px < 0 || py < 0 || px >= iw || py >= ih) return null;
    const i = (py * iw + px) * 4;
    return { r: pixels[i]!, g: pixels[i + 1]!, b: pixels[i + 2]!, a: Math.round((pixels[i + 3]! / 255) * 1000) / 1000 };
  }

  function showLoupe(x: number, y: number) {
    if (!src) return;
    const px = Math.floor((x - tx) / scale);
    const py = Math.floor((y - ty) / scale);
    const half = Math.floor(LOUPE_PX / 2);
    const cell = LOUPE_SIZE / LOUPE_PX;
    lg.imageSmoothingEnabled = false;
    lg.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    lg.fillStyle = '#20252d';
    lg.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    lg.drawImage(src, px - half, py - half, LOUPE_PX, LOUPE_PX, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
    lg.strokeStyle = '#ffffff';
    lg.lineWidth = 2;
    lg.strokeRect(half * cell, half * cell, cell, cell);
    lg.strokeStyle = '#000000';
    lg.lineWidth = 1;
    lg.strokeRect(half * cell - 1.5, half * cell - 1.5, cell + 3, cell + 3);
    loupe.hidden = false;
    // Above the finger, kept inside the stage.
    const left = Math.min(cw - LOUPE_SIZE, Math.max(0, x - LOUPE_SIZE / 2));
    const top = y - LOUPE_SIZE - 28 < 0 ? Math.min(ch - LOUPE_SIZE, y + 28) : y - LOUPE_SIZE - 28;
    loupe.style.transform = `translate(${left}px, ${top}px)`;
  }

  function pickAt(x: number, y: number, final: boolean) {
    const c = pixelAt(x, y);
    showLoupe(x, y);
    if (c) onPick(c, final);
  }

  const down = (e: PointerEvent) => {
    if (!src) return;
    canvas.setPointerCapture?.(e.pointerId);
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2) {
      picking = false;
      loupe.hidden = true;
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    } else if (pointers.size === 1) {
      picking = true;
      pickAt(p.x, p.y, false);
    }
    e.preventDefault();
  };

  const move = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      tx += mx - pinch.mx;
      ty += my - pinch.my;
      if (pinch.d > 0) zoomAt(d / pinch.d, mx, my);
      else draw();
      pinch = { d, mx, my };
    } else if (picking) pickAt(p.x, p.y, false);
    e.preventDefault();
  };

  const up = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    const p = local(e);
    pointers.delete(e.pointerId);
    if (picking && pointers.size === 0) {
      const c = pixelAt(p.x, p.y);
      if (c) onPick(c, true);
    }
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      picking = false;
      loupe.hidden = true;
    }
  };

  const wheel = (e: WheelEvent) => {
    if (!src) return;
    e.preventDefault();
    const p = local(e);
    zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
  };

  const onButtons = (e: MouseEvent) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-eye]')?.dataset.eye;
    if (act === 'in') zoomAt(1.5, cw / 2, ch / 2);
    else if (act === 'out') zoomAt(1 / 1.5, cw / 2, ch / 2);
    else if (act === 'fit') fit();
  };

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  host.addEventListener('click', onButtons);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  ro?.observe(stage);
  resize();

  return {
    async load(blob: Blob) {
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        await img.decode();
        let w = img.naturalWidth || 512;
        let h = img.naturalHeight || 512;
        const k = Math.min(1, MAX_SIDE / Math.max(w, h));
        w = Math.max(1, Math.round(w * k));
        h = Math.max(1, Math.round(h * k));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const cg = c.getContext('2d', { willReadFrequently: true })!;
        cg.drawImage(img, 0, 0, w, h);
        pixels = cg.getImageData(0, 0, w, h).data;
        src = c;
        iw = w;
        ih = h;
        resize();
        fit();
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    destroy() {
      ro?.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('wheel', wheel);
      host.removeEventListener('click', onButtons);
      src = null;
      pixels = null;
      host.innerHTML = '';
    },
  };
}

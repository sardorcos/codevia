import { esc, icon } from '../../ui/dom';
import { openSheet } from '../../ui/sheet';
import { t, tc, plural } from '../../i18n';
import { mimeOf } from '../../core/paths';
import type { Tool, ToolContext } from '../types';
import { copyText, fileBytes, loadStored, pickProjectFile, saveStored, uid } from '../shared';
import {
  hslToRgb, nearestNamed, parseColor, readableOn, rgbToHsl, roundRgba, toHex, toHslString, toHsvString, toNamed, toRgbString, wcag,
  type HSLA, type RGBA,
} from './convert';
import { replaceColorInFiles, scanProjectColors, type ColorUsage } from './scan';
import { mountImagePicker, type ImagePickerHandle } from './eyedropper';
import '../tools.css';

type Field = 'hex' | 'hex8' | 'rgb' | 'hsl' | 'hsv' | 'name';
const PALETTE_MAX = 40;

interface EyeDropperCtor {
  new (): { open(): Promise<{ sRGBHex: string }> };
}

const isImagePath = (p: string) => /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(p);

function mount(root: HTMLElement, ctx: ToolContext): () => void {
  const id = uid('color');
  const saved = loadStored<{ color?: string; fg?: string; bg?: string }>('color.state', {});
  let color: RGBA = parseColor(saved.color ?? '') ?? { r: 64, g: 200, b: 246, a: 1 };
  let hsl: HSLA = rgbToHsl(color);
  let palette: string[] = loadStored<string[]>('color.palette', []).filter((x) => typeof x === 'string' && parseColor(x)).slice(0, PALETTE_MAX);
  let editPalette = false;
  let usages: ColorUsage[] | null = null;
  let target: ColorUsage | null = null;
  let picker: ImagePickerHandle | null = null;
  const fgBg = { fg: saved.fg ?? '#f2f4f7', bg: saved.bg ?? '#0c0e12' };
  const EyeDropper = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;

  const fields: Array<[Field, string]> = [
    ['hex', 'HEX'],
    ['hex8', 'HEX8'],
    ['rgb', 'RGB(A)'],
    ['hsl', 'HSL(A)'],
    ['hsv', 'HSV'],
    ['name', t('Имя CSS')],
  ];

  root.classList.add('tool-root', 'tool-color');
  root.innerHTML = `
    <div class="tool-color-cols">
      <section class="tool-color-main" aria-label="${esc(t('Цвет'))}">
        <div class="tool-swatch" data-swatch><div class="tool-swatch-fill" data-fill><span data-swatch-text></span></div></div>
        <div class="tool-bar">
          <label class="tool-native-color" title="${esc(t('Системная палитра'))}">
            <input type="color" data-native aria-label="${esc(t('Системная палитра'))}">
          </label>
          ${EyeDropper ? `<button type="button" class="btn tiny secondary" data-act="eyedropper">${icon('pipette', 'sm')}<span>${esc(t('Пипетка'))}</span></button>` : ''}
          <button type="button" class="btn tiny secondary" data-act="project-image" ${ctx.project() ? '' : 'disabled'}>${icon('image', 'sm')}<span>${esc(t('Из проекта'))}</span></button>
          <label class="btn tiny secondary tool-file-btn">${icon('upload', 'sm')}<span>${esc(t('Фото'))}</span>
            <input type="file" accept="image/*" data-photo class="visually-hidden"></label>
          <button type="button" class="btn tiny secondary" data-act="save-color">${icon('plus', 'sm')}<span>${esc(t('В палитру'))}</span></button>
        </div>
        <div class="tool-sliders">
          ${(['h', 's', 'l', 'a'] as const)
            .map((k) => {
              const label = { h: t('Тон'), s: t('Насыщенность'), l: t('Светлота'), a: t('Прозрачность') }[k];
              const max = k === 'h' ? 360 : 100;
              return `<label class="tool-slider" for="${id}-${k}"><span class="field-label">${esc(label)}</span>
                <input id="${id}-${k}" type="range" min="0" max="${max}" step="${k === 'h' ? 1 : 0.5}" data-slider="${k}">
                <output class="mono" data-out="${k}"></output></label>`;
            })
            .join('')}
        </div>
        <div class="tool-formats">
          ${fields
            .map(
              ([f, label]) => `<div class="tool-format">
              <label class="field-label" for="${id}-${f}">${esc(label)}</label>
              <input id="${id}-${f}" class="text-input mono" data-field="${f}" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off">
              <button type="button" class="icon-btn" data-copy="${f}" aria-label="${esc(t('Копировать {format}', { format: label }))}">${icon('copy', 'sm')}</button>
            </div>`,
            )
            .join('')}
        </div>
        <div class="tool-eye-host" data-eye-host hidden></div>
      </section>
      <section class="tool-color-side">
        <h3 class="tool-h">${esc(t('Палитра'))}
          <button type="button" class="btn tiny ghost" data-act="edit-palette" aria-pressed="false">${esc(tc('edit', 'Изменить'))}</button></h3>
        <div class="tool-palette" data-palette></div>

        <h3 class="tool-h">${esc(t('Цвета проекта'))}
          <button type="button" class="btn tiny ghost" data-act="scan" ${ctx.project() ? '' : 'disabled'}>${icon('refresh', 'sm')}<span>${esc(t('Найти'))}</span></button></h3>
        <div class="tool-target" data-target hidden></div>
        <div class="tool-palette" data-usages><p class="tool-muted">${esc(ctx.project() ? t('Нажмите «Найти», чтобы собрать цвета из CSS и HTML.') : t('Откройте проект, чтобы увидеть его цвета.'))}</p></div>

        <h3 class="tool-h">${esc(t('Контраст (WCAG)'))}</h3>
        <div class="tool-contrast">
          <div class="tool-format">
            <label class="field-label" for="${id}-fg">${esc(t('Текст'))}</label>
            <input id="${id}-fg" class="text-input mono" data-cc="fg" value="${esc(fgBg.fg)}" autocapitalize="off" autocorrect="off" spellcheck="false">
            <button type="button" class="icon-btn" data-use="fg" aria-label="${esc(t('Взять текущий цвет'))}">${icon('pipette', 'sm')}</button>
          </div>
          <div class="tool-format">
            <label class="field-label" for="${id}-bg">${esc(t('Фон'))}</label>
            <input id="${id}-bg" class="text-input mono" data-cc="bg" value="${esc(fgBg.bg)}" autocapitalize="off" autocorrect="off" spellcheck="false">
            <button type="button" class="icon-btn" data-use="bg" aria-label="${esc(t('Взять текущий цвет'))}">${icon('pipette', 'sm')}</button>
          </div>
          <button type="button" class="btn tiny ghost" data-act="swap">${icon('refresh', 'sm')}<span>${esc(t('Поменять местами'))}</span></button>
          <div class="tool-cc-sample" data-cc-sample><strong>${esc(t('Крупный текст'))}</strong><span>${esc(t('Обычный текст для проверки читаемости.'))}</span></div>
          <div class="tool-cc-result" data-cc-result aria-live="polite"></div>
        </div>
      </section>
    </div>`;

  const q = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const fieldEl = (f: Field) => q<HTMLInputElement>(`[data-field="${f}"]`);

  const formats = (c: RGBA): Record<Field, string> => ({
    hex: toHex(c, 'never'),
    hex8: toHex(c, 'always'),
    rgb: toRgbString(c),
    hsl: toHslString(c),
    hsv: toHsvString(c),
    name: toNamed(c) ?? '',
  });

  const persist = () => saveStored('color.state', { color: toHex(color), fg: fgBg.fg, bg: fgBg.bg });

  function update(source: Field | 'slider' | 'native' | 'other') {
    const c = roundRgba(color);
    const f = formats(c);
    for (const [k] of fields) {
      if (k === source) continue;
      const el = fieldEl(k);
      el.value = f[k];
      el.removeAttribute('aria-invalid');
    }
    const near = nearestNamed(c);
    fieldEl('name').placeholder = f.name ? '' : `≈ ${near.name}`;
    const css = toRgbString(c);
    q('[data-fill]').style.background = css;
    const text = q('[data-swatch-text]');
    text.textContent = c.a < 1 ? f.hex8 : f.hex;
    text.style.color = c.a < 0.5 ? '#f2f4f7' : readableOn(c);
    if (source !== 'native') q<HTMLInputElement>('[data-native]').value = f.hex;
    if (source !== 'slider') {
      for (const k of ['h', 's', 'l'] as const) q<HTMLInputElement>(`[data-slider="${k}"]`).value = String(Math.round(hsl[k] * 2) / 2);
      q<HTMLInputElement>('[data-slider="a"]').value = String(Math.round(c.a * 200) / 2);
    }
    q('[data-out="h"]').textContent = `${Math.round(hsl.h)}°`;
    q('[data-out="s"]').textContent = `${Math.round(hsl.s)}%`;
    q('[data-out="l"]').textContent = `${Math.round(hsl.l)}%`;
    q('[data-out="a"]').textContent = `${Math.round(c.a * 100)}%`;
    // Slider tracks show the effect of each channel.
    const H = Math.round(hsl.h);
    const S = Math.round(hsl.s);
    const L = Math.round(hsl.l);
    q('[data-slider="s"]').style.background = `linear-gradient(to right, hsl(${H} 0% ${L}%), hsl(${H} 100% ${L}%))`;
    q('[data-slider="l"]').style.background = `linear-gradient(to right, #000, hsl(${H} ${S}% 50%), #fff)`;
    q('[data-slider="a"]').style.setProperty('--tool-alpha-color', toHex({ ...c, a: 1 }));
    renderTarget();
    persist();
  }

  function setColor(c: RGBA, source: Field | 'slider' | 'native' | 'other') {
    color = c;
    const next = rgbToHsl(c);
    // Grey has no hue, black and white no saturation either: keep those sliders where they were.
    const extreme = next.l <= 0.5 || next.l >= 99.5;
    hsl = extreme ? { ...next, h: hsl.h, s: hsl.s } : next.s < 0.5 ? { ...next, h: hsl.h } : next;
    update(source);
  }

  // ---------- palette ----------
  function renderPalette() {
    const box = q('[data-palette]');
    q('[data-act="edit-palette"]').setAttribute('aria-pressed', String(editPalette));
    q('[data-act="edit-palette"]').textContent = editPalette ? t('Готово') : tc('edit', 'Изменить');
    box.innerHTML = palette.length
      ? palette
          .map(
            (hex, i) => `<button type="button" class="tool-chip-swatch ${editPalette ? 'editing' : ''}" data-pal="${i}" aria-label="${esc(editPalette ? t('Удалить {color}', { color: hex }) : hex)}">
              <span class="tool-dot" style="background:${esc(hex)}"></span><span class="mono">${esc(hex)}</span>${editPalette ? icon('close', 'xs') : ''}</button>`,
          )
          .join('')
      : `<p class="tool-muted">${esc(t('Сохраняйте цвета кнопкой «В палитру».'))}</p>`;
  }

  // ---------- project colours ----------
  function renderUsages() {
    const box = q('[data-usages]');
    if (!usages) return;
    box.innerHTML = usages.length
      ? usages
          .slice(0, 120)
          .map(
            (u, i) => `<button type="button" class="tool-chip-swatch ${target?.key === u.key ? 'selected' : ''}" data-use-i="${i}" aria-label="${esc(`${u.key}, ${plural(u.count, { one: '{count} раз', few: '{count} раза', many: '{count} раз' })}`)}">
              <span class="tool-dot" style="background:${esc(u.key)}"></span><span class="mono">${esc(u.key)}</span><span class="tool-count-badge">${u.count}</span></button>`,
          )
          .join('')
      : `<p class="tool-muted">${esc(t('В CSS и HTML проекта цветов не найдено.'))}</p>`;
  }

  function renderTarget() {
    const box = q('[data-target]');
    if (!target) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const next = toHex(roundRgba(color));
    box.innerHTML = `<div class="tool-target-row">
        <span class="tool-dot lg" style="background:${esc(target.key)}"></span>${icon('chevron', 'sm')}<span class="tool-dot lg" style="background:${esc(next)}"></span>
        <span class="mono">${esc(target.key)} → ${esc(next)}</span>
      </div>
      <p class="tool-muted">${esc(t('Измените цвет выше, затем замените все {count} вхождений в {files}.', { count: target.count, files: plural(target.files.length, { one: '{count} файле', few: '{count} файлах', many: '{count} файлах' }) }))}</p>
      <div class="btn-row">
        <button type="button" class="btn tiny primary" data-act="replace">${esc(t('Заменить везде'))}</button>
        <button type="button" class="btn tiny secondary" data-act="usage-files">${esc(t('Где используется'))}</button>
        <button type="button" class="btn tiny ghost" data-act="untarget">${esc(t('Отмена'))}</button>
      </div>`;
  }

  function scan() {
    const project = ctx.project();
    if (!project) return;
    usages = scanProjectColors(project.files);
    renderUsages();
  }

  async function replaceAll() {
    const project = ctx.project();
    if (!project || !target) return;
    const next = roundRgba(color);
    const from = target.key;
    const to = toHex(next);
    if (from === to) {
      ctx.toast(t('Выберите другой цвет'), 'info');
      return;
    }
    const { changed, count } = replaceColorInFiles(project.files, target.rgba, next);
    if (!count) {
      ctx.toast(t('Вхождений не найдено'), 'info');
      return;
    }
    if (!(await ctx.confirm({ title: t('Заменить {from} на {to}?', { from, to }), message: t('Вхождений: {count}. Перед заменой будет создана версия проекта.', { count }), ok: t('Заменить') }))) return;
    await ctx.writeFiles(changed, { snapshotLabel: t('Перед заменой цвета {from}', { from }) });
    ctx.haptic('success');
    ctx.toast(t('Заменено вхождений: {count}', { count }), 'success');
    target = null;
    scan();
    renderTarget();
  }

  async function showUsageFiles() {
    if (!target) return;
    const u = target;
    await openSheet({
      title: u.key,
      body: `<p class="tool-muted">${esc(Object.entries(u.variants).map(([raw, n]) => `${raw} × ${n}`).join(', '))}</p>
        <div class="menu-list">${u.files.map((p) => `<button class="menu-item" data-open="${esc(p)}">${icon('file')}<span class="mono truncate">${esc(p)}</span></button>`).join('')}</div>`,
      onMount: (sheet, close) =>
        sheet.addEventListener('click', (e) => {
          const p = (e.target as HTMLElement).closest<HTMLElement>('[data-open]')?.dataset.open;
          if (p) {
            close();
            ctx.openFile(p);
          }
        }),
    });
  }

  // ---------- contrast ----------
  function renderContrast() {
    const fg = parseColor(fgBg.fg);
    const bg = parseColor(fgBg.bg);
    q('[data-cc="fg"]').toggleAttribute('aria-invalid', !fg);
    q('[data-cc="bg"]').toggleAttribute('aria-invalid', !bg);
    const out = q('[data-cc-result]');
    if (!fg || !bg) {
      out.textContent = t('Введите два цвета');
      return;
    }
    const sample = q('[data-cc-sample]');
    sample.style.color = toRgbString(fg);
    sample.style.background = toRgbString(bg);
    const r = wcag(fg, bg);
    const badge = (ok: boolean, label: string) => `<span class="tool-badge-wcag ${ok ? 'pass' : 'fail'}">${ok ? icon('check', 'xs') : icon('close', 'xs')}${esc(label)}</span>`;
    out.innerHTML = `<div class="tool-cc-ratio mono">${(Math.floor(r.ratio * 100) / 100).toFixed(2)}:1</div>
      <div class="tool-cc-badges">
        ${badge(r.aa, t('AA текст'))}${badge(r.aaLarge, t('AA крупный'))}${badge(r.aaa, t('AAA текст'))}${badge(r.aaaLarge, t('AAA крупный'))}
      </div>`;
    persist();
  }

  // ---------- image eyedropper ----------
  async function loadImage(blob: Blob) {
    const host = q('[data-eye-host]');
    host.hidden = false;
    picker ??= mountImagePicker(host, (c, final) => {
      setColor(c, 'other');
      if (final) ctx.haptic('light');
    });
    try {
      await picker.load(blob);
      host.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    } catch {
      ctx.toast(t('Не удалось открыть изображение'), 'error');
    }
  }

  // ---------- events ----------
  const onInput = (e: Event) => {
    const el = e.target as HTMLInputElement;
    const f = el.dataset.field as Field | undefined;
    if (f) {
      const c = parseColor(el.value);
      el.toggleAttribute('aria-invalid', !!el.value.trim() && !c);
      if (c) setColor(c, f);
      return;
    }
    const s = el.dataset.slider as keyof HSLA | undefined;
    if (s) {
      const v = Number(el.value);
      if (s === 'a') color = { ...color, a: v / 100 };
      else {
        hsl = { ...hsl, [s]: v };
        color = { ...hslToRgb({ ...hsl, a: color.a }) };
      }
      hsl.a = color.a;
      return update('slider');
    }
    if (el.matches('[data-native]')) {
      const c = parseColor(el.value);
      if (c) setColor({ ...c, a: color.a }, 'native');
      return;
    }
    const cc = el.dataset.cc as 'fg' | 'bg' | undefined;
    if (cc) {
      fgBg[cc] = el.value;
      renderContrast();
    }
  };

  const onChange = async (e: Event) => {
    const el = e.target as HTMLInputElement;
    if (el.matches('[data-photo]') && el.files?.[0]) {
      await loadImage(el.files[0]);
      el.value = '';
    }
  };

  const onClick = async (e: MouseEvent) => {
    const el = e.target as HTMLElement;
    const copyF = el.closest<HTMLElement>('[data-copy]')?.dataset.copy as Field | undefined;
    if (copyF) {
      const v = fieldEl(copyF).value || formats(color)[copyF];
      if (v) void copyText(v, ctx, t('Скопировано: {value}', { value: v }));
      return;
    }
    const pal = el.closest<HTMLElement>('[data-pal]')?.dataset.pal;
    if (pal !== undefined) {
      const hex = palette[Number(pal)]!;
      if (editPalette) {
        palette.splice(Number(pal), 1);
        saveStored('color.palette', palette);
        renderPalette();
      } else setColor(parseColor(hex)!, 'other');
      return;
    }
    const ui = el.closest<HTMLElement>('[data-use-i]')?.dataset.useI;
    if (ui !== undefined && usages) {
      target = usages[Number(ui)]!;
      setColor(target.rgba, 'other');
      renderUsages();
      q('[data-target]').scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    const use = el.closest<HTMLElement>('[data-use]')?.dataset.use as 'fg' | 'bg' | undefined;
    if (use) {
      fgBg[use] = toHex(roundRgba(color));
      q<HTMLInputElement>(`[data-cc="${use}"]`).value = fgBg[use];
      renderContrast();
      return;
    }
    switch (el.closest<HTMLElement>('[data-act]')?.dataset.act) {
      case 'eyedropper':
        if (EyeDropper) {
          try {
            const r = await new EyeDropper().open();
            const c = parseColor(r.sRGBHex);
            if (c) setColor(c, 'other');
          } catch {
            /* cancelled */
          }
        }
        break;
      case 'project-image': {
        const path = await pickProjectFile(ctx, { title: t('Изображение из проекта'), filter: isImagePath, empty: t('В проекте нет изображений') });
        const f = path ? ctx.project()?.files[path] : undefined;
        if (path && f) await loadImage(new Blob([fileBytes(f) as BlobPart], { type: mimeOf(path) }));
        break;
      }
      case 'save-color': {
        const hex = toHex(roundRgba(color));
        palette = [hex, ...palette.filter((x) => x !== hex)].slice(0, PALETTE_MAX);
        saveStored('color.palette', palette);
        renderPalette();
        ctx.toast(t('Цвет {color} сохранён в палитру', { color: hex }), 'success');
        break;
      }
      case 'edit-palette':
        editPalette = !editPalette;
        renderPalette();
        break;
      case 'scan':
        scan();
        break;
      case 'replace':
        await replaceAll();
        break;
      case 'usage-files':
        await showUsageFiles();
        break;
      case 'untarget':
        target = null;
        renderTarget();
        renderUsages();
        break;
      case 'swap':
        [fgBg.fg, fgBg.bg] = [fgBg.bg, fgBg.fg];
        q<HTMLInputElement>('[data-cc="fg"]').value = fgBg.fg;
        q<HTMLInputElement>('[data-cc="bg"]').value = fgBg.bg;
        renderContrast();
        break;
    }
  };

  // Show the canonical form when a format field loses focus.
  const onBlur = (e: FocusEvent) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset?.field) update('other');
  };

  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('click', onClick);
  root.addEventListener('focusout', onBlur);
  update('other');
  renderPalette();
  renderContrast();

  return () => {
    picker?.destroy();
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onChange);
    root.removeEventListener('click', onClick);
    root.removeEventListener('focusout', onBlur);
    root.innerHTML = '';
    root.classList.remove('tool-root', 'tool-color');
  };
}

export const colorTool: Tool = {
  id: 'color',
  title: 'Цвет',
  icon: 'palette',
  mount,
};

import { esc, icon, fmtDateTime } from '../../ui/dom';
import { openSheet } from '../../ui/sheet';
import { t, tc } from '../../i18n';
import { binaryFile, textFile } from '../../core/types';
import { formatBytes } from '../../core/bytes';
import type { Tool, ToolContext } from '../types';
import { askSavePath, copyText, debounce, segmented, setSegmented, uid } from '../shared';
import { renderJsonTree, type JsonTreeHandle } from '../json/tree';
import { parseJson } from '../json/format';
import {
  METHODS, MASK, RequestError, buildRequest, emptyDraft, hasMaskedSecret, isSecretHeader, parseQuery, statusTone, suggestFileName,
  toCurl, toFetch, type BodyType, type KV, type Method, type RequestDraft, type Variable,
} from './request';
import { sendRequest, usesNativeHttp, TransportError, type TransportResponse } from './transport';
import {
  clearHistory, storeHistory, loadCurrent, loadHistory, loadSaved, loadVariables, pushHistory, storeCurrent, storeSaved, storeVariables, type HistoryItem,
} from './store';
import '../tools.css';

const TIMEOUT_MS = 30_000;
const MAX_TEXT_VIEW = 1_000_000;

type Tab = 'params' | 'headers' | 'body' | 'auth' | 'vars';
type ResView = 'pretty' | 'raw' | 'headers';

function kvRows(rows: KV[], opts: { name: string; keyPh: string; valuePh: string }): string {
  return rows
    .map(
      (r, i) => `<div class="tool-kv-row" data-row="${i}">
      <input type="checkbox" class="tool-check" data-f="enabled" ${r.enabled ? 'checked' : ''} aria-label="${esc(t('Включено'))}">
      <input class="text-input mono" data-f="key" value="${esc(r.key)}" placeholder="${esc(opts.keyPh)}" aria-label="${esc(t('Имя'))}" autocapitalize="off" autocorrect="off" spellcheck="false">
      <input class="text-input mono" data-f="value" value="${esc(r.value)}" placeholder="${esc(opts.valuePh)}" aria-label="${esc(t('Значение'))}" autocapitalize="off" autocorrect="off" spellcheck="false"
        ${opts.name === 'headers' && isSecretHeader(r.key) ? 'type="password"' : ''}>
      <button type="button" class="icon-btn" data-kv-del aria-label="${esc(t('Удалить строку'))}">${icon('trash', 'sm')}</button>
    </div>`,
    )
    .join('');
}

function kvEditor(name: string, rows: KV[], keyPh: string, valuePh: string): string {
  return `<div class="tool-kv" data-kv="${name}">
    <div class="tool-kv-rows">${kvRows(rows, { name, keyPh, valuePh })}</div>
    <button type="button" class="btn tiny ghost" data-kv-add>${icon('plus', 'sm')}<span>${esc(t('Добавить'))}</span></button>
  </div>`;
}

function decodeText(bytes: Uint8Array, contentType: string): string {
  const cs = /charset=([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

const isTextual = (ct: string) => !ct || /^text\/|[/+](json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql)\b|^application\/(x-)?(yaml|toml|sql)/i.test(ct);

function mount(root: HTMLElement, ctx: ToolContext): () => void {
  const id = uid('http');
  let draft: RequestDraft = loadCurrent();
  const vars: Variable[] = loadVariables();
  let history: HistoryItem[] = loadHistory();
  let tab: Tab = 'params';
  let resView: ResView = 'pretty';
  let inflight: AbortController | null = null;
  let response: TransportResponse | null = null;
  let responseText: string | null = null;
  let blobUrl: string | null = null;
  let tree: JsonTreeHandle | null = null;
  const native = usesNativeHttp();

  root.classList.add('tool-root', 'tool-http');
  root.innerHTML = `
    <div class="tool-http-cols">
      <section class="tool-http-req" aria-label="${esc(t('Запрос'))}">
        <form class="tool-http-line" data-form novalidate>
          <label class="visually-hidden" for="${id}-m">${esc(t('Метод'))}</label>
          <select id="${id}-m" class="select tool-method" data-method>${METHODS.map((m) => `<option ${m === draft.method ? 'selected' : ''}>${m}</option>`).join('')}</select>
          <label class="visually-hidden" for="${id}-u">URL</label>
          <input id="${id}-u" class="text-input mono" data-url type="url" inputmode="url" value="${esc(draft.url)}" placeholder="{{baseUrl}}/get" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send">
          <button class="btn primary" type="submit" data-send>${icon('play', 'sm')}<span>${esc(t('Отправить'))}</span></button>
          <button class="btn danger" type="button" data-cancel hidden>${icon('stop', 'sm')}<span>${esc(t('Отмена'))}</span></button>
        </form>
        <div class="chips tool-tabs" role="tablist" aria-label="${esc(t('Части запроса'))}">
          ${(
            [
              ['params', t('Параметры')],
              ['headers', t('Заголовки')],
              ['body', t('Тело')],
              ['auth', t('Авторизация')],
              ['vars', t('Переменные')],
            ] as Array<[Tab, string]>
          )
            .map(([v, label]) => `<button type="button" class="chip" role="tab" data-tab="${v}" aria-selected="false" aria-controls="${id}-panel">${esc(label)}<span class="tool-badge" data-badge="${v}"></span></button>`)
            .join('')}
        </div>
        <div id="${id}-panel" class="tool-panel" role="tabpanel" data-panel></div>
        <div class="tool-bar tool-http-actions">
          <button type="button" class="btn tiny secondary" data-act="history">${icon('clock', 'sm')}<span>${esc(t('История'))}</span></button>
          <button type="button" class="btn tiny secondary" data-act="saved">${icon('folder', 'sm')}<span>${esc(t('Сохранённые'))}</span></button>
          <button type="button" class="btn tiny secondary" data-act="save-req">${icon('save', 'sm')}<span>${esc(t('Сохранить запрос'))}</span></button>
          <button type="button" class="btn tiny secondary" data-act="curl">${icon('copy', 'sm')}<span>cURL</span></button>
          <button type="button" class="btn tiny secondary" data-act="fetch">${icon('copy', 'sm')}<span>fetch()</span></button>
          <button type="button" class="btn tiny ghost" data-act="new">${icon('plus', 'sm')}<span>${esc(t('Новый'))}</span></button>
        </div>
        <p class="tool-note">${icon('info', 'xs')} ${esc(
          native
            ? t('Запросы идут напрямую из приложения: CORS не мешает. Незащищённый http:// iOS разрешает только для localhost и локальной сети.')
            : t('В браузере действуют CORS и политика безопасности страницы: многие API ответят ошибкой. В приложении на iPhone и iPad этих ограничений нет.'),
        )}</p>
      </section>
      <section class="tool-http-res" aria-label="${esc(t('Ответ'))}" data-res>
        <p class="tool-empty">${esc(t('Отправьте запрос, чтобы увидеть ответ'))}</p>
      </section>
    </div>`;

  const q = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const panel = q('[data-panel]');
  const resBox = q('[data-res]');
  const persist = debounce(() => storeCurrent(draft), 300);
  const persistVars = debounce(() => storeVariables(vars), 300);

  function badges() {
    const count = (rows: KV[]) => rows.filter((r) => r.enabled && r.key).length;
    const set = (name: Tab, v: string) => (q(`[data-badge="${name}"]`).textContent = v);
    set('params', count(draft.params) ? String(count(draft.params)) : '');
    set('headers', count(draft.headers) ? String(count(draft.headers)) : '');
    set('body', draft.bodyType === 'none' ? '' : draft.bodyType === 'json' ? 'JSON' : draft.bodyType === 'form' ? 'form' : 'text');
    set('auth', draft.auth.type === 'none' ? '' : draft.auth.type === 'bearer' ? 'Bearer' : 'Basic');
    set('vars', vars.length ? String(vars.length) : '');
  }

  function renderPanel() {
    root.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    if (tab === 'params') {
      panel.innerHTML = `${kvEditor('params', draft.params, t('параметр'), t('значение'))}
        <p class="tool-hint">${esc(t('Параметры добавляются к адресу. Можно использовать переменные: {{name}}.'))}</p>`;
    } else if (tab === 'headers') {
      panel.innerHTML = `${kvEditor('headers', draft.headers, 'Header', t('значение'))}
        <div class="btn-row">${['Accept: application/json', 'Content-Type: application/json', 'User-Agent: Codevia']
          .map((h) => `<button type="button" class="chip" data-preset="${esc(h)}">${esc(h.split(':')[0]!)}</button>`)
          .join('')}</div>`;
    } else if (tab === 'body') {
      const noBody = draft.method === 'GET' || draft.method === 'HEAD';
      panel.innerHTML = `${segmented('bodytype', [['none', t('Нет')], ['json', 'JSON'], ['form', 'Form'], ['text', t('Текст')]], draft.bodyType, t('Тип тела'))}
        ${noBody && draft.bodyType !== 'none' ? `<p class="tool-hint c-warning">${esc(t('У запросов GET и HEAD тело не отправляется.'))}</p>` : ''}
        ${
          draft.bodyType === 'json' || draft.bodyType === 'text'
            ? `<label class="visually-hidden" for="${id}-body">${esc(t('Тело запроса'))}</label>
               <textarea id="${id}-body" class="text-input textarea tool-code" data-body spellcheck="false" autocapitalize="off" autocorrect="off" placeholder="${draft.bodyType === 'json' ? '{ "name": "value" }' : ''}">${esc(draft.body)}</textarea>
               ${draft.bodyType === 'json' ? `<div class="tool-bar"><span class="tool-status" data-json-status role="status" aria-live="polite"></span><button type="button" class="btn tiny secondary" data-act="pretty-body">${esc(t('Форматировать'))}</button></div>` : ''}`
            : draft.bodyType === 'form'
              ? kvEditor('form', draft.form, t('поле'), t('значение'))
              : ''
        }`;
      validateBody();
    } else if (tab === 'auth') {
      const a = draft.auth;
      panel.innerHTML = `${segmented('authtype', [['none', t('Нет')], ['bearer', 'Bearer'], ['basic', 'Basic']], a.type, t('Тип авторизации'))}
        ${
          a.type === 'bearer'
            ? `<label class="field"><span class="field-label">${esc(t('Токен'))}</span>
                <input class="text-input mono" type="password" data-auth="token" value="${esc(a.token)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="{{token}}"></label>`
            : a.type === 'basic'
              ? `<label class="field"><span class="field-label">${esc(t('Пользователь'))}</span>
                  <input class="text-input" data-auth="user" value="${esc(a.user)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
                 <label class="field"><span class="field-label">${esc(t('Пароль'))}</span>
                  <input class="text-input" type="password" data-auth="password" value="${esc(a.password)}" autocomplete="off"></label>`
              : ''
        }
        <p class="tool-hint">${icon('lock', 'xs')} ${esc(t('Токены и пароли не попадают в историю и сохранённые запросы: там они заменяются на ••••.'))}</p>`;
    } else {
      panel.innerHTML = `<div class="tool-kv" data-vars>
          <div class="tool-kv-rows">${vars
            .map(
              (v, i) => `<div class="tool-kv-row" data-row="${i}">
              <label class="tool-secret" title="${esc(t('Секрет: не сохраняется'))}"><input type="checkbox" class="tool-check" data-f="secret" ${v.secret ? 'checked' : ''} aria-label="${esc(t('Секрет: не сохраняется'))}">${icon('lock', 'xs')}</label>
              <input class="text-input mono" data-f="key" value="${esc(v.key)}" placeholder="baseUrl" aria-label="${esc(t('Имя'))}" autocapitalize="off" autocorrect="off" spellcheck="false">
              <input class="text-input mono" data-f="value" value="${esc(v.value)}" ${v.secret ? 'type="password"' : ''} placeholder="${esc(t('значение'))}" aria-label="${esc(t('Значение'))}" autocapitalize="off" autocorrect="off" spellcheck="false">
              <button type="button" class="icon-btn" data-kv-del aria-label="${esc(t('Удалить строку'))}">${icon('trash', 'sm')}</button></div>`,
            )
            .join('')}</div>
          <button type="button" class="btn tiny ghost" data-kv-add>${icon('plus', 'sm')}<span>${esc(t('Добавить'))}</span></button>
        </div>
        <p class="tool-hint">${esc(t('Пишите {{name}} в адресе, параметрах, заголовках и теле. Значения секретных переменных живут только до закрытия приложения.'))}</p>`;
    }
    badges();
  }

  function validateBody() {
    const st = root.querySelector<HTMLElement>('[data-json-status]');
    if (!st) return;
    if (!draft.body.trim()) {
      st.textContent = '';
      st.className = 'tool-status';
      return;
    }
    const r = parseJson(draft.body.replace(/\{\{\s*[\w.-]+\s*\}\}/g, '0'));
    st.className = `tool-status ${r.ok ? 'ok' : 'error'}`;
    st.textContent = r.ok ? t('Корректный JSON') : t('Строка {line}, столбец {column}: {message}', { line: r.error.line, column: r.error.column, message: r.error.message });
  }

  const listFor = (name: string): KV[] | Variable[] => (name === 'params' ? draft.params : name === 'headers' ? draft.headers : name === 'form' ? draft.form : vars);

  function changed(isVars: boolean) {
    if (isVars) persistVars();
    else persist();
    badges();
  }

  // ---------- request editing ----------
  const onInput = (e: Event) => {
    const el = e.target as HTMLInputElement;
    if (el.matches('[data-url]')) {
      draft.url = el.value;
      return changed(false);
    }
    if (el.matches('[data-body]')) {
      draft.body = el.value;
      validateBody();
      return changed(false);
    }
    if (el.dataset.auth) {
      (draft.auth as unknown as Record<string, string>)[el.dataset.auth] = el.value;
      return changed(false);
    }
    const row = el.closest<HTMLElement>('[data-row]');
    const box = el.closest<HTMLElement>('[data-kv],[data-vars]');
    if (!row || !box || !el.dataset.f) return;
    const isVars = box.hasAttribute('data-vars');
    const list = isVars ? vars : (listFor(box.dataset.kv!) as KV[]);
    const item = list[Number(row.dataset.row)] as unknown as Record<string, string | boolean>;
    if (!item) return;
    if (el.type === 'checkbox') {
      item[el.dataset.f] = el.checked;
      if (el.dataset.f === 'secret') {
        const v = row.querySelector<HTMLInputElement>('[data-f="value"]')!;
        v.type = el.checked ? 'password' : 'text';
      }
    } else item[el.dataset.f] = el.value;
    if (el.dataset.f === 'key' && box.dataset.kv === 'headers') {
      row.querySelector<HTMLInputElement>('[data-f="value"]')!.type = isSecretHeader(el.value) ? 'password' : 'text';
    }
    changed(isVars);
  };

  const onChange = (e: Event) => {
    const el = e.target as HTMLSelectElement;
    if (el.matches('[data-method]')) {
      draft.method = el.value as Method;
      if (tab === 'body') renderPanel();
      changed(false);
    }
  };

  function moveQueryToParams() {
    const i = draft.url.indexOf('?');
    if (i < 0 || (draft.url.includes('{{') && draft.url.indexOf('{{') > i)) return;
    const parsed = parseQuery(draft.url.slice(i));
    if (!parsed.length) return;
    draft.url = draft.url.slice(0, i);
    draft.params.push(...parsed);
    q<HTMLInputElement>('[data-url]').value = draft.url;
    if (tab === 'params') renderPanel();
    changed(false);
  }

  // ---------- sending ----------
  function setBusy(busy: boolean) {
    q('[data-send]').hidden = busy;
    q('[data-cancel]').hidden = !busy;
    resBox.setAttribute('aria-busy', String(busy));
  }

  async function send() {
    if (inflight) return;
    if (hasMaskedSecret(draft)) {
      ctx.toast(t('Введите секрет заново: в сохранённых запросах он скрыт (••••)'), 'error');
      tab = draft.auth.token === MASK || draft.auth.password === MASK ? 'auth' : 'headers';
      renderPanel();
      return;
    }
    let built;
    try {
      built = buildRequest(draft, vars);
    } catch (e) {
      if (e instanceof RequestError) {
        showError(e.message);
        return;
      }
      throw e;
    }
    if (built.unresolved.length) ctx.toast(t('Нет значения у переменных: {names}', { names: built.unresolved.join(', ') }), 'info');
    inflight = new AbortController();
    setBusy(true);
    resBox.innerHTML = `<div class="tool-empty"><span class="spinner" aria-hidden="true"></span><span>${esc(t('Отправка…'))}</span></div>`;
    try {
      const res = await sendRequest({ method: built.method, url: built.url, headers: built.headers, body: built.body, timeoutMs: TIMEOUT_MS, signal: inflight.signal });
      history = pushHistory(history, draft, { status: res.status, timeMs: res.timeMs });
      showResponse(res);
      ctx.haptic(res.status < 400 ? 'success' : 'warning');
    } catch (e) {
      const msg = e instanceof TransportError ? e.message : String((e as Error)?.message ?? e);
      if (!(e instanceof TransportError && e.kind === 'aborted')) history = pushHistory(history, draft, {});
      showError(msg);
      ctx.haptic('error');
    } finally {
      inflight = null;
      setBusy(false);
    }
  }

  function showError(message: string) {
    clearResponse();
    resBox.innerHTML = `<div class="banner danger tool-http-error" role="alert">${icon('info', 'sm')}<div>${esc(message).replace(/\n/g, '<br>')}</div></div>`;
  }

  function clearResponse() {
    tree?.destroy();
    tree = null;
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = null;
    response = null;
    responseText = null;
  }

  function showResponse(res: TransportResponse) {
    clearResponse();
    response = res;
    const ct = res.headers['content-type'] ?? '';
    responseText = isTextual(ct) || (!ct && res.body.length < MAX_TEXT_VIEW) ? decodeText(res.body, ct) : null;
    const tone = statusTone(res.status);
    resBox.innerHTML = `
      <div class="tool-res-head">
        <span class="tool-status-pill ${tone}" aria-label="${esc(t('Статус {code}', { code: res.status }))}">${res.status}${res.statusText ? ` ${esc(res.statusText)}` : ''}</span>
        <span class="tool-muted">${esc(t('{ms} мс', { ms: res.timeMs }))}</span>
        <span class="tool-muted">${esc(formatBytes(res.body.length))}</span>
        <span class="tool-muted truncate mono">${esc(ct.split(';')[0] ?? '')}</span>
      </div>
      ${segmented('resview', [['pretty', t('Просмотр')], ['raw', t('Текст')], ['headers', `${t('Заголовки')} (${Object.keys(res.headers).length})`]], resView, t('Вид ответа'))}
      <div class="tool-res-body" data-res-body></div>
      <div class="tool-bar">
        <button type="button" class="btn tiny secondary" data-act="copy-body" ${responseText === null ? 'disabled' : ''}>${icon('copy', 'sm')}<span>${esc(t('Копировать тело'))}</span></button>
        <button type="button" class="btn tiny secondary" data-act="save-body" ${ctx.project() ? '' : 'disabled'}>${icon('download', 'sm')}<span>${esc(t('Сохранить в проект'))}</span></button>
      </div>`;
    renderResBody();
  }

  function renderResBody() {
    const host = root.querySelector<HTMLElement>('[data-res-body]');
    if (!host || !response) return;
    tree?.destroy();
    tree = null;
    const res = response;
    const ct = (res.headers['content-type'] ?? '').toLowerCase();
    if (resView === 'headers') {
      const entries = Object.entries(res.headers).sort(([a], [b]) => a.localeCompare(b));
      host.innerHTML = entries.length
        ? `<dl class="tool-headers">${entries.map(([k, v]) => `<div><dt class="mono">${esc(k)}</dt><dd class="mono">${esc(v)}</dd></div>`).join('')}</dl>`
        : `<p class="tool-muted">${esc(tc('http', 'Заголовков нет'))}</p>`;
      return;
    }
    if (!res.body.length) {
      host.innerHTML = `<p class="tool-muted">${esc(t('Пустое тело ответа'))}</p>`;
      return;
    }
    if (resView === 'pretty' && ct.startsWith('image/')) {
      if (!blobUrl) blobUrl = URL.createObjectURL(new Blob([res.body as BlobPart], { type: ct.split(';')[0] }));
      host.innerHTML = `<div class="tool-res-image"><img src="${esc(blobUrl)}" alt="${esc(t('Изображение из ответа'))}"></div>`;
      return;
    }
    if (responseText === null) {
      host.innerHTML = `<p class="tool-muted">${esc(t('Двоичные данные ({size}). Сохраните их в проект, чтобы открыть.', { size: formatBytes(res.body.length) }))}</p>`;
      return;
    }
    if (resView === 'pretty') {
      const parsed = /json/.test(ct) || /^\s*[[{]/.test(responseText) ? parseJson(responseText) : null;
      if (parsed?.ok) {
        tree = renderJsonTree(host, parsed.value, { expandDepth: 2, copy: (text, what) => void copyText(text, ctx, what === 'path' ? t('Путь скопирован') : t('Скопировано')) });
        return;
      }
    }
    const shown = responseText.length > MAX_TEXT_VIEW ? `${responseText.slice(0, MAX_TEXT_VIEW)}\n…` : responseText;
    host.innerHTML = `<pre class="tool-pre mono" tabindex="0">${esc(shown)}</pre>`;
  }

  // ---------- history & saved ----------
  function load(d: RequestDraft) {
    draft = structuredClone(d);
    q<HTMLSelectElement>('[data-method]').value = draft.method;
    q<HTMLInputElement>('[data-url]').value = draft.url;
    renderPanel();
    persist();
  }

  const entryRow = (d: RequestDraft, title: string, sub: string, i: number, kind: string) => `<div class="row tool-hist-row">
      <button type="button" class="row-button" data-load="${i}">
        <span class="tool-method-tag m-${d.method.toLowerCase()}">${d.method}</span>
        <span class="row-main"><span class="row-title mono">${esc(title)}</span><span class="row-description">${esc(sub)}</span></span>
      </button>
      <button type="button" class="icon-btn" data-del="${i}" aria-label="${esc(kind)}">${icon('trash', 'sm')}</button></div>`;

  async function openHistory() {
    await openSheet({
      title: t('История запросов'),
      wide: true,
      body: history.length
        ? `<div class="list" data-list>${history
            .map((h, i) => entryRow(h.draft, h.draft.url, `${fmtDateTime(h.at)}${h.status ? ` · ${h.status}` : ` · ${t('ошибка')}`}${h.timeMs != null ? ` · ${t('{ms} мс', { ms: h.timeMs })}` : ''}`, i, t('Удалить из истории')))
            .join('')}</div>
           <button type="button" class="btn danger full" data-clear>${esc(t('Очистить историю'))}</button>`
        : `<p class="tool-empty">${esc(t('История пуста'))}</p>`,
      onMount: (sheet, close) =>
        sheet.addEventListener('click', (e) => {
          const el = e.target as HTMLElement;
          const loadI = el.closest<HTMLElement>('[data-load]')?.dataset.load;
          const delI = el.closest<HTMLElement>('[data-del]')?.dataset.del;
          if (loadI !== undefined) {
            load(history[Number(loadI)]!.draft);
            close();
          } else if (delI !== undefined) {
            history = history.filter((_, i) => i !== Number(delI));
            storeHistory(history);
            el.closest('.row')?.remove();
          } else if (el.closest('[data-clear]')) {
            history = [];
            clearHistory();
            close();
          }
        }),
    });
  }
  async function openSaved() {
    let saved = loadSaved();
    await openSheet({
      title: t('Сохранённые запросы'),
      wide: true,
      body: saved.length
        ? `<div class="list">${saved.map((s, i) => entryRow(s.draft, s.name, s.draft.url, i, t('Удалить запрос'))).join('')}</div>`
        : `<p class="tool-empty">${esc(t('Сохранённых запросов нет. Нажмите «Сохранить запрос».'))}</p>`,
      onMount: (sheet, close) =>
        sheet.addEventListener('click', (e) => {
          const el = e.target as HTMLElement;
          const loadI = el.closest<HTMLElement>('[data-load]')?.dataset.load;
          const delI = el.closest<HTMLElement>('[data-del]')?.dataset.del;
          if (loadI !== undefined) {
            load(saved[Number(loadI)]!.draft);
            close();
          } else if (delI !== undefined) {
            saved = saved.filter((_, i) => i !== Number(delI));
            storeSaved(saved);
            el.closest('.row')?.remove();
          }
        }),
    });
  }

  async function saveRequest() {
    const suggested = (() => {
      try {
        return new URL(buildRequest(draft, vars).url).pathname.split('/').filter(Boolean).pop() || draft.method;
      } catch {
        return draft.method;
      }
    })();
    const name = await ctx.prompt({ title: t('Сохранить запрос'), label: t('Название'), value: suggested, ok: t('Сохранить') });
    if (!name) return;
    const saved = loadSaved().filter((s) => s.name !== name);
    saved.unshift({ name, draft: structuredClone(draft) });
    storeSaved(saved);
    ctx.toast(t('Запрос сохранён (без секретов)'), 'success');
  }

  function exportCode(kind: 'curl' | 'fetch') {
    try {
      const built = buildRequest(draft, vars);
      void copyText(kind === 'curl' ? toCurl(built) : toFetch(built), ctx);
    } catch (e) {
      ctx.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  async function saveBody() {
    if (!response) return;
    const ct = response.headers['content-type'] ?? '';
    const path = await askSavePath(ctx, suggestFileName(response.url, ct));
    if (!path) return;
    try {
      await ctx.writeFiles({ [path]: responseText !== null && !ct.startsWith('image/') ? textFile(responseText) : binaryFile(response.body) });
      ctx.toast(t('Сохранено: {path}', { path }), 'success');
    } catch (e) {
      ctx.toast(String((e as Error)?.message ?? e), 'error');
    }
  }

  // ---------- events ----------
  const onClick = (e: MouseEvent) => {
    const el = e.target as HTMLElement;
    const tabBtn = el.closest<HTMLElement>('[data-tab]');
    if (tabBtn) {
      tab = tabBtn.dataset.tab as Tab;
      return renderPanel();
    }
    const bt = el.closest<HTMLElement>('[data-bodytype]');
    if (bt) {
      draft.bodyType = bt.dataset.bodytype as BodyType;
      renderPanel();
      return changed(false);
    }
    const at = el.closest<HTMLElement>('[data-authtype]');
    if (at) {
      draft.auth.type = at.dataset.authtype as RequestDraft['auth']['type'];
      renderPanel();
      return changed(false);
    }
    const rv = el.closest<HTMLElement>('[data-resview]');
    if (rv) {
      resView = rv.dataset.resview as ResView;
      setSegmented(root, 'resview', resView);
      return renderResBody();
    }
    const preset = el.closest<HTMLElement>('[data-preset]')?.dataset.preset;
    if (preset) {
      const [k, ...rest] = preset.split(':');
      const existing = draft.headers.find((h) => h.key.toLowerCase() === k!.toLowerCase());
      if (existing) existing.value = rest.join(':').trim();
      else draft.headers.push({ key: k!, value: rest.join(':').trim(), enabled: true });
      renderPanel();
      return changed(false);
    }
    if (el.closest('[data-kv-add]')) {
      const box = el.closest<HTMLElement>('[data-kv],[data-vars]')!;
      if (box.hasAttribute('data-vars')) vars.push({ key: '', value: '' });
      else (listFor(box.dataset.kv!) as KV[]).push({ key: '', value: '', enabled: true });
      renderPanel();
      const rows = panel.querySelectorAll<HTMLInputElement>('[data-f="key"]');
      rows[rows.length - 1]?.focus();
      return;
    }
    if (el.closest('[data-kv-del]')) {
      const box = el.closest<HTMLElement>('[data-kv],[data-vars]')!;
      const i = Number(el.closest<HTMLElement>('[data-row]')!.dataset.row);
      const isVars = box.hasAttribute('data-vars');
      (isVars ? vars : (listFor(box.dataset.kv!) as KV[])).splice(i, 1);
      renderPanel();
      return changed(isVars);
    }
    if (el.closest('[data-cancel]')) {
      inflight?.abort();
      return;
    }
    switch (el.closest<HTMLElement>('[data-act]')?.dataset.act) {
      case 'history':
        return void openHistory();
      case 'saved':
        return void openSaved();
      case 'save-req':
        return void saveRequest();
      case 'curl':
        return exportCode('curl');
      case 'fetch':
        return exportCode('fetch');
      case 'new':
        load(emptyDraft());
        clearResponse();
        resBox.innerHTML = `<p class="tool-empty">${esc(t('Отправьте запрос, чтобы увидеть ответ'))}</p>`;
        return;
      case 'pretty-body': {
        const r = parseJson(draft.body);
        if (r.ok) {
          draft.body = JSON.stringify(r.value, null, 2);
          root.querySelector<HTMLTextAreaElement>('[data-body]')!.value = draft.body;
          validateBody();
          changed(false);
        } else ctx.toast(t('Сначала исправьте ошибку в JSON'), 'error');
        return;
      }
      case 'copy-body':
        if (responseText !== null) void copyText(responseText, ctx);
        return;
      case 'save-body':
        return void saveBody();
    }
  };

  const onSubmit = (e: Event) => {
    e.preventDefault();
    moveQueryToParams();
    void send();
  };
  const onUrlBlur = () => moveQueryToParams();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('keydown', onKey);
  q('[data-form]').addEventListener('submit', onSubmit);
  q('[data-url]').addEventListener('blur', onUrlBlur);
  renderPanel();

  return () => {
    inflight?.abort();
    persist.cancel();
    persistVars.cancel();
    storeCurrent(draft);
    storeVariables(vars);
    clearResponse();
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onChange);
    root.removeEventListener('keydown', onKey);
    root.innerHTML = '';
    root.classList.remove('tool-root', 'tool-http');
  };
}

export const httpTool: Tool = {
  id: 'http',
  title: 'HTTP-клиент',
  icon: 'send',
  mount,
};

# Run: python3 -m http.server 8765 --bind 127.0.0.1  (from project root), then: python3 tests/audit_probes.py
# Each key in the JSON output reproduces one finding from docs/AUDIT.md. Set CHROMIUM to override the browser path.
"""Audit probes for Codevia UI 0.3: each check reproduces one suspected defect."""
import os, io, zipfile, base64, json, struct, zlib
from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:8765/index.html'
R = {}


def b64(data):
    return base64.b64encode(bytes(data)).decode()


def zip_raw_name(name_bytes, payload):
    crc = zlib.crc32(payload)
    lh = struct.pack('<IHHHHHIIIHH', 0x04034b50, 20, 0, 0, 0, 0, crc, len(payload), len(payload), len(name_bytes), 0) + name_bytes + payload
    ch = struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 20, 20, 0, 0, 0, 0, crc, len(payload), len(payload), len(name_bytes), 0, 0, 0, 0, 0, 0) + name_bytes
    eo = struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, 1, 1, len(ch), len(lh), 0)
    return lh + ch + eo


UNZIP = "async(s)=>{try{return Object.keys(await unzip(Uint8Array.from(atob(s),c=>c.charCodeAt(0))))}catch(e){return 'ERR: '+e.message}}"

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM') or None, args=['--no-sandbox'])
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
    def classic(route):
        r = route.fetch(); route.fulfill(response=r, body=r.text().replace(' type="module"', ''))
    ctx.route('**/index.html', classic)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.get_by_role('heading', name='Проекты').wait_for()

    # Tap targets and input font sizes at the default density
    R['default_density'] = pg.evaluate("document.documentElement.dataset.density")
    small = pg.evaluate("""()=>[...document.querySelectorAll('button,input,[data-action]')].map(e=>{const r=e.getBoundingClientRect();
      return {t:(e.getAttribute('aria-label')||e.textContent||e.id).trim().slice(0,20),w:Math.round(r.width),h:Math.round(r.height)}}).filter(x=>x.w>0&&(x.h<44||x.w<44))""")
    R['home_small_targets_count'] = len(small)
    R['home_small_targets_sample'] = small[:8]
    R['input_font_sizes'] = pg.evaluate("[...document.querySelectorAll('input')].map(i=>getComputedStyle(i).fontSize)")
    R['topbar_padding_top'] = pg.evaluate("getComputedStyle(document.querySelector('.topbar')).paddingTop")

    # Fullscreen preview: can the user get back out?
    pg.get_by_role('button', name='Продолжить').click()
    pg.locator('.nav-item').filter(has_text='Просмотр').click()
    pg.locator('#live-preview').wait_for()
    btn = pg.get_by_role('button', name='Открыть на весь экран')
    bx = btn.bounding_box()
    nb = pg.locator('.nav-item').first.bounding_box()
    btn.click()
    R['fullscreen_element_at_expand_btn'] = pg.evaluate(f"document.elementFromPoint({bx['x']+bx['width']/2},{bx['y']+bx['height']/2})?.tagName")
    R['fullscreen_element_at_bottomnav'] = pg.evaluate(f"document.elementFromPoint({nb['x']+nb['width']/2},{nb['y']+nb['height']/2})?.tagName")
    pg.keyboard.press('Escape')
    R['fullscreen_still_open_after_escape'] = pg.locator('.preview-shell.fullscreen').count() == 1
    pg.reload()
    pg.get_by_role('heading', name='Проекты').wait_for()

    # Real IndexedDB: edit survives reload?
    R['persist_after_reload'] = pg.evaluate("""async()=>{const p=project();p.files['styles.css'].content+='/*PERSIST*/';persist();
      await new Promise(r=>setTimeout(r,300));location.reload();return true}""")
    pg.get_by_role('heading', name='Проекты').wait_for()
    R['persist_after_reload'] = pg.evaluate("project().files['styles.css'].content.includes('PERSIST')")

    # '</script>' inside a user JS string literal
    pg.evaluate("""()=>{project().files['app.js'].content='const s = "</script>"; document.body.dataset.ok = "yes";'}""")
    pg.get_by_role('button', name='Продолжить').click()
    pg.locator('.nav-item').filter(has_text='Просмотр').click()
    pg.wait_for_timeout(600)
    frame = pg.frames[1]
    R['script_tag_in_string_js_ran'] = frame.evaluate("document.body.dataset.ok || 'NOT_RUN'")
    R['script_tag_in_string_code_leaks_into_page'] = frame.evaluate("document.body.innerText.includes('dataset.ok')")

    # CSP meta prepended before <!doctype> when <head> has attributes
    pg.evaluate("""()=>{project().files['index.html'].content='<!doctype html><html><head lang="ru"><title>x</title></head><body><h1>Q</h1></body></html>'}""")
    pg.get_by_role('button', name='Обновить').click()
    pg.wait_for_timeout(500)
    R['preview_compat_mode_head_with_attr'] = pg.frames[1].evaluate("document.compatMode")

    # Relative paths ../ and ./ in preview
    pg.evaluate("""()=>{const p=project();p.files['pages/about.html']={text:true,content:'<!doctype html><html><head><link rel="stylesheet" href="../styles.css"></head><body>x</body></html>'}}""")
    R['preview_resolves_parent_css'] = pg.evaluate("""async()=>{S.activePreview='pages/about.html';const d=await makePreviewDoc(project());return d.includes('--accent')}""")

    # Keybar: caret position after '{ }', undo of inserted text
    pg.locator('.nav-item').filter(has_text='Код').click()
    pg.evaluate("()=>{const t=document.querySelector('#code-input');t.focus();t.setSelectionRange(0,0)}")
    pg.locator('.key-btn').first.click()
    R['brace_insert'] = pg.evaluate("()=>{const t=document.querySelector('#code-input');return {head:t.value.slice(0,2),caret:t.selectionStart}}")
    pg.get_by_role('button', name='Отменить').click()
    R['undo_reverted_brace'] = pg.evaluate("()=>!document.querySelector('#code-input').value.startsWith('{}')")

    # ZIP: declared size lies (50 MB of zeros declared as 100 bytes) -> inflated fully before rejection
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('a.txt', b'\0' * (50 * 1024 * 1024))
    data = bytearray(buf.getvalue())
    cd = data.rfind(b'PK\x01\x02')
    data[cd+24:cd+28] = (100).to_bytes(4, 'little')
    R['zip_lying_size_archive_kb'] = len(data) // 1024
    R['zip_lying_size_result'] = pg.evaluate(UNZIP, b64(data))

    # ZIP: macOS junk entries
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr('index.html', 'a')
        z.writestr('__MACOSX/._index.html', 'junk')
        z.writestr('.DS_Store', 'x')
    R['zip_macos_junk'] = pg.evaluate(UNZIP, b64(buf.getvalue()))

    # ZIP: Cyrillic name in CP866 without the UTF-8 flag (classic Windows "Send to ZIP")
    R['zip_cp866_name'] = pg.evaluate(UNZIP, b64(zip_raw_name('привет.txt'.encode('cp866'), b'hi')))
    R['page_errors'] = errs
    browser.close()

print(json.dumps(R, ensure_ascii=False, indent=1))

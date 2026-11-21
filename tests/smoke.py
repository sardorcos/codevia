from playwright.sync_api import sync_playwright
from pathlib import Path
import re
out=Path(__file__).resolve().parents[1]
html=(out/'index.html').read_text()
html=re.sub(r'<link rel="stylesheet"[^>]+>','',html)
html=re.sub(r'<script src="./src/app.js" type="module"></script>','',html)
css=(out/'src/styles.css').read_text()
js=(out/'src/app.js').read_text()
with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
  page=browser.new_page(viewport={"width":390,"height":844},device_scale_factor=1,has_touch=True,is_mobile=True)
  errors=[]
  page.on('pageerror',lambda e: errors.append(str(e)))
  page.set_content(html,wait_until='domcontentloaded')
  page.add_style_tag(content=css)
  page.add_script_tag(content=js)
  page.get_by_role('heading',name='Проекты').wait_for()
  page.screenshot(path=str(out/'home.png'),full_page=True)
  print('title',page.title(),'projects:',page.locator('.project-row').count())
  page.get_by_role('button',name='Продолжить').click()
  print('File list',page.locator('.file-list .file-row').count())
  page.get_by_text('styles.css').first.click()
  print('Editor?',page.locator('#code-input').count())
  assert page.locator('#code-input').count()==1
  t=page.locator('#code-input');before=t.input_value()
  t.fill(before.replace('#40c8f6','#18b7c7'))
  page.wait_for_timeout(600)
  page.screenshot(path=str(out/'editor.png'),full_page=True)
  page.locator('.nav-item').filter(has_text='Просмотр').click()
  page.wait_for_timeout(300)
  assert page.locator('#live-preview').count()==1
  page.screenshot(path=str(out/'preview.png'),full_page=True)
  src=page.locator('iframe').get_attribute('srcdoc') or ''
  print('preview length',len(src),'updated color', '#18b7c7' in src)
  page.get_by_role('button',name='Вернуться').click()
  page.get_by_role('button',name='Серверы').last.click()
  page.screenshot(path=str(out/'servers.png'),full_page=True)
  print('server heading:',page.get_by_role('heading',name='Серверы').count())
  print('errors:',errors)
  browser.close()

"""Headless UI/safe data-flow checks without external network access.
The test injects static assets into about:blank and mocks IndexedDB because
this isolated browser disallows localhost/file navigation by administrator policy.
"""
import io, zipfile, base64, re, unittest
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
HTML=re.sub(r'<link rel="stylesheet"[^>]+>','',(ROOT/'index.html').read_text())
HTML=re.sub(r'<script src="./src/app.js" type="module"></script>','',HTML)
CSS=(ROOT/'src/styles.css').read_text()
JS=(ROOT/'src/app.js').read_text()
MOCK=(ROOT/'tests/fake_idb.js').read_text()
class UITest(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.playwright=sync_playwright().start()
  cls.browser=cls.playwright.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
 @classmethod
 def tearDownClass(cls):
  cls.browser.close();cls.playwright.stop()
 def setUp(self):
  self.page=self.browser.new_page(viewport={'width':390,'height':844},has_touch=True,is_mobile=True)
  self.errors=[]
  self.page.on('pageerror',lambda e:self.errors.append(str(e)))
  self.page.set_content(HTML,wait_until='domcontentloaded')
  self.page.add_style_tag(content=CSS)
  self.page.add_script_tag(content=MOCK)
  self.page.add_script_tag(content=JS)
  self.page.get_by_role('heading',name='Проекты').wait_for()
 def tearDown(self):
  self.assertFalse(self.errors,'JS page errors: '+str(self.errors))
  self.page.close()
 def open_editor(self):
  self.page.get_by_role('button',name='Продолжить').click()
  self.page.get_by_text('styles.css').first.click()
 def test_home_compact_390(self):
  self.assertEqual(self.page.locator('.project-row').count(),3)
  self.assertEqual(self.page.locator('.bottomnav .nav-item').count(),4)
  self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth > window.innerWidth'))
  self.page.screenshot(path=str(ROOT/'home.png'))
 def test_edit_preview_refresh(self):
  self.open_editor();field=self.page.locator('#code-input');self.assertEqual(field.count(),1)
  content=field.input_value();field.fill(content.replace('#40c8f6','#18b7c7'))
  self.page.wait_for_timeout(1100)
  self.assertIn('Сохранено',self.page.locator('#save-state').inner_text())
  self.page.get_by_role('button',name='Перенос строк').click()
  self.assertEqual(self.page.locator('.code-wrap.wrapped').count(),1)
  self.page.get_by_role('button',name='Перенос строк').click()
  self.page.locator('#code-input').evaluate('(el)=>{el.scrollLeft=0;el.scrollTop=0}')
  self.page.screenshot(path=str(ROOT/'editor.png'))
  self.page.locator('.nav-item').filter(has_text='Просмотр').click()
  self.page.locator('#live-preview').wait_for()
  self.assertIn('#18b7c7',self.page.locator('#live-preview').get_attribute('srcdoc'))
  self.page.frame_locator('iframe').get_by_role('heading',name='Идеи становятся продуктами.').wait_for()
  self.page.screenshot(path=str(ROOT/'preview.png'))
  self.page.frame_locator('iframe').get_by_role('button',name='Обсудить проект').click()
  self.assertIn('Спасибо',self.page.frame_locator('iframe').get_by_role('button').inner_text())
 def test_settings_density(self):
  self.page.get_by_role('button',name='Настройки').click()
  self.page.get_by_role('button',name='Комфортный').click()
  self.assertEqual(self.page.locator('#app').get_attribute('data-density'),'comfortable')
  self.page.locator('#font-range').fill('16')
  self.assertEqual(self.page.evaluate('S.editorFont'),16)
 def test_server_profile_local_no_credentials(self):
  self.page.get_by_role('button',name='Серверы').last.click()
  self.page.screenshot(path=str(ROOT/'servers.png'))
  self.page.get_by_role('button',name='Добавить',exact=True).click()
  self.page.locator('#server-name').fill('Тестовый хостинг')
  self.page.locator('#server-host').fill('example.org')
  self.page.locator('#server-user').fill('siteuser')
  self.page.locator('#server-path').fill('/public_html')
  self.page.locator('#server-form').get_by_role('button',name='Сохранить профиль').click()
  self.assertIn('Тестовый хостинг',self.page.locator('.server-row').inner_text())
  self.assertEqual(self.page.evaluate('S.servers.length'),1)
  self.assertEqual(sorted(self.page.evaluate('Object.keys(S.servers[0])')),['host','id','name','path','port','protocol','user'])
 def test_zip_roundtrip_and_path_traversal(self):
  result=self.page.evaluate('''async () => {const f={'a/index.html':{text:true,content:'<h1>Привет</h1>'},'data/x.json':{text:true,content:'{"a":1}'}};
  const z=zipStore(f);const restored=await unzip(new Uint8Array(await z.arrayBuffer()));return {bytes:z.size,files:Object.keys(restored),html:restored['a/index.html'].content}}''')
  self.assertEqual(result['files'],['a/index.html','data/x.json'])
  self.assertEqual(result['html'],'<h1>Привет</h1>')
  malicious=io.BytesIO()
  with zipfile.ZipFile(malicious,'w',zipfile.ZIP_DEFLATED) as z:z.writestr('../secret.txt','bad')
  encoded=base64.b64encode(malicious.getvalue()).decode()
  err=self.page.evaluate('''async (s) => {try{await unzip(Uint8Array.from(atob(s),c=>c.charCodeAt(0)));return 'NOT_REJECTED'}catch(e){return e.message}}''',encoded)
  self.assertIn('небезопасный',err)
 def test_zip_deflate(self):
  buf=io.BytesIO()
  with zipfile.ZipFile(buf,'w',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('hello.txt','Привет, Codevia!')
  encoded=base64.b64encode(buf.getvalue()).decode()
  result=self.page.evaluate('''async(s)=>{const files=await unzip(Uint8Array.from(atob(s),c=>c.charCodeAt(0)));return files['hello.txt'].content}''',encoded)
  self.assertEqual(result,'Привет, Codevia!')
 def test_diagnostics_local_missing(self):
  result=self.page.evaluate('''()=>{const p=project();p.files['index.html'].content+='<img src="assets/nonexistent.png">';return scanProject(p)}''')
  self.assertTrue(any(x['type']=='error' and 'nonexistent' in x['details'] for x in result))
if __name__=='__main__':unittest.main(verbosity=2)

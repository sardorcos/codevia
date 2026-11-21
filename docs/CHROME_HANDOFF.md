# Задание для сессии с Claude in Chrome

Скопируйте текст ниже в сессию, где подключён Claude in Chrome (настоящий Chrome, в котором вы вошли в App Store Connect и GitHub).

---

Сделай только эти шаги, больше ничего не меняй.

## 1. App Privacy: «Data Not Collected» для двух приложений

App Store Connect → Apps:
- **Codevia Pocket** (`com.codevia.pocket`)
- **ZIKR** (`com.neverlandplayworks.zikr`)

Для каждого приложения:
1. Открой раздел App Privacy → Get Started (или Edit).
2. На вопрос «Do you or your third-party partners collect data from this app?» выбери **«No, we do not collect data from this app»** → Save.
3. Нажми **Publish** вверху страницы.

В итоге должно стоять «Data Not Collected» без неопубликованных изменений.

Там же проверь Privacy Policy URL:
- Codevia: `https://sardorcos.github.io/codevia/privacy.html`
- ZIKR: `https://sardorcos.github.io/zikr/privacy-policy.html`

## 2. GitHub Pages для двух репозиториев

`github.com/sardorcos/codevia` и `github.com/sardorcos/zikr` → Settings → Pages → Source: **Deploy from a branch** → **main**, папка **/docs** → Save.

Через 1–3 минуты проверь, что открываются (не 404):
- https://sardorcos.github.io/codevia/privacy.html
- https://sardorcos.github.io/codevia/support.html
- https://sardorcos.github.io/zikr/privacy-policy.html
- https://sardorcos.github.io/zikr/support.html

## Не делай

- Не нажимай «Add for Review» и «Submit for Review»: отправку на ревью делает основная сессия через API.
- Не меняй цену, тексты, скриншоты, сборки, сертификаты и ключи.

## В конце

Коротко сообщи:
- опубликован ли App Privacy для обоих приложений;
- какие из четырёх ссылок открылись.

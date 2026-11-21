# Метаданные App Store

## Основное

| Поле | Значение |
|---|---|
| Название | Codevia Pocket |
| Подзаголовок (≤30) | Код, Python и PHP на iPhone |
| Категория | Developer Tools (Инструменты разработчика); дополнительная — Education |
| Возраст | 4+ (см. ответы ниже) |
| Цена | на ваше усмотрение |
| Устройства | только iPhone, iOS 16.4+ |

## Описание (RU)

Codevia Pocket — карманная студия для веб-разработки и программирования. Пишите сайты, скрипты на Python и страницы на PHP прямо на iPhone: всё работает на устройстве, без интернета и без отправки кода на серверы.

• Редактор кода с подсветкой синтаксиса, автодополнением, поиском и заменой, отменой и удобной панелью символов над клавиатурой.
• Живой предпросмотр HTML, CSS и JavaScript: стили, картинки, шрифты, несколько страниц, fetch() к файлам проекта и консоль с ошибками.
• Python 3 и PHP 8.3 выполняются локально. Поддерживаются ввод для input(), параметры $_GET и кнопка «Стоп».
• Поиск по именам файлов и по коду во всём проекте.
• История версий: сохраняйте контрольные точки и возвращайтесь к ним. Перед удалением файлов версия сохраняется автоматически.
• Ваши файлы — ваши: проекты видны в приложении «Файлы», можно импортировать и экспортировать ZIP и сделать резервную копию всех проектов.
• Проверка проекта находит битые ссылки на файлы и ошибки в JSON.
• Без рекламы, аналитики и регистрации.

## Описание (EN)

Codevia Pocket is a pocket studio for web development and coding. Build websites, Python scripts and PHP pages right on your iPhone — everything runs on device, offline, and your code never leaves your phone.

• Code editor with syntax highlighting, autocomplete, find & replace, undo and a symbol bar above the keyboard.
• Live HTML/CSS/JS preview with styles, images, fonts, multiple pages, fetch() of project files and a console.
• Python 3 and PHP 8.3 run locally: input() support, $_GET parameters and a Stop button.
• Project-wide search, version history, ZIP import/export, full backup, Files app integration.
• No ads, no tracking, no account.

## Ключевые слова (≤100 символов)

`код,редактор,python,php,html,css,javascript,программирование,сайт,ide,code,editor,offline`

## Конфиденциальность (App Privacy)

- **Data Collection:** «Мы не собираем данные с этого приложения» (*Data Not Collected*).
- **Tracking:** нет.
- **Privacy Policy URL:** опубликуйте `docs/privacy.html` (например, через GitHub Pages) и укажите ссылку.

## Возрастной рейтинг

На все вопросы — «Нет» / «None». Отдельно про «Unrestricted Web Access»: по умолчанию **No**. Приложение не является браузером, а предпросмотр показывает только файлы пользователя и работает без сети. Если вы решите включать «Разрешить интернет в предпросмотре» по умолчанию, пересмотрите этот ответ.

## Экспортный контроль

В `Info.plist` задано `ITSAppUsesNonExemptEncryption = NO`: приложение не использует шифрование (кроме системного HTTPS, а его приложение не вызывает). Вопрос при загрузке не появится.

## Заметки для ревьюера (App Review Notes)

> Codevia Pocket is a code editor for learning and building websites, Python and PHP. Per App Store Review Guideline 2.5.2, all code executed by the app is written or imported by the user, is fully visible and editable in the app, and runs locally in a sandbox (WebAssembly interpreters bundled in the app binary: Pyodide/CPython and PHP 8.3). The app does not download executable code, does not change its own features, and makes no network requests. The live preview is a sandboxed iframe with a Content-Security-Policy that blocks network access unless the user explicitly enables it in Settings.
>
> To try it: tap "Начать с примеров" (Start with samples) → open "Python · расчёты" → "Запуск" tab → "Запустить". For a website, open "Сайт-портфолио" → "Просмотр".
>
> No account or login is required.

## Скриншоты

Нужны для iPhone 6.9" (1320×2868), минимум 3, лучше 5–6:
1. Главный экран с проектами.
2. Редактор с подсветкой и панелью символов.
3. Живой предпросмотр сайта с консолью.
4. Запуск Python с выводом.
5. PHP-страница в предпросмотре.
6. История версий или поиск по коду.

Снимайте на симуляторе iPhone 16 Pro Max (Xcode → Simulator → File → Save Screen).

# Codevia Pocket

Редактор кода для iPhone: сайты (HTML/CSS/JS), Python 3 и PHP 8.3 работают прямо на устройстве, офлайн.

## Возможности

- **Редактор** — CodeMirror 6: подсветка, автодополнение, поиск и замена, отмена; у каждого файла своя история изменений; панель символов над клавиатурой.
- **Предпросмотр** — изолированный iframe (sandbox и CSP, сеть по умолчанию выключена). Внутри работают CSS и `@import`, картинки и шрифты, `srcset`, ES-модули, `fetch()` к файлам проекта и переходы между страницами. Консоль собирает `console.*` и ошибки; есть полноэкранный режим.
- **Python** (Pyodide) и **PHP 8.3** (php-wasm) — каждый в своём Web Worker. Поддерживаются `input()`, `$_GET` и кнопка «Стоп»; неиспользуемые движки выгружаются из памяти.
- **Хранение.** На iOS это реальные файлы в папке Documents: их видно в «Файлах». Метаданные и история лежат в Library. В вебе — IndexedDB (запись на файл, корректная обработка нехватки места).
- **История версий.** Снимки с дедупликацией содержимого (SHA-256); автоматические версии не вытесняют ручные.
- **ZIP.** Потоковая распаковка с защитой от ZIP-бомб, обхода путей и симлинков; поддержка имён в CP866; служебный мусор macOS отсеивается. Экспорт с Deflate; резервная копия всех проектов.
- **Поиск** по именам и содержимому, проверка битых ссылок и JSON.

## Разработка

```bash
npm ci
npm run dev          # http://localhost:5173
npm test             # unit (Vitest)
npm run build        # dist/
npm run e2e          # E2E (Playwright, собранный бандл)
npm run lint && npm run typecheck
```

Флаги для отладки в браузере: `?store=memory` (временное хранилище), `?store=fs` (iOS-хранилище через веб-реализацию Capacitor Filesystem).

## iOS

```bash
npm run ios:sync     # сборка и копирование в ios/
open ios/App/App.xcodeproj
```

Выпуск в TestFlight описан в [docs/RELEASE.md](docs/RELEASE.md), метаданные App Store — в [docs/APP_STORE.md](docs/APP_STORE.md), ручная проверка — в [docs/QA_CHECKLIST.md](docs/QA_CHECKLIST.md).

## Структура

```
src/core      пути, ZIP, предпросмотр, диагностика, поиск, шаблоны (без DOM-зависимостей, кроме preview)
src/storage   IndexedDB / Filesystem / Memory + Repository (лимиты, история, GC)
src/runtime   воркеры Python и PHP, Runner (stop, idle-выгрузка)
src/editor    CodeMirror
src/ui        представления, листы (доступные диалоги), журнал ошибок
src/app.ts    контроллер
public/preview-host.html   хост предпросмотра (sandbox, своя CSP)
ios/          Xcode-проект (Capacitor 8, SPM)
```

## Лицензии

Сторонние компоненты: MIT, ISC, 0BSD, MPL-2.0 (Pyodide), Apache-2.0 (php-wasm; выбран вариант из двойной лицензии Apache-2.0 OR GPL-2.0). Полный текст генерируется при сборке в `THIRD_PARTY_LICENSES.txt` и входит в приложение. Пакеты `@php-wasm/*` из WordPress Playground (GPL-2.0) намеренно **не** используются.

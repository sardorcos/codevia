# Выпуск в TestFlight

## Основной путь: Codemagic

Сборка и загрузка идут через **Codemagic**: приложение `codevia` (`6b01a13d65b613536e1a6b86`), конфигурация — [`codemagic.yaml`](../codemagic.yaml), workflow `ios-testflight`.

- **Подпись:** командный сертификат Apple Distribution `monetniy-mir-distribution` из Code signing identities в Codemagic (`environment.ios_signing.certificates`). Профиль App Store «Codevia Pocket App Store» для `com.codevia.pocket` лежит в App Store Connect, скрипт сборки скачивает его через интеграцию `monetniy-mir-asc`.
- **Если профиль стал недействительным** (например, после отзыва любого сертификата распространения), один раз запустите workflow `ios-signing-bootstrap`: он удалит недействительный профиль и создаст новый со всеми действующими сертификатами.
- **Проверка статуса:** workflow `testflight-status` (только чтение) показывает состояние обработки сборок в App Store Connect.
- **Номер сборки:** берётся из `BUILD_NUMBER` Codemagic, версия — из `MARKETING_VERSION` (1.0.0).
- **Запуск:** тег `v*` (`git tag v1.0.1 && git push origin v1.0.1`), кнопка **Start new build** в Codemagic или API:
  ```bash
  curl -H "x-auth-token: $CM_TOKEN" -H 'Content-Type: application/json' -X POST https://api.codemagic.io/builds \
    --data '{"appId":"6b01a13d65b613536e1a6b86","workflowId":"ios-testflight","branch":"main"}'
  ```
- **Результат:** сборка загружается в App Store Connect и после обработки (5–30 мин) появляется во вкладке TestFlight для внутренних тестировщиков. Для внешних тестировщиков заполните Test Information и отправьте сборку на Beta App Review.

Перед каждым релизом поднимайте `version` в `package.json` и `MARKETING_VERSION` в `ios/App/App.xcodeproj/project.pbxproj`.

## Запасной путь: GitHub Actions

Workflow `.github/workflows/testflight.yml` делает то же самое на раннерах GitHub. Он нужен, только если вы решите хранить ключ API в GitHub Secrets.



## Статус подготовки

| Шаг | Статус |
|---|---|
| Bundle ID `com.codevia.pocket` в Apple Developer | ✅ зарегистрирован |
| Приложение «Codevia Pocket» в App Store Connect (SKU `codevia-pocket-ios`, основной язык English (US)) | ✅ создано |
| Первая сборка в TestFlight | ✅ 1.0.0 (10), VALID, загружена через Codemagic 21.11.2026 |
| iOS-проект собирается на macOS (Xcode 26.6, Release, без подписи) | ✅ собирается в CI (задача `ios-build`), приложение 28 МБ |
| Карточка App Store (тексты ru/en, категории, 4+, бесплатно, 175 стран, 6+6 скриншотов, сборка 10, контакт и заметки для ревью) | ✅ применена `app-store-metadata` 21.11.2026 |
| App Privacy «Data Not Collected» и GitHub Pages | ⏳ вручную в браузере, см. `docs/CHROME_HANDOFF.md` |
| Отправка на App Review | ⏳ `app-store-submit` после двух шагов выше |

> Основной язык карточки — English (US), а интерфейс приложения русский. При заполнении метаданных добавьте локализацию **Russian**: App Store Connect → приложение → App Information → Localizable Information → «+». Тексты для обеих локализаций лежат в `docs/APP_STORE.md`.

## Осталось: ключ API и секреты (≈5 минут)

1. **Ключ API.** [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api):
   - при первом входе нажмите **Request Access** и примите условия;
   - **«+»** → Name `GitHub TestFlight`, Access **Admin** → **Generate**. Роль Admin нужна, чтобы Xcode мог сам создавать сертификат и профиль распространения (cloud signing);
   - запишите **Issuer ID** (над таблицей) и **Key ID** (в строке ключа);
   - **Download** → файл `AuthKey_XXXXXXXXXX.p8`. Скачать его можно **один раз**, сохраните.
2. **Team ID** — [developer.apple.com/account](https://developer.apple.com/account) → Membership details (10 символов).
3. **Секреты** — [github.com/sardorcos/codevia/settings/secrets/actions](https://github.com/sardorcos/codevia/settings/secrets/actions) → New repository secret:

   | Secret | Значение |
   |---|---|
   | `APPLE_TEAM_ID` | Team ID |
   | `ASC_KEY_ID` | Key ID |
   | `ASC_ISSUER_ID` | Issuer ID |
   | `ASC_API_PRIVATE_KEY` | весь текст файла `.p8`, включая строки `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` |

   Переменная `BUNDLE_ID` не нужна: по умолчанию используется `com.codevia.pocket`.

Ключи никогда не вставляйте в чат или в код — только в GitHub Secrets.

## Каждый релиз

- Actions → **TestFlight** → **Run workflow**, или
- тег вида `v1.0.0`: `git tag v1.0.0 && git push origin v1.0.0`.

Первым шагом workflow проверяет, что все четыре секрета заданы и имеют верный формат. Если чего-то не хватает, он сразу останавливается с понятной ошибкой, ничего не собирая.

Сборка идёт на раннере `macos-26` со **стабильным** Xcode 26.x (`scripts/select-xcode.sh`). Бета-версии Xcode пропускаются: App Store Connect не принимает собранные в них сборки.

Workflow сначала прогоняет все тесты (линт, типы, unit-тесты, E2E в Chromium и WebKit) и только потом собирает и загружает сборку. Номер сборки берётся из номера запуска, версия — из `package.json`.

Через 5–30 минут после загрузки сборка появится в App Store Connect → TestFlight. Внутренние тестировщики (до 100 человек из вашей команды) получат её сразу. Для внешних тестировщиков Apple проводит короткую бета-проверку (Beta App Review) — для неё понадобятся описание и контакт (см. `docs/APP_STORE.md`).

## Локально на Mac (без GitHub)

```bash
export APPLE_TEAM_ID=XXXXXXXXXX ASC_KEY_ID=XXXXXXXXXX ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx ASC_KEY_PATH=~/AuthKey_XXXXXXXXXX.p8
npm ci && ./scripts/ios-testflight.sh
```

Для отладки на своём iPhone: `npm run ios:sync`, затем откройте `ios/App/App.xcodeproj` в Xcode и нажмите Run.

## Чек-лист перед отправкой на ревью App Store

- [ ] Пройден ручной прогон на реальном iPhone по сценариям из `docs/QA_CHECKLIST.md`.
- [ ] Заполнены метаданные, скриншоты 6.9" (1320×2868) и ответы о конфиденциальности (`docs/APP_STORE.md`).
- [ ] Политика конфиденциальности (`docs/privacy.html`) опубликована по публичному URL, и этот URL указан в App Store Connect.
- [ ] Указан URL поддержки (страница или e-mail-форма).

# Выпуск в TestFlight

Сборка и загрузка полностью автоматизированы: workflow `.github/workflows/testflight.yml` на macOS собирает архив и загружает его в App Store Connect. Сертификаты и профили не нужны — Xcode создаёт их сам через ключ App Store Connect API (cloud signing).

## Статус подготовки

| Шаг | Статус |
|---|---|
| Bundle ID `com.codevia.pocket` в Apple Developer | ✅ зарегистрирован |
| Приложение «Codevia Pocket» в App Store Connect (SKU `codevia-pocket-ios`, основной язык English (US)) | ✅ создано |
| Ключ App Store Connect API | ⏳ нужно создать |
| Секреты в GitHub | ⏳ нужно добавить |
| iOS-проект собирается на macOS (Xcode 26, без подписи) | проверяется в CI, задача `ios-build` |

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

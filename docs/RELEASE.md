# Выпуск в TestFlight

Сборка и загрузка полностью автоматизированы: workflow `.github/workflows/testflight.yml` на macOS собирает архив и загружает его в App Store Connect. Сертификаты и профили не нужны — Xcode создаёт их сам через ключ App Store Connect API (cloud signing).

## Один раз: подготовка аккаунта Apple

1. **Apple Developer Program** — активная подписка ($99/год).
2. **App ID.** В [Certificates, IDs & Profiles](https://developer.apple.com/account/resources/identifiers/list) создайте идентификатор (Bundle ID), например `com.codevia.pocket`. Можно взять свой — тогда укажите его в переменной `BUNDLE_ID` (см. ниже).
3. **Запись приложения.** В [App Store Connect](https://appstoreconnect.apple.com/apps) → «+» → «Новое приложение»:
   - платформа iOS;
   - название «Codevia Pocket» (или другое свободное);
   - основной язык «Русский»;
   - Bundle ID из шага 2;
   - SKU — любой, например `codevia-pocket`.
4. **Ключ API.** App Store Connect → Users and Access → Integrations → App Store Connect API → «+». Роль **Admin**: она нужна, чтобы Xcode мог сам создавать сертификаты распространения. Скачайте файл `AuthKey_XXXXXXXXXX.p8` — его выдают **только один раз**. Запишите Key ID и Issuer ID.
5. **Team ID** — в [Membership details](https://developer.apple.com/account#MembershipDetailsCard).

## Один раз: репозиторий на GitHub

1. Создайте пустой приватный репозиторий и запушьте в него этот проект.
2. Settings → Secrets and variables → Actions → **Secrets**:

   | Secret | Значение |
   |---|---|
   | `APPLE_TEAM_ID` | Team ID |
   | `ASC_KEY_ID` | Key ID ключа API |
   | `ASC_ISSUER_ID` | Issuer ID |
   | `ASC_API_PRIVATE_KEY` | всё содержимое файла `.p8`, включая строки `-----BEGIN/END PRIVATE KEY-----` |

3. Если Bundle ID отличается от `com.codevia.pocket`, добавьте во вкладке **Variables** переменную `BUNDLE_ID`.

## Каждый релиз

- Actions → **TestFlight** → **Run workflow**, или
- тег вида `v1.0.0`: `git tag v1.0.0 && git push origin v1.0.0`.

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

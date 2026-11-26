# Создание GitHub App для входа в Codevia (один раз)

Вход в GitHub из приложения работает по коду (Device Flow): GitHub показывает код, пользователь подтверждает его на github.com. Для этого нужен GitHub App, принадлежащий разработчику. Секретов в приложении нет: в сборку попадает только публичный Client ID.

**Быстрый способ:** откройте https://sardorcos.github.io/codevia/github-app.html и нажмите «Создать GitHub App на GitHub». Форма GitHub заполнится сама (имя, сайт, права, без вебхука), после создания страница покажет Client ID. Останется включить **Enable Device Flow** и выключить **Expire user authorization tokens** в настройках приложения.

Ручной способ ниже можно передать сессии с Claude in Chrome.

---

Сделай только эти шаги, больше ничего не меняй.

1. Открой https://github.com/settings/apps/new (аккаунт **sardorcos**).
2. Заполни поля:
   - **GitHub App name:** `Codevia Pocket` (если имя занято, `Codevia Pocket App`);
   - **Homepage URL:** `https://sardorcos.github.io/codevia/`;
   - **Callback URL:** оставь пустым;
   - **Expire user authorization tokens:** **сними** галочку. Токен не будет истекать, и приложению не понадобится секрет для обновления;
   - **Request user authorization (OAuth) during installation:** поставь галочку;
   - **Enable Device Flow:** поставь галочку;
   - **Webhook → Active:** **сними** галочку;
   - **Repository permissions:**
     - Contents: **Read and write**
     - Metadata: **Read-only** (выбирается автоматически)
     - Pages: **Read and write**
     - Administration: **Read and write** (нужно для «Создать репозиторий» из приложения)
   - **Account permissions:** ничего не включай;
   - **Where can this GitHub App be installed?** выбери **Any account**.
3. Нажми **Create GitHub App**.
4. На странице приложения скопируй **Client ID** (начинается с `Iv23…`). **Не создавай** client secret и private key: они не нужны.
5. В разделе **Public page** скопируй ссылку вида `https://github.com/apps/<slug>`.

В конце сообщи пользователю Client ID и ссылку `https://github.com/apps/<slug>`. Это публичные значения, их можно писать в чат.

---

## Что сделает основная сессия

- Пропишет Client ID в `codemagic.yaml` (`VITE_GITHUB_CLIENT_ID`) и ссылку установки в приложение.
- Без Client ID приложение всё равно работает с GitHub через персональный токен (fine-grained PAT).

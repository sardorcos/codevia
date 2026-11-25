/** English texts for app-shell features added in 1.1 (console images, settings, packages, privacy). */
export default {
  'Изображение из программы': 'Image from the program',
  'Язык интерфейса': 'Language',
  'Как в системе': 'System default',
  Python: 'Python',
  'Загружать пакеты Python': 'Download Python packages',
  'Пакеты, которых нет в приложении, скачиваются при первом import с CDN Pyodide или PyPI и дальше работают офлайн.':
    'Packages that are not built in download on first import from the Pyodide CDN or PyPI, then work offline.',
  'Встроены (работают без интернета)': 'Built in (work offline)',
  'и их зависимости': 'and their dependencies',
  'Сеть используется только по вашему действию: загрузка пакетов Python, которых нет в приложении (CDN Pyodide, PyPI), запросы HTTP-клиента и работа с GitHub. У разработчика нет серверов — данные идут напрямую в эти сервисы.':
    'The network is used only when you act: downloading Python packages that are not built in (Pyodide CDN, PyPI), HTTP client requests, and GitHub. The developer runs no servers — data goes straight to these services.',
  'Если вы подключите GitHub, токен доступа хранится в Связке ключей iOS только на этом устройстве и отправляется только на github.com. Код проекта отправляется в ваш репозиторий только когда вы нажимаете «Отправить». Отключить доступ можно в настройках приложения и на github.com.':
    'If you connect GitHub, the access token is kept in the iOS Keychain on this device only and is sent only to github.com. Project code goes to your repository only when you tap Push. You can disconnect in the app settings and on github.com.',
  'TypeScript и JSX': 'TypeScript and JSX',
  'Встроенные пакеты Python (полные тексты лицензий — ниже)': 'Built-in Python packages (full licence texts below)',
  Инструменты: 'Tools',
  'Сначала откройте проект': 'Open a project first',
  'История файла': 'File history',
  'Читаю историю…': 'Reading history…',
  'У этого файла ещё нет сохранённых версий. Версии создаются при «Сохранить версию» и автоматически перед изменениями.':
    'This file has no saved versions yet. Versions are made with “Save version” and automatically before changes.',
  'Версия повреждена или удалена': 'The version is damaged or was deleted',
  'Сравнение версии «{label}» с текущим файлом: −{removed} / +{added}': 'Version “{label}” compared with the current file: −{removed} / +{added}',
  'Без изменений: {count}': '{count} unchanged line|{count} unchanged lines',
  'Двоичный файл: {size}': 'Binary file: {size}',
  'Восстановить эту версию': 'Restore this version',
  'Перед восстановлением {name}': 'Before restoring {name}',
  'Файл восстановлен: {name}': 'File restored: {name}',
} as Record<string, string>;

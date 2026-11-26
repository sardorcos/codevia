/**
 * User-facing texts for GitHub errors and warnings, translated by key. The core keeps one English
 * map (GITHUB_MESSAGES / SECRET_MESSAGES); here every key gets a Russian t() string whose English
 * text lives in src/i18n/en/github.ts.
 */
import { fmtNumber, t } from '../../i18n';
import { GitHubError, type GitHubMessageKey } from '../../github/errors';
import type { SecretReason } from '../../github/secrets';
import type { RepoNameProblem } from './parse';

/** One entry per key of GITHUB_MESSAGES (a unit test checks there is none missing). */
export function githubMessageTexts(): Record<GitHubMessageKey, string> {
  return {
    auth: t('GitHub не принял вход. Подключите аккаунт заново.'),
    not_found: t('Не найдено на GitHub, или у приложения нет к этому доступа.'),
    conflict: t('Ветка изменилась на GitHub. Сначала получите изменения, затем отправьте снова.'),
    rate_limit: t('Достигнут лимит запросов к GitHub. Попробуйте позже.'),
    network: t('Не удалось связаться с GitHub. Проверьте подключение к интернету.'),
    validation: t('GitHub отклонил запрос.'),
    unknown: t('Что-то пошло не так при обращении к GitHub.'),
    forbidden: t('У приложения нет на это прав. Проверьте на GitHub, к каким репозиториям у него есть доступ.'),
    session_expired: t('Сеанс GitHub истёк. Подключите аккаунт заново.'),
    host_not_allowed: t('Этот адрес не разрешён.'),
    device_flow_unavailable: t('Вход через GitHub не настроен в этой сборке. Используйте персональный токен доступа.'),
    device_code_expired: t('Срок действия кода истёк. Начните подключение заново.'),
    access_denied: t('Доступ отклонён на GitHub.'),
    invalid_token: t('Этот токен недействителен. Проверьте, что он скопирован полностью.'),
    repo_empty: t('Этот репозиторий пуст.'),
    repo_too_large: t('Этот репозиторий слишком большой для загрузки.'),
    tree_truncated: t('В этом репозитории слишком много файлов. Выберите подпапку для работы.'),
    subdir_not_found: t('Такой папки нет в репозитории.'),
    zip_invalid: t('Не удалось прочитать архив репозитория.'),
    nothing_to_push: t('Нет изменений для отправки.'),
  };
}

/** One entry per key of SECRET_MESSAGES. */
export function secretTexts(): Record<SecretReason, string> {
  return {
    env_file: t('Файл окружения: обычно в нём пароли и ключи API.'),
    key_file: t('Файл ключа или сертификата.'),
    github_token: t('Содержит что-то похожее на токен GitHub.'),
    api_key: t('Содержит что-то похожее на ключ API.'),
    aws_key: t('Содержит что-то похожее на ключ доступа AWS.'),
    private_key: t('Содержит закрытый ключ.'),
  };
}

export const secretText = (reason: SecretReason): string => secretTexts()[reason];

export function repoNameText(problem: RepoNameProblem): string {
  switch (problem) {
    case 'empty':
      return t('Введите имя репозитория.');
    case 'too_long':
      return t('Имя не длиннее 100 символов.');
    case 'chars':
      return t('Можно только латинские буквы, цифры, «-», «_» и «.».');
    case 'reserved':
      return t('Это имя зарезервировано.');
    case 'git_suffix':
      return t('Имя не может заканчиваться на «.git».');
  }
}

export const isAbortError = (e: unknown): boolean =>
  !!e && typeof e === 'object' && ((e as { name?: string }).name === 'AbortError' || (e as { name?: string }).name === 'CancelledError');

/** The project changed while a pull was being prepared. */
export class StaleProjectError extends Error {
  constructor() {
    super('Project changed during the operation');
    this.name = 'StaleProjectError';
  }
}

/** A GitHub Pages build failed; `detail` is GitHub's own message. */
export class PagesBuildError extends Error {
  constructor(readonly detail: string | null) {
    super('Pages build failed');
    this.name = 'PagesBuildError';
  }
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Human-friendly text for any error of a GitHub action. Never includes tokens: GitHub errors are
 * shown by key only, and other errors by a fixed text.
 */
export function errorText(e: unknown): string {
  if (e instanceof GitHubError) {
    const text = githubMessageTexts()[e.key] ?? githubMessageTexts().unknown;
    if (e.code === 'rate_limit' && e.resetAt && e.resetAt > Date.now()) {
      const minutes = Math.ceil((e.resetAt - Date.now()) / 60000);
      return `${text} ${minutes <= 60 ? t('Можно снова через {count} мин.', { count: fmtNumber(minutes) }) : t('Можно снова после {time}.', { time: fmtTime(e.resetAt) })}`;
    }
    return text;
  }
  if (e instanceof StaleProjectError) return t('Файлы проекта изменились, пока шла операция. Попробуйте ещё раз.');
  if (e instanceof PagesBuildError) return t('Сборка сайта на GitHub завершилась с ошибкой.');
  if (isAbortError(e)) return t('Отменено.');
  return t('Что-то пошло не так при обращении к GitHub.');
}

export type StageName =
  | 'reading'
  | 'downloading'
  | 'unpacking'
  | 'verifying'
  | 'creating'
  | 'uploading'
  | 'committing'
  | 'updating'
  | 'saving'
  | 'enabling'
  | 'building';

/** Progress line for a step of a GitHub action. */
export function stageText(stage: StageName, context: 'clone' | 'pull' | 'push' | 'repo' | 'pages' = 'push'): string {
  switch (stage) {
    case 'reading':
      return t('Читаем репозиторий…');
    case 'downloading':
      return context === 'clone' ? t('Скачиваем архив…') : t('Скачиваем изменения…');
    case 'unpacking':
      return t('Распаковываем и проверяем файлы…');
    case 'verifying':
      return t('Докачиваем отдельные файлы…');
    case 'creating':
      return context === 'repo' ? t('Создаём репозиторий…') : t('Создаём проект…');
    case 'uploading':
      return t('Загружаем файлы…');
    case 'committing':
      return t('Создаём коммит…');
    case 'updating':
      return t('Обновляем ветку…');
    case 'saving':
      return t('Сохраняем…');
    case 'enabling':
      return t('Включаем GitHub Pages…');
    case 'building':
      return t('GitHub собирает сайт…');
  }
}

/** True for errors after which the user has to connect the account again. */
export const needsSignIn = (e: unknown): boolean => e instanceof GitHubError && e.code === 'auth' && e.key !== 'forbidden' && e.key !== 'access_denied';

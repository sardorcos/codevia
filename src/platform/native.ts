import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { Keyboard } from '@capacitor/keyboard';
import { Share } from '@capacitor/share';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import { bytesToBase64 } from '../core/bytes';

export const isNative = (): boolean => Capacitor.isNativePlatform();

export async function initNativeChrome(onKeyboard: (open: boolean) => void): Promise<void> {
  if (isNative()) {
    await StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined);
    await Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => undefined);
    void Keyboard.addListener('keyboardWillShow', () => onKeyboard(true));
    void Keyboard.addListener('keyboardWillHide', () => onKeyboard(false));
    await SplashScreen.hide().catch(() => undefined);
  } else if (window.visualViewport) {
    const vv = window.visualViewport;
    const update = () => onKeyboard(window.innerHeight - vv.height > 140);
    vv.addEventListener('resize', update);
  }
}

export function haptic(kind: 'light' | 'success' | 'warning' | 'error' = 'light'): void {
  if (!isNative()) return;
  if (kind === 'light') void Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
  else
    void Haptics.notification({
      type: kind === 'success' ? NotificationType.Success : kind === 'warning' ? NotificationType.Warning : NotificationType.Error,
    }).catch(() => undefined);
}

/**
 * Saves/shares a file. On iOS this opens the system share sheet ("Save to Files", AirDrop, Mail…);
 * in a browser it triggers a regular download.
 */
export async function shareFile(data: Blob | Uint8Array | string, filename: string, mime: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
  if (isNative()) {
    const path = `exports/${Date.now()}-${filename}`;
    // Written in 3 MB slices (a multiple of 3 bytes, so each base64 chunk decodes on its own): a big
    // backup never exists as one giant base64 string crossing the bridge (audit 3, R11).
    const CHUNK = 3 * 1024 * 1024;
    let uri = '';
    for (let off = 0; off === 0 || off < blob.size; off += CHUNK) {
      const data = bytesToBase64(new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer()));
      if (off === 0) uri = (await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true })).uri;
      else await Filesystem.appendFile({ path, data, directory: Directory.Cache });
    }
    try {
      await Share.share({ title: filename, files: [uri] });
      return 'shared';
    } catch (e) {
      if (/cancel/i.test(String((e as Error)?.message ?? e))) return 'cancelled';
      throw e;
    } finally {
      void Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return 'downloaded';
}

/** Opens a web page outside the app's content: an in-app Safari sheet on iOS, a new tab on the web. */
export async function openUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (isNative()) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url, presentationStyle: 'popover' });
    return;
  }
  window.open(url, '_blank', 'noopener');
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** Opens the system file picker. Resolves with the chosen files (empty array if cancelled). */
export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.append(input);
    let settled = false;
    const done = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    input.click();
  });
}

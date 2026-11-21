import { decodeUtf8Strict } from './bytes';
import { isTextPath } from './paths';
import { binaryFile, textFile, type ProjectFile } from './types';

/**
 * Turns raw bytes into a project file. Only valid UTF-8 becomes editable text; anything else
 * (Windows-1251, UTF-16, real binaries without an extension) is kept byte-for-byte as binary,
 * so importing never corrupts a file. Legacy text can be converted explicitly later.
 */
export function toProjectFile(path: string, bytes: Uint8Array): ProjectFile {
  if (isTextPath(path)) {
    const text = decodeUtf8Strict(bytes);
    if (text !== null && !text.includes('\u0000')) return textFile(text);
  }
  return binaryFile(bytes);
}

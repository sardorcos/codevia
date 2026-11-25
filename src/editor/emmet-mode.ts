import { extOf } from '../core/paths';

/** Emmet syntax of a file (light module: the Emmet plugin itself is loaded lazily, see emmet-lazy.ts). */
export type EmmetMode = 'html' | 'xml' | 'css' | 'scss' | 'less' | 'jsx' | 'tsx' | 'markdown';

export function emmetModeFor(path: string): EmmetMode | null {
  switch (extOf(path)) {
    case 'html':
    case 'htm':
    case 'php':
    case 'phtml':
      return 'html';
    case 'svg':
    case 'xml':
      return 'xml';
    case 'css':
    case 'scss':
    case 'less':
      return extOf(path) as 'css' | 'scss' | 'less';
    case 'jsx':
    case 'tsx':
      return extOf(path) as 'jsx' | 'tsx';
    case 'md':
    case 'markdown':
      return 'markdown';
    default:
      return null;
  }
}

// The `emmet` package ships types, but its package.json "exports" hides them from TypeScript's
// bundler resolution. Declares the two functions the editor uses.
declare module 'emmet' {
  export interface ExtractedAbbreviation {
    abbreviation: string;
    location: number;
    start: number;
    end: number;
  }
  export function extract(
    line: string,
    pos?: number,
    options?: { type?: 'markup' | 'stylesheet'; lookAhead?: boolean; prefix?: string },
  ): ExtractedAbbreviation | undefined;
  export default function expandAbbreviation(
    abbr: string,
    config?: { type?: 'markup' | 'stylesheet'; syntax?: string; options?: Record<string, unknown> },
  ): string;
}

// Trimmed: the vendored modules only need an element shape and the font-family mapping.
export interface ServerElement {
  id: string;
  type: string;
  [key: string]: unknown;
}
export declare function normalizeFontFamily(fontFamily: string | number | undefined): number | undefined;

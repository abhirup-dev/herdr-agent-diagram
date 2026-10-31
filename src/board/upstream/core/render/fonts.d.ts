export interface FontMetrics {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    lineHeight: number;
}
export interface FontEntry {
    id: number;
    family: string;
    renderFamily: string;
    file: string;
    metrics: FontMetrics;
    substituted?: boolean;
}
export declare const DEFAULT_FONT_FAMILY = 5;
export declare function getFontEntry(fontFamily: number | string | undefined): FontEntry;
export declare function getFontEntryByFamilyName(family: string): FontEntry | undefined;
export declare function collectFontEntriesFromSvg(svg: string): FontEntry[];
export declare function fontFilePath(entry: FontEntry): string;
export declare function getLineHeightInPx(fontSize: number, lineHeight: number): number;
export declare function getVerticalOffset(fontFamily: number | string | undefined, fontSize: number, lineHeightPx: number): number;
export declare function collectFontEntries(elements: ReadonlyArray<{
    type?: string;
    fontFamily?: number | string;
}>): FontEntry[];
export declare function fontFilesFor(entries: FontEntry[]): string[];
export declare function rewriteFontFamilies(svg: string, entries: FontEntry[]): string;
export declare function fontFaceCss(entries: FontEntry[]): string;
export declare function needsSystemFonts(elements: ReadonlyArray<{
    type?: string;
    text?: string;
}>): boolean;
export declare function substitutedFamilies(entries: FontEntry[]): string[];

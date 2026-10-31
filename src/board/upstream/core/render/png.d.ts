export interface PngOptions {
    scale: number;
    fontFiles: string[];
    loadSystemFonts: boolean;
    defaultFontFamily: string;
}
export interface PngResult {
    data: Buffer;
    width: number;
    height: number;
}
export declare function inlineSymbolImages(svg: string): string;
export declare function svgToPng(svg: string, options: PngOptions): PngResult;

export type RenderFormat = 'png' | 'svg';
export type RendererName = 'auto' | 'node' | 'browser';
export interface RenderOptions {
    format: RenderFormat;
    background?: boolean;
    viewBackgroundColor?: string;
    dark?: boolean;
    scale?: number;
    padding?: number;
    elementIds?: string[];
    frameId?: string;
    embedFonts?: boolean;
    systemFonts?: boolean;
}
export interface RenderableScene {
    elements: Record<string, any>[];
    files: Record<string, any>;
}
export interface RenderResult {
    format: RenderFormat;
    data: string;
    width: number;
    height: number;
    warnings: string[];
}
export declare class RenderError extends Error {
    status: 400 | 404;
    constructor(message: string, status?: 400 | 404);
}
export declare const MAX_SCALE = 4;
export declare const DEFAULT_PADDING = 10;
export declare const DEFAULT_MAX_DIMENSION = 8192;
export declare function maxDimension(): number;
export declare function validateRenderOptions(options: RenderOptions): Required<Omit<RenderOptions, 'elementIds' | 'frameId' | 'systemFonts'>> & Pick<RenderOptions, 'elementIds' | 'frameId' | 'systemFonts'>;
export declare function selectElements(elements: Record<string, any>[], elementIds: string[]): Record<string, any>[];
export declare function findFrame(elements: Record<string, any>[], frameId: string): Record<string, any>;
export declare function renderScene(scene: RenderableScene, rawOptions: RenderOptions): Promise<RenderResult>;

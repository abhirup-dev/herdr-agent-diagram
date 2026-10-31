export interface ExcalidrawSvgOptions {
    background: boolean;
    viewBackgroundColor: string;
    dark: boolean;
    padding: number;
    exportingFrame?: Record<string, any> | null;
}
export declare function prepareScene(elements: Record<string, any>[]): Promise<Record<string, any>[]>;
export declare function renderSvgWithExcalidraw(preparedElements: Record<string, any>[], files: Record<string, any>, options: ExcalidrawSvgOptions): Promise<string>;

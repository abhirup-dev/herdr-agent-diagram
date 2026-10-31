export interface ExcalidrawNodeModule {
    exportToSvg: (opts: {
        elements: readonly any[];
        appState?: Record<string, unknown>;
        files: Record<string, any> | null;
        exportPadding?: number;
        renderEmbeddables?: boolean;
        exportingFrame?: any | null;
        skipInliningFonts?: true;
        reuseImages?: boolean;
    }) => Promise<any>;
    restoreElements: (elements: readonly any[] | null | undefined, localElements: readonly any[] | null | undefined, opts?: {
        refreshDimensions?: boolean;
        repairBindings?: boolean;
    }) => any[];
    getCommonBounds: (elements: readonly any[]) => [number, number, number, number];
    FONT_FAMILY: Record<string, number>;
    prepareServerScene: (elements: readonly any[]) => any[];
    cleanElementForExcalidraw: (element: any) => any;
}
export declare function getDomWindow(): any;
export declare function loadExcalidrawNode(): Promise<ExcalidrawNodeModule>;

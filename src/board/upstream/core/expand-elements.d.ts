import { ServerElement } from '../types.js';
export interface ExpandOptions {
    deterministic?: boolean;
}
export declare function canonicalizeKeys(v: any): any;
export declare function orderKey(n: number): string;
export declare function fnv1a(str: string): number;
export declare function expandElementsForExport(sourceElements: ServerElement[], options?: ExpandOptions): Record<string, any>[];

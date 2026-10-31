// Trimmed from mcp-excalidraw-server 2.1.2 dist/types.js: only what the vendored renderer and export use.
export function normalizeFontFamily(fontFamily) {
    if (fontFamily === undefined)
        return undefined;
    if (typeof fontFamily === 'number')
        return fontFamily;
    const map = {
        'virgil': 1, 'hand': 1, 'handwritten': 1,
        'helvetica': 2, 'sans': 2, 'sans-serif': 2,
        'cascadia': 3, 'mono': 3, 'monospace': 3,
        'excalifont': 5,
        'nunito': 6,
        'lilita': 7, 'lilita one': 7,
        'comic shanns': 8, 'comic': 8,
        '1': 1, '2': 2, '3': 3, '5': 5, '6': 6, '7': 7, '8': 8,
    };
    return map[fontFamily.toLowerCase()];
}

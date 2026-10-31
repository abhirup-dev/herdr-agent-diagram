import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeFontFamily } from '../../types.js';
// dist/core/render/fonts.js -> <package root>/assets/fonts
const FONTS_DIR = fileURLToPath(new URL('../../../assets/fonts/', import.meta.url));
const EXCALIFONT = 'Excalifont-Regular.ttf';
const VIRGIL = 'Virgil-Regular.ttf';
const CASCADIA = 'CascadiaCode-Regular.ttf';
const LIBERATION = 'LiberationSans-Regular.ttf';
const HAND_DRAWN_METRICS = { unitsPerEm: 1000, ascender: 886, descender: -374, lineHeight: 1.25 };
export const DEFAULT_FONT_FAMILY = 5; // Excalifont, Excalidraw's default
const REGISTRY = {
    1: { id: 1, family: 'Virgil', renderFamily: 'Virgil', file: VIRGIL, metrics: HAND_DRAWN_METRICS },
    2: { id: 2, family: 'Helvetica', renderFamily: 'Liberation Sans', file: LIBERATION,
        metrics: { unitsPerEm: 2048, ascender: 1577, descender: -471, lineHeight: 1.15 } },
    3: { id: 3, family: 'Cascadia', renderFamily: 'Cascadia Code', file: CASCADIA,
        metrics: { unitsPerEm: 2048, ascender: 1900, descender: -480, lineHeight: 1.2 } },
    5: { id: 5, family: 'Excalifont', renderFamily: 'Excalifont', file: EXCALIFONT, metrics: HAND_DRAWN_METRICS },
    6: { id: 6, family: 'Nunito', renderFamily: 'Liberation Sans', file: LIBERATION, substituted: true,
        metrics: { unitsPerEm: 1000, ascender: 1011, descender: -353, lineHeight: 1.35 } },
    7: { id: 7, family: 'Lilita One', renderFamily: 'Liberation Sans', file: LIBERATION, substituted: true,
        metrics: { unitsPerEm: 1000, ascender: 923, descender: -220, lineHeight: 1.15 } },
    8: { id: 8, family: 'Comic Shanns', renderFamily: 'Cascadia Code', file: CASCADIA, substituted: true,
        metrics: { unitsPerEm: 1000, ascender: 750, descender: -250, lineHeight: 1.25 } },
    9: { id: 9, family: 'Liberation Sans', renderFamily: 'Liberation Sans', file: LIBERATION,
        metrics: { unitsPerEm: 2048, ascender: 1854, descender: -434, lineHeight: 1.15 } }
};
export function getFontEntry(fontFamily) {
    const id = normalizeFontFamily(fontFamily) ?? DEFAULT_FONT_FAMILY;
    return REGISTRY[id] ?? REGISTRY[DEFAULT_FONT_FAMILY];
}
// Families as they appear in `font-family` attributes of exporter output
// (which also includes labels the exporter synthesizes, like frame names).
export function getFontEntryByFamilyName(family) {
    return Object.values(REGISTRY).find(entry => entry.family === family);
}
export function collectFontEntriesFromSvg(svg) {
    const seen = new Map();
    for (const match of svg.matchAll(/font-family="([^",]+)/g)) {
        const entry = getFontEntryByFamilyName((match[1] ?? '').trim());
        if (entry)
            seen.set(entry.id, entry);
    }
    if (seen.size === 0)
        seen.set(DEFAULT_FONT_FAMILY, REGISTRY[DEFAULT_FONT_FAMILY]);
    return [...seen.values()];
}
export function fontFilePath(entry) {
    return path.join(FONTS_DIR, entry.file);
}
// Excalidraw: lineHeight is a unitless multiplier of fontSize.
export function getLineHeightInPx(fontSize, lineHeight) {
    return fontSize * lineHeight;
}
// Distance from the top of a line box to its alphabetic baseline — the `y`
// Excalidraw gives each <text> line. Ported from Excalidraw's Fonts.ts.
export function getVerticalOffset(fontFamily, fontSize, lineHeightPx) {
    const { unitsPerEm, ascender, descender } = getFontEntry(fontFamily).metrics;
    const fontSizeEm = fontSize / unitsPerEm;
    const lineGap = (lineHeightPx - fontSizeEm * ascender + fontSizeEm * descender) / 2;
    return fontSizeEm * ascender + lineGap;
}
// Collect the families a scene's text uses so we only load/embed those fonts.
export function collectFontEntries(elements) {
    const seen = new Map();
    for (const el of elements) {
        if (el.type !== 'text')
            continue;
        const entry = getFontEntry(el.fontFamily);
        seen.set(entry.id, entry);
    }
    if (seen.size === 0)
        seen.set(DEFAULT_FONT_FAMILY, REGISTRY[DEFAULT_FONT_FAMILY]);
    return [...seen.values()];
}
// Unique TTF paths for resvg's `font.fontFiles`.
export function fontFilesFor(entries) {
    return [...new Set(entries.map(fontFilePath))];
}
// Rewrite Excalidraw family names to the names inside our TTFs. Applied to the
// whole SVG text (attribute values only), so it works for both the Excalidraw
// exporter's output and our own.
export function rewriteFontFamilies(svg, entries) {
    let out = svg;
    for (const entry of entries) {
        if (entry.family === entry.renderFamily)
            continue;
        const pattern = new RegExp(`(font-family=["'])${escapeRegExp(entry.family)}(?=[,"'])`, 'g');
        out = out.replace(pattern, `$1${entry.renderFamily}`);
    }
    return out;
}
const base64Cache = new Map();
function fontBase64(file) {
    let cached = base64Cache.get(file);
    if (!cached) {
        cached = fs.readFileSync(file).toString('base64');
        base64Cache.set(file, cached);
    }
    return cached;
}
// @font-face rules embedding the used TTFs so the SVG renders with the right
// glyphs anywhere (browsers, editors, GitHub), like the tab's export does.
export function fontFaceCss(entries) {
    const byRenderFamily = new Map();
    for (const entry of entries)
        byRenderFamily.set(entry.renderFamily, entry);
    return [...byRenderFamily.values()]
        .map(entry => `@font-face { font-family: "${entry.renderFamily}"; src: url(data:font/ttf;base64,${fontBase64(fontFilePath(entry))}) format("truetype"); }`)
        .join('\n');
}
// Bundled fonts cover Latin scripts. For CJK and other scripts resvg needs
// the machine's own fonts, at the cost of cross-machine determinism.
export function needsSystemFonts(elements) {
    for (const el of elements) {
        if (el.type !== 'text' || typeof el.text !== 'string')
            continue;
        for (const ch of el.text) {
            const code = ch.codePointAt(0) ?? 0;
            if (code > 0x024f && !(code >= 0x2000 && code <= 0x206f))
                return true;
        }
    }
    return false;
}
export function substitutedFamilies(entries) {
    return entries.filter(e => e.substituted).map(e => `${e.family} rendered with ${e.renderFamily}`);
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

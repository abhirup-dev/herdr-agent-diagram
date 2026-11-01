import { loadExcalidrawNode, getDomWindow } from './dom.js';
import { alignContainerLabels, placeArrowLabels, labelsForSvg } from '../../../../layout.ts';
import { fnv1a } from '../../expand-elements.js';
const SERVER_ONLY_KEYS = ['createdAt', 'updatedAt', 'syncedAt', 'source', 'syncTimestamp'];
// Seeds drive roughjs's hand-drawn jitter. Server elements usually carry
// none, and Excalidraw would pick random ones — derive them from the id so
// an unchanged scene renders byte-identically.
function withDeterministicSeeds(element) {
    const seeded = { ...element };
    for (const key of SERVER_ONLY_KEYS)
        delete seeded[key];
    if (typeof seeded.seed !== 'number')
        seeded.seed = (fnv1a(`${seeded.id}:seed`) % 2147483646) + 1;
    if (typeof seeded.versionNonce !== 'number')
        seeded.versionNonce = (fnv1a(`${seeded.id}:nonce`) % 2147483646) + 1;
    return seeded;
}
// Turn canvas-server elements (agent shorthand like label/start/end) or
// native Excalidraw elements into the scene the canvas tab would display.
// This is the tab's own preparation code (frontend/src/utils/scene.ts:
// convertToExcalidrawElements + bound-text centering + restore), bundled in,
// so headless renders match what the user sees.
export async function prepareScene(elements) {
    const mod = await loadExcalidrawNode();
    return placeArrowLabels(alignContainerLabels(mod.prepareServerScene(elements.map(withDeterministicSeeds)), elements));
}
export async function renderSvgWithExcalidraw(preparedElements, files, options) {
    const mod = await loadExcalidrawNode();
    const win = getDomWindow();
    const svg = await mod.exportToSvg({
        elements: labelsForSvg(preparedElements),
        appState: {
            exportBackground: options.background,
            viewBackgroundColor: options.viewBackgroundColor,
            exportWithDarkMode: options.dark,
            exportScale: 1,
            exportEmbedScene: false,
            // Same frame rendering as the live tab
            frameRendering: { enabled: true, name: true, outline: true, clip: true }
        },
        files,
        exportPadding: options.padding,
        exportingFrame: options.exportingFrame ?? null,
        skipInliningFonts: true,
        renderEmbeddables: false
    });
    // Excalidraw sets an explicit xmlns attribute; jsdom's serializer also emits
    // the namespace declaration, producing a duplicate attribute that XML
    // parsers reject. Browsers dedupe it, so drop the explicit one here.
    svg.removeAttribute('xmlns');
    return new win.XMLSerializer().serializeToString(svg);
}

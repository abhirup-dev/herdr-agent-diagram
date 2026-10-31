// Fails when the built mod uses something Herdr's mod runtime (embedded V8: no DOM, no Node, no Intl,
// no WebAssembly, no legacy RegExp statics, no timers) does not have. Catches it at build time instead of
// as a blank pane. Usage: bun scripts/check-bundle.ts <bundle.js>
const file = process.argv[2];
if (!file) throw new Error("usage: bun scripts/check-bundle.ts <bundle.js>");
const code = await Bun.file(file).text();
const banned: readonly [RegExp, string][] = [
  [/RegExp\.\$\d/, "legacy RegExp.$n statics (use match results)"],
  [/\bTextDecoder\b|\bTextEncoder\b/, "TextDecoder/TextEncoder"],
  [/\bsetTimeout\b|\bsetInterval\b/, "timers (use cx.timer)"],
  [/\bdocument\.|\bwindow\.document\b/, "the DOM"],
  [/\bIntl\./, "Intl (V8 built without ICU)"],
  [/\bWebAssembly\b/, "WebAssembly"],
  [/\brequire\(/, "CommonJS require"],
];
const hits = banned.filter(([re]) => re.test(code)).map(([, what]) => what);
if (hits.length) {
  console.error(`${file} uses what the Herdr mod runtime lacks:\n  - ${hits.join("\n  - ")}`);
  process.exit(1);
}
console.log(`${file}: runtime check ok (${(code.length / 1024).toFixed(1)} KB)`);

export {};

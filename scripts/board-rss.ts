// Measures the sidecar's resident memory with 1, 5 and 10 boards. Each board gets a small diagram, a screenshot
// (so the SDK and jsdom are really loaded) and a subscribed mod socket (so its scene is converted).
//   bun scripts/board-rss.ts [port]      (default 3299; starts and stops its own sidecar)
import { execFileSync } from "node:child_process";

const port = Number(process.argv[2] ?? 3299);
const base = `http://127.0.0.1:${port}`;
const sidecar = Bun.spawn([process.execPath, `${import.meta.dir}/../src/sidecar/main.ts`], {
  env: { ...process.env, CANVAS_SIDECAR_PORT: String(port) },
  stderr: "ignore",
});
const rssMb = () =>
  Number(
    execFileSync("ps", ["-o", "rss=", "-p", String(sidecar.pid)])
      .toString()
      .trim(),
  ) / 1024;
const post = async (path: string, body: unknown) => {
  const res = await fetch(base + path, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
};

async function waitUp(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(`${base}/health`).then(
        (r) => r.ok,
        () => false,
      )
    )
      return;
    await Bun.sleep(100);
  }
  throw new Error("sidecar did not start");
}

const diagram = (b: string) =>
  Array.from({ length: 6 }, (_, i) => [
    { id: `${b}-n${i}`, type: "rectangle", x: i * 200, y: 0, width: 160, height: 60, label: { text: `Step ${i}` } },
    ...(i
      ? [{ id: `${b}-a${i}`, type: "arrow", x: 0, y: 0, start: { id: `${b}-n${i - 1}` }, end: { id: `${b}-n${i}` } }]
      : []),
  ]).flat();

const sockets: WebSocket[] = [];
async function addBoard(id: string): Promise<void> {
  await post(`/b/${id}/api/elements/batch`, { elements: diagram(id) });
  await post(`/b/${id}/api/export/image`, { format: "png" });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.send(JSON.stringify({ type: "subscribe", board: id }));
  sockets.push(ws);
}

try {
  await waitUp();
  const rows = [`| boards | sidecar RSS (MB) |`, `|---|---|`, `| 0 (idle) | ${rssMb().toFixed(0)} |`];
  let made = 0;
  for (const n of [1, 5, 10]) {
    while (made < n) await addBoard(`t${++made}`);
    await Bun.sleep(500);
    rows.push(`| ${n} | ${rssMb().toFixed(0)} |`);
  }
  console.log(rows.join("\n"));
} finally {
  for (const ws of sockets) ws.close();
  sidecar.kill();
}

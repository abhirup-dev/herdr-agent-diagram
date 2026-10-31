// Spike (hd-jf3.7.1): which pipe can carry a long-lived NDJSON stream to a remote machine?
// Usage: source /tmp/herdr-iso/c/env.sh && /opt/homebrew/bin/bun scripts/bridge-spike.ts [machine] [ssh-target]
// Measures hc exec (per-call RPC), an ssh stdio pipe and an ssh -L websocket tunnel against an echo
// endpoint run with `bun -e` (nothing is written on the remote), then kills links and checks for orphans.
import { createServer } from "node:net";

const machine = process.argv[2] ?? "vpsme";
const target = process.argv[3] ?? machine;
const remoteBun = "/usr/local/bin/bun";
const tag = `hd-spike-${process.pid}`;
const SSH = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2"];

// Echo endpoint: replies to each line, exits on stdin EOF or after 15 s without input (a hung link).
const ECHO = `let last=Date.now();setInterval(()=>{if(Date.now()-last>15000)process.exit(3)},500);
let buf="";for await(const c of process.stdin){last=Date.now();buf+=c;let i;
while((i=buf.indexOf("\\n"))>=0){process.stdout.write(buf.slice(0,i+1));buf=buf.slice(i+1)}}process.exit(0)`;
const WS_ECHO = `const s=Bun.serve({port:0,hostname:"127.0.0.1",fetch(r,s){return s.upgrade(r)?undefined:new Response("x")},
websocket:{message(w,m){w.send(m)}}});console.log(s.port);setTimeout(()=>process.exit(0),120000)`;

const ms = (t0: number) => performance.now() - t0;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)] ?? Number.NaN;
const fmt = (xs: number[]) => `p50 ${pct(xs, 0.5).toFixed(1)} ms, p95 ${pct(xs, 0.95).toFixed(1)} ms (n=${xs.length})`;
const line = (bytes: number, seq: number) => `${JSON.stringify({ seq, pad: "x".repeat(Math.max(0, bytes - 30)) })}\n`;

type Pipe = { send(s: string): void; next(): Promise<string>; proc: Bun.Subprocess<"pipe", "pipe", "inherit"> };

function openPipe(argv: string[]): Pipe {
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const lines: string[] = [];
  return {
    proc,
    send: (s) => {
      proc.stdin.write(s);
      proc.stdin.flush();
    },
    async next() {
      while (!lines.length) {
        const { value, done } = await reader.read();
        if (done) throw new Error("eof");
        buf += dec.decode(value, { stream: true });
        let i = buf.indexOf("\n");
        while (i >= 0) {
          lines.push(buf.slice(0, i));
          buf = buf.slice(i + 1);
          i = buf.indexOf("\n");
        }
      }
      return lines.shift() as string;
    },
  };
}

const sshPipe = () => openPipe([...SSH, target, `exec ${remoteBun} -e '${ECHO.replaceAll("'", "'\\''")}' ${tag}`]);

async function remoteOrphans(): Promise<number> {
  // "[h]d-…" so the remote shell running pgrep doesn't match itself.
  const out = await new Response(
    Bun.spawn([...SSH, target, `pgrep -fc '[${tag[0]}]${tag.slice(1)}' || true`]).stdout,
  ).text();
  return Number(out.trim());
}

async function rtt(p: Pipe, n: number, bytes: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    p.send(line(bytes, i));
    const r = await p.next();
    if (!r.includes(`"seq":${i},`)) throw new Error(`out of order: ${r.slice(0, 40)}`);
    out.push(ms(t0));
  }
  return out;
}

async function throughput(p: Pipe, n: number, bytes: number): Promise<string> {
  const t0 = performance.now();
  const reading = (async () => {
    for (let i = 0; i < n; i++) await p.next();
  })();
  for (let i = 0; i < n; i++) p.send(line(bytes, i));
  await reading;
  const s = ms(t0) / 1000;
  return `${n} x ${bytes} B: ${(n / s).toFixed(0)} msg/s, ${((n * bytes) / s / 1e6).toFixed(2)} MB/s`;
}

async function hcExecRpc(n: number) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const p = Bun.spawn(["hc", "exec", "--on", machine, "-i", "--", "cat"], { stdin: "pipe", stdout: "pipe" });
    p.stdin.write(line(1024, i));
    p.stdin.end();
    const r = await new Response(p.stdout).text();
    if (!r.includes(`"seq":${i},`)) throw new Error("hc exec echo mismatch");
    out.push(ms(t0));
  }
  console.log(`hc exec -i (one call per message, 1 KB): ${fmt(out)}`);
}

async function sshStdio() {
  let t0 = performance.now();
  const p = sshPipe();
  await rtt(p, 1, 10);
  console.log(`ssh stdio: connect + first echo ${ms(t0).toFixed(0)} ms`);
  console.log(`ssh stdio RTT 1 KB: ${fmt(await rtt(p, 200, 1024))}`);
  console.log(`ssh stdio RTT 64 KB: ${fmt(await rtt(p, 30, 65536))}`);
  console.log(`ssh stdio RTT 1 MB: ${fmt(await rtt(p, 5, 1 << 20))}`);
  console.log(`ssh stdio throughput ${await throughput(p, 2000, 1024)}`);
  console.log(`ssh stdio throughput ${await throughput(p, 100, 65536)}`);
  // 70 s of one echo per second: no 60 s cap like hc exec's.
  if (process.env.SPIKE_LONG) {
    const r: number[] = [];
    for (let i = 0; i < 70; i++) {
      await Bun.sleep(1000);
      r.push(...(await rtt(p, 1, 100)));
    }
    console.log(`ssh stdio, one echo per second for 70 s: ${fmt(r)}`);
  }
  p.proc.kill("SIGKILL");
  t0 = performance.now();
  await Bun.sleep(1500);
  console.log(`disconnect (kill -9 local ssh): remote endpoints left after 1.5 s: ${await remoteOrphans()}`);
  return t0;
}

async function hungLink() {
  const p = sshPipe();
  await rtt(p, 1, 10);
  p.proc.kill("SIGSTOP");
  const t0 = performance.now();
  await Bun.sleep(18000);
  console.log(
    `hung link (SIGSTOP local ssh, 18 s): remote endpoints left: ${await remoteOrphans()} (idle exit after 15 s)`,
  );
  p.proc.kill("SIGKILL");
  return t0;
}

async function remoteDies() {
  const p = sshPipe();
  await rtt(p, 1, 10);
  const t0 = performance.now();
  Bun.spawn([...SSH, target, `pkill -f ${tag}`]);
  const code = await p.proc.exited;
  console.log(`remote endpoint killed: local ssh exits after ${ms(t0).toFixed(0)} ms (code ${code})`);
  const r0 = performance.now();
  const q = sshPipe();
  await rtt(q, 1, 10);
  console.log(`reconnect (new ssh + first echo): ${ms(r0).toFixed(0)} ms`);
  q.proc.stdin.end();
  await q.proc.exited;
}

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });

async function sshTunnel() {
  const server = openPipe([...SSH, target, `exec ${remoteBun} -e '${WS_ECHO}' ${tag}`]);
  const remotePort = Number(await server.next());
  const local = await freePort();
  const t0 = performance.now();
  const fwd = Bun.spawn([
    ...SSH,
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    `${local}:127.0.0.1:${remotePort}`,
    target,
  ]);
  let ws: WebSocket | undefined;
  for (let i = 0; i < 50 && !ws; i++) {
    await Bun.sleep(100);
    ws = await new Promise<WebSocket | undefined>((res) => {
      const w = new WebSocket(`ws://127.0.0.1:${local}`);
      w.onopen = () => res(w);
      w.onerror = () => res(undefined);
    });
  }
  if (!ws) throw new Error("tunnel never came up");
  console.log(`ssh -L: tunnel + ws open ${ms(t0).toFixed(0)} ms`);
  const sock = ws;
  const out: number[] = [];
  for (let i = 0; i < 200; i++) {
    const s = performance.now();
    const got = new Promise((res) => {
      sock.onmessage = res;
    });
    sock.send(line(1024, i));
    await got;
    out.push(ms(s));
  }
  console.log(`ssh -L websocket RTT 1 KB: ${fmt(out)}`);
  sock.close();
  fwd.kill();
  server.proc.kill();
  await Bun.sleep(1500);
  // Finding: a remote server that doesn't read stdin outlives its ssh (no pty, so no SIGHUP).
  console.log(`ssh -L: remote server left after its ssh ended: ${await remoteOrphans()} (killing it)`);
  await Bun.spawn([...SSH, target, `pkill -f '[${tag[0]}]${tag.slice(1)}' || true`]).exited;
}

const which = process.env.SPIKE_ONLY;
const run = (name: string) => !which || which.split(",").includes(name);
if (run("exec")) await hcExecRpc(Number(process.env.SPIKE_EXEC_N ?? 50));
if (run("stdio")) await sshStdio();
if (run("hung")) await hungLink();
if (run("remote")) await remoteDies();
if (run("tunnel")) await sshTunnel();
const left = await remoteOrphans();
console.log(`remote endpoints left at the end: ${left}`);
if (left !== 0) process.exit(1);

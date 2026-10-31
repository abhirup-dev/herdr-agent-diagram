// A board's REST API from the outside (the CLI). `url` is the board's base, e.g. http://127.0.0.1:3077/b/t72.
import type { BoardElement, Snapshot } from "./store.ts";

/** The board did not answer (exit code 3). */
export class UnreachableError extends Error {}

export interface Image {
  readonly format: "png" | "svg";
  readonly data: string;
  readonly renderer?: string;
  readonly width?: number;
  readonly height?: number;
  readonly warnings?: string[];
}

type Answer = { success?: boolean; error?: string; element?: BoardElement; elements?: BoardElement[] } & Record<
  string,
  unknown
>;

export class BoardClient {
  constructor(readonly url: string) {}

  async call<T = Answer>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.url.replace(/\/$/, "")}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new UnreachableError(`Board at ${this.url} is unreachable (${e instanceof Error ? e.message : e})`);
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || data === null) throw new Error(data?.error ?? `HTTP ${res.status} ${res.statusText}`);
    return data;
  }

  health = () => this.call<Record<string, unknown>>("GET", "/health");
  elements = async () => (await this.call("GET", "/api/elements")).elements ?? [];
  search = async (q: URLSearchParams) => (await this.call("GET", `/api/elements/search?${q}`)).elements ?? [];
  get = async (id: string) =>
    (await this.call("GET", `/api/elements/${encodeURIComponent(id)}`)).element as BoardElement;
  batch = async (elements: unknown[], replace = false) =>
    (await this.call("POST", "/api/elements/batch", { elements, replace })).elements ?? [];
  update = async (id: string, fields: Record<string, unknown>) =>
    (await this.call("PUT", `/api/elements/${encodeURIComponent(id)}`, fields)).element as BoardElement;
  remove = (id: string) => this.call("DELETE", `/api/elements/${encodeURIComponent(id)}`);
  clear = () => this.call("DELETE", "/api/elements/clear");
  saveSnapshot = (name: string) => this.call("POST", "/api/snapshots", { name });
  snapshots = async () => (await this.call<{ snapshots?: unknown[] }>("GET", "/api/snapshots")).snapshots ?? [];
  snapshot = async (name: string) =>
    (await this.call<{ snapshot: Snapshot }>("GET", `/api/snapshots/${encodeURIComponent(name)}`)).snapshot;
  image = (options: Record<string, unknown>) => this.call<Image>("POST", "/api/export/image", options);
}

import { expect, test } from "bun:test";
import { WindowSynchronizer } from "./synchronizer.ts";
import { handleUiRequest } from "./ui.ts";

function worker() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  const writes: string[] = [];
  const exited = new Promise<number>((resolve) => { exit = resolve; });
  return {
    writes,
    process: {
      stdin: { write: (value: string) => { writes.push(value); }, end: () => {} },
      stdout: new ReadableStream<Uint8Array>({ start(value) { controller = value; } }),
      stderr: new ReadableStream<Uint8Array>({ start(value) { value.close(); } }),
      exited,
      kill: () => { controller.close(); exit(1); },
    },
    send(value: unknown) { controller.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`)); },
    exit(code = 0) { controller.close(); exit(code); },
  };
}

test("window synchronizer validates Chromium launches and tracks worker events", async () => {
  const fake = worker();
  const profiles = new Map(["a", "b"].map((id) => [id, { id, name: id.toUpperCase(), engine: "chromium" }]));
  const launches = new Map(["a", "b"].map((id, index) => [id, { ws: `ws://browser/${index}`, engine: "chromium" }]));
  const manager = new WindowSynchronizer({
    launcher: { certifiedActive: async () => true },
    store: { getProfile: (id) => profiles.get(id) as any, getLaunch: (id) => launches.get(id) as any },
    spawn: () => fake.process,
  });
  const started = manager.start(["a", "b"]);
  fake.send({ type: "ready" });
  expect(await started).toMatchObject({ state: "running", leader: { id: "a" }, followers: [{ id: "b" }] });
  expect(JSON.parse(fake.writes[0]!)).toMatchObject({ profiles: [{ id: "a" }, { id: "b" }] });
  fake.send({ type: "event", count: 2, failures: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(manager.status()).toMatchObject({ events: 2, failures: 1 });
  const stopping = manager.stop(); fake.exit();
  expect(await stopping).toMatchObject({ state: "stopped", events: 2, failures: 1 });
});

test("window synchronizer rejects Firefox and closed profiles before spawning", async () => {
  const manager = new WindowSynchronizer({
    launcher: { certifiedActive: async () => true },
    store: {
      getProfile: (id) => ({ id, name: id, engine: id === "b" ? "firefox" : "chromium" }) as any,
      getLaunch: (id) => ({ ws: `ws://${id}`, engine: id === "b" ? "firefox" : "chromium" }) as any,
    },
    spawn: () => { throw new Error("must not spawn"); },
  });
  await expect(manager.start(["a", "b"])).rejects.toThrow("只支持 IDFRI Chromium");
  await expect(manager.start(["a"])).rejects.toThrow("2 到 20");
});

test("synchronizer UI API requires the desktop token and trusted JSON", async () => {
  const calls: string[][] = [];
  const manager = {
    status: () => ({ state: "stopped", followers: [], events: 0, failures: 0 }),
    start: async (ids: string[]) => { calls.push(ids); return { state: "running", followers: [], events: 0, failures: 0 }; },
    stop: async () => ({ state: "stopped", followers: [], events: 0, failures: 0 }),
  } as any;
  const options = { synchronizer: { manager, nonce: "a".repeat(64) } };
  const denied = await handleUiRequest(new Request("http://127.0.0.1/ui/api/synchronizer"), {} as any, {} as any, null, options);
  expect(denied?.status).toBe(401);
  const started = await handleUiRequest(new Request("http://127.0.0.1/ui/api/synchronizer/start", {
    method: "POST", headers: { authorization: `Bearer ${"a".repeat(64)}`, "content-type": "application/json" },
    body: JSON.stringify({ profileIds: ["a", "b"] }),
  }), {} as any, {} as any, null, options);
  expect(started?.status).toBe(200);
  expect(calls).toEqual([["a", "b"]]);
});

import { join } from "node:path";
import type { Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import { playwrightWorkerEnvironment, resolvePlaywrightRuntime } from "./playwright-runtime.ts";

export interface SynchronizerStatus {
  state: "stopped" | "starting" | "running" | "stopping" | "failed";
  leader?: { id: string; name: string };
  followers: Array<{ id: string; name: string }>;
  events: number;
  failures: number;
  error?: string;
}

interface WorkerProcess {
  stdin: { write(value: string): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): unknown;
}

export interface WindowSynchronizerOptions {
  launcher: Pick<Launcher, "certifiedActive">;
  store: Pick<ProfileStore, "getProfile" | "getLaunch">;
  runtimeRoot?: string;
  spawn?: (argv: string[]) => WorkerProcess;
}

export class WindowSynchronizer {
  private child?: WorkerProcess;
  private current: SynchronizerStatus = { state: "stopped", followers: [], events: 0, failures: 0 };

  constructor(private readonly options: WindowSynchronizerOptions) {}

  status(): SynchronizerStatus { return structuredClone(this.current); }

  async start(profileIds: string[]): Promise<SynchronizerStatus> {
    const ids = [...new Set(Array.isArray(profileIds) ? profileIds.map(String) : [])];
    if (ids.length < 2 || ids.length > 20) throw new Error("请选择 2 到 20 个已打开的 Chromium 资料");
    if (this.child) await this.stop();
    const profiles: Array<{ id: string; name: string; endpoint: string }> = [];
    for (const id of ids) {
      const profile = this.options.store.getProfile(id);
      const launch = this.options.store.getLaunch(id);
      if (!profile) throw new Error(`未找到资料：${id}`);
      if (profile.engine === "firefox" || launch?.engine === "firefox") throw new Error("多窗口同步器目前只支持 IDFRI Chromium");
      if (!launch?.ws || !await this.options.launcher.certifiedActive(id)) throw new Error(`请先打开资料：${profile.name || id}`);
      profiles.push({ id, name: profile.name || id, endpoint: launch.ws });
    }

    const runtime = resolvePlaywrightRuntime({ runtimeRoot: this.options.runtimeRoot });
    const argv = [runtime.nodeExecutable, join(runtime.root, "synchronizer-worker.mjs")];
    const spawn = this.options.spawn ?? ((command: string[]) => Bun.spawn(command, {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: playwrightWorkerEnvironment(), windowsHide: true,
    }) as unknown as WorkerProcess);
    const child = spawn(argv);
    this.child = child;
    this.current = {
      state: "starting",
      leader: { id: profiles[0]!.id, name: profiles[0]!.name },
      followers: profiles.slice(1).map(({ id, name }) => ({ id, name })),
      events: 0,
      failures: 0,
    };

    let ready!: () => void;
    let rejectReady!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
    void this.readMessages(child, (message) => {
      if (message.type === "ready") { this.current.state = "running"; ready(); }
      else if (message.type === "event") {
        this.current.events += Number(message.count ?? 1);
        this.current.failures += Number(message.failures ?? 0);
      } else if (message.type === "error") {
        const error = typeof message.message === "string" ? message.message : "同步器运行失败";
        this.current = { ...this.current, state: "failed", error };
        rejectReady(new Error(error));
      }
    });
    void child.exited.then((code) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.current.state === "stopping") this.current = { state: "stopped", followers: [], events: this.current.events, failures: this.current.failures };
      else if (this.current.state !== "failed") this.current = { ...this.current, state: "failed", error: `同步器进程已退出（${code}）` };
      rejectReady(new Error(this.current.error ?? "同步器进程已退出"));
    });
    child.stdin.write(`${JSON.stringify({ profiles })}\n`);
    try {
      await Promise.race([
        started,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("同步器启动超时")), 15_000)),
      ]);
      return this.status();
    } catch (error) {
      try { child.kill(); } catch {}
      if (this.child === child) this.child = undefined;
      this.current = { ...this.current, state: "failed", error: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }

  async stop(): Promise<SynchronizerStatus> {
    const child = this.child;
    if (!child) {
      this.current = { state: "stopped", followers: [], events: this.current.events, failures: this.current.failures };
      return this.status();
    }
    this.current.state = "stopping";
    try { child.stdin.write('{"type":"stop"}\n'); child.stdin.end(); } catch {}
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      child.exited.catch(() => -1),
      new Promise<void>((resolve) => { timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 5_000); }),
    ]);
    if (timer) clearTimeout(timer);
    if (this.child === child) this.child = undefined;
    this.current = { state: "stopped", followers: [], events: this.current.events, failures: this.current.failures };
    return this.status();
  }

  private async readMessages(child: WorkerProcess, receive: (message: any) => void): Promise<void> {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line) continue;
          try { receive(JSON.parse(line)); } catch {}
        }
      }
    } finally { reader.releaseLock(); }
  }
}

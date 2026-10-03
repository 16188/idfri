import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { AgentControlSession, AGENT_CONTROL_PROTOCOL, type AgentControlDeps } from "./agent-control.ts";
import { callFirefoxOwner, type FirefoxOwner } from "./firefox-runtime.ts";
import type { CloudConnectionRuntime } from "./cloud-connection.ts";
import { CloudClient } from "./cloud-client.ts";
import type { ScriptInput, ScriptLanguage, ScriptRecord, ScriptSummary, PublishedScript, PublishScriptInput, PublishedScriptsQuery, ListPublishedScriptsResponse } from "./contracts/cloud-v1.ts";
import { resolvePlaywrightRuntime, type PlaywrightRuntimeLayout } from "./playwright-runtime.ts";

export class ScriptError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export type VisualFlowStep =
  | { type: "goto"; url: string }
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; text: string }
  | { type: "waitFor"; selector: string }
  | { type: "wait"; milliseconds: number }
  | { type: "scroll"; x: number; y: number }
  | { type: "screenshot" };

/** Compile the visual editor's small, validated step set into the existing runner format. */
export function compileVisualFlow(steps: VisualFlowStep[]): string {
  if (!Array.isArray(steps) || !steps.length || steps.length > 100) throw new ScriptError("流程必须包含 1 到 100 个步骤");
  const clean = steps.map((step, index) => {
    if (!step || typeof step !== "object") throw new ScriptError(`第 ${index + 1} 步无效`);
    const selector = "selector" in step ? String(step.selector ?? "").trim() : "";
    if (["click", "fill", "waitFor"].includes(step.type) && (!selector || selector.length > 1000)) {
      throw new ScriptError(`第 ${index + 1} 步需要有效的元素选择器`);
    }
    if (step.type === "goto") {
      let url: URL;
      try { url = new URL(String(step.url)); } catch { throw new ScriptError(`第 ${index + 1} 步的网址无效`); }
      if (!["http:", "https:"].includes(url.protocol) || url.href.length > 2048) throw new ScriptError(`第 ${index + 1} 步只支持 HTTP/HTTPS 网址`);
      return { type: step.type, url: url.href };
    }
    if (step.type === "click" || step.type === "waitFor") return { type: step.type, selector };
    if (step.type === "fill") {
      const text = String(step.text ?? "");
      if (text.length > 10_000) throw new ScriptError(`第 ${index + 1} 步的文本过长`);
      return { type: step.type, selector, text };
    }
    if (step.type === "wait") {
      const milliseconds = Number(step.milliseconds);
      if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 60_000) throw new ScriptError(`第 ${index + 1} 步的等待时间必须在 0 到 60000 毫秒之间`);
      return { type: step.type, milliseconds };
    }
    if (step.type === "scroll") {
      const x = Number(step.x); const y = Number(step.y);
      if (![x, y].every((value) => Number.isFinite(value) && Math.abs(value) <= 1_000_000)) throw new ScriptError(`第 ${index + 1} 步的滚动距离无效`);
      return { type: step.type, x, y };
    }
    if (step.type === "screenshot") return { type: step.type };
    throw new ScriptError(`第 ${index + 1} 步的类型不受支持`);
  });
  return `const steps = ${JSON.stringify(clean)};
export default async function ({ page, log }) {
  for (const [index, step] of steps.entries()) {
    if (step.type === "goto") await page.goto(step.url, { waitUntil: "domcontentloaded" });
    else if (step.type === "click") await page.locator(step.selector).first().click();
    else if (step.type === "fill") await page.locator(step.selector).first().fill(step.text);
    else if (step.type === "waitFor") await page.locator(step.selector).first().waitFor({ state: "visible" });
    else if (step.type === "wait") await page.waitForTimeout(step.milliseconds);
    else if (step.type === "scroll") await page.evaluate(({ x, y }) => window.scrollBy(x, y), step);
    else if (step.type === "screenshot") {
      const path = \`idfri-screenshot-\${index + 1}.png\`;
      await page.screenshot({ path, fullPage: true });
      log(\`截图已保存：\${path}\`);
    }
  }
}
`;
}

export function scriptInput(value: any): ScriptInput {
  if (!value || typeof value.name !== "string" || !value.name.trim()
    || typeof value.description !== "string" || typeof value.source !== "string" || !value.source.trim()
    || !["javascript", "python"].includes(value.language)) {
    throw new ScriptError("必须填写名称、说明、源码并选择受支持的语言");
  }
  return { name: value.name.trim(), description: value.description, language: value.language, source: value.source };
}

function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ScriptError("必须提供有效的预期修订版本");
}

export class ScriptLibrary {
  readonly directory: string;
  private readonly catalog?: CloudClient;
  constructor(root: string, readonly cloudMode: boolean, private readonly cloud?: CloudConnectionRuntime, catalogUrl?: string) {
    this.directory = join(root, "custom-scripts");
    this.catalog = cloud?.client ?? (catalogUrl ? new CloudClient({ baseUrl: catalogUrl, accessToken: () => undefined }) : undefined);
  }

  scope(): string {
    if (!this.cloudMode) return "local";
    const account = this.cloud?.accountId();
    if (!account) throw new ScriptError("请先登录云端账号", 401);
    return `account-${createHash("sha256").update(account).digest("hex")}`;
  }

  assertScope(scope: string): void {
    if (this.scope() !== scope) throw new ScriptError("当前登录账号已变更", 409);
  }

  private cached(scope: string): ScriptRecord[] {
    const path = join(this.directory, `${scope}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  }

  private write(scope: string, scripts: ScriptRecord[]): void {
    this.assertScope(scope);
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, `${scope}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(scripts), { mode: 0o600 });
    try { renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
  }

  private cache(scope: string, script: ScriptRecord): ScriptRecord {
    this.write(scope, [...this.cached(scope).filter((item) => item.id !== script.id), script]);
    return script;
  }

  async list(): Promise<ScriptSummary[]> {
    return (await this.info()).scripts;
  }

  async info(): Promise<{ scripts: ScriptSummary[]; canPublish: boolean; publicationDefaults?: { authorName: string } }> {
    const scope = this.scope();
    const response = this.cloudMode ? await this.cloud!.client.listScripts() : { scripts: this.cached(scope), publicationDefaults: undefined };
    this.assertScope(scope);
    return {
      scripts: response.scripts.map(({ source: _source, ...summary }: ScriptRecord | (ScriptSummary & { source?: string })) => summary),
      canPublish: this.cloudMode && !!this.cloud?.accountId(),
      ...(response.publicationDefaults ? { publicationDefaults: response.publicationDefaults } : {}),
    };
  }

  async browse(query: PublishedScriptsQuery = {}): Promise<ListPublishedScriptsResponse> {
    if (!this.catalog) throw new ScriptError("公共脚本库地址不可用", 503);
    return this.catalog.listPublishedScripts(query);
  }

  async viewPublished(id: string): Promise<PublishedScript> {
    if (!this.catalog) throw new ScriptError("公共脚本库地址不可用", 503);
    return (await this.catalog.getPublishedScript(id)).script;
  }

  async importPublished(id: string): Promise<ScriptRecord> {
    const scope = this.scope();
    const script = await this.viewPublished(id);
    this.assertScope(scope);
    return this.save(scriptInput(script));
  }

  async publish(id: string, input: PublishScriptInput): Promise<PublishedScript> {
    if (!this.cloudMode) throw new ScriptError("请登录云端账号后发布脚本", 403);
    const scope = this.scope();
    const response = await this.cloud!.client.publishScript(id, input);
    this.assertScope(scope);
    return response.script;
  }

  async unpublish(id: string): Promise<void> {
    if (!this.cloudMode) throw new ScriptError("请登录云端账号后发布脚本", 403);
    const scope = this.scope();
    await this.cloud!.client.unpublishScript(id);
    this.assertScope(scope);
  }

  async get(id: string): Promise<ScriptRecord> {
    const scope = this.scope();
    if (this.cloudMode) return this.cache(scope, (await this.cloud!.client.getScript(id)).script);
    const script = this.cached(scope).find((item) => item.id === id);
    if (!script) throw new ScriptError("未找到脚本", 404);
    return script;
  }

  async save(value: ScriptInput, id?: string, expectedRevision?: number): Promise<ScriptRecord> {
    const input = scriptInput(value);
    const scope = this.scope();
    if (id) revision(expectedRevision);
    if (this.cloudMode) {
      const response = id
        ? await this.cloud!.client.updateScript(id, { ...input, expectedRevision: expectedRevision! })
        : await this.cloud!.client.createScript(input);
      return this.cache(scope, response.script);
    }
    const previous = id ? this.cached(scope).find((item) => item.id === id) : undefined;
    if (id && !previous) throw new ScriptError("未找到脚本", 404);
    if (previous && previous.revision !== expectedRevision) throw new ScriptError("脚本已变更，请重新加载后保存", 409);
    const now = new Date().toISOString();
    return this.cache(scope, { ...input, id: id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now });
  }

  async delete(id: string, expectedRevision: number): Promise<void> {
    revision(expectedRevision);
    const scope = this.scope();
    if (this.cloudMode) await this.cloud!.client.deleteScript(id, expectedRevision);
    else {
      const script = this.cached(scope).find((item) => item.id === id);
      if (!script) throw new ScriptError("未找到脚本", 404);
      if (script.revision !== expectedRevision) throw new ScriptError("脚本已变更，请重新加载后删除", 409);
    }
    this.write(scope, this.cached(scope).filter((script) => script.id !== id));
  }
}

export interface ScriptRun {
  id: string;
  scriptName: string;
  status: "running" | "stopping" | "finished";
  profiles: Array<{ id: string; name: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; error?: string; warning?: string }>;
}

interface RunRequest { scriptId: string; profileIds: string[]; inputs: Record<string, unknown>; useCredentials: boolean }
interface RunnerInput {
  endpoint: string;
  engine?: "firefox";
  profile: { id: string; name: string; group: string; platform: string };
  inputs: Record<string, unknown>;
  credentials: Record<string, string> | null;
}
export type ScriptExecution = (options: { scriptPath: string; language: ScriptLanguage; input: RunnerInput; logFd: number; signal: AbortSignal }) => Promise<void>;

interface ScriptRunner {
  executable: string;
  runner: string;
}

export interface ScriptRuntimeVerificationOptions {
  runtime?: PlaywrightRuntimeLayout;
  env?: NodeJS.ProcessEnv;
}

function scriptRunnerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["APPDATA", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

function supportsSourceScripts(): boolean {
  return (process.platform === "darwin" && process.arch === "arm64") || (process.platform === "linux" && process.arch === "x64");
}

export function resolveScriptRunner(language: ScriptLanguage, runtime = resolvePlaywrightRuntime()): ScriptRunner {
  if (runtime.kind === "source" && !supportsSourceScripts()) {
    throw new ScriptError("脚本功能需要已打包的桌面运行时", 503);
  }
  return {
    executable: runtime.kind === "source"
      ? language === "python" ? "python3" : runtime.nodeExecutable
      : language === "python"
        ? process.platform === "win32" ? join(runtime.root, "python", "python.exe") : "python3"
        : runtime.nodeExecutable,
    runner: join(runtime.root, "agent", language === "python" ? "script-runner.py" : "script-runner.mjs"),
  };
}

async function sourceCommandAvailable(executable: string, args: string[], runtime: PlaywrightRuntimeLayout, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const child = Bun.spawn([executable, ...args], { cwd: runtime.root, env, stdout: "ignore", stderr: "ignore" });
    return await child.exited === 0;
  } catch {
    return false;
  }
}

export async function verifyScriptRuntime(language: ScriptLanguage, options: ScriptRuntimeVerificationOptions = {}): Promise<ScriptRunner> {
  const runtime = options.runtime ?? resolvePlaywrightRuntime();
  const resolved = resolveScriptRunner(language, runtime);
  const env = scriptRunnerEnvironment(options.env);
  const executableAvailable = isAbsolute(resolved.executable)
    ? existsSync(resolved.executable)
    : !!Bun.which(resolved.executable, { PATH: env.PATH });
  if (!executableAvailable && runtime.kind === "packaged") {
    throw new ScriptError("脚本运行时缺失，请更新 IDFRI", 503);
  }
  if (!existsSync(resolved.runner)) {
    throw new ScriptError(runtime.kind === "source"
      ? "源码脚本运行器缺失，请恢复 IDFRI 源码检出"
      : "脚本运行时缺失，请更新 IDFRI", 503);
  }
  if (runtime.kind !== "source") {
    if (language === "python" && process.platform !== "win32") {
      env.PYTHONPATH = join(runtime.root, "python", "site-packages");
      if (!await sourceCommandAvailable(resolved.executable, ["-c", "from playwright._repo_version import version\nraise SystemExit(not version.startswith('1.58.'))"], runtime, env)) {
        throw new ScriptError("Linux Python 脚本运行时缺失，请更新 IDFRI", 503);
      }
    }
    return resolved;
  }

  const available = language === "javascript"
    ? await sourceCommandAvailable(resolved.executable, ["-e", "const p = require('playwright-core/package.json'); if (+process.versions.node.split('.')[0] < 18 || p.version !== '1.58.2') process.exit(1)"], runtime, env)
    : await sourceCommandAvailable(resolved.executable, ["-c", "from playwright.async_api import async_playwright\nfrom playwright._repo_version import version\nraise SystemExit(not version.startswith('1.58.'))"], runtime, env);
  if (!available) {
    throw new ScriptError(language === "javascript"
      ? "Source JavaScript scripts require Node.js 18 or newer and compatible Playwright 1.58.2 installed"
      : "Source Python scripts require Python 3 with compatible Playwright 1.58.x installed", 503);
  }
  return resolved;
}

export const executeScript: ScriptExecution = async ({ scriptPath, language, input, logFd, signal }) => {
  signal.throwIfAborted();
  const { executable, runner } = await verifyScriptRuntime(language);
  signal.throwIfAborted();
  const env = scriptRunnerEnvironment();
  if (language === "python" && process.platform !== "win32") {
    env.PYTHONPATH = join(dirname(dirname(runner)), "python", "site-packages");
  }
  const child = spawn(executable, [...(language === "python" ? ["-u", "-X", "utf8"] : []), runner, scriptPath], {
    cwd: dirname(scriptPath), windowsHide: true, detached: process.platform !== "win32", env, stdio: ["pipe", logFd, logFd],
  });
  let termination: Promise<void> | undefined;
  const stop = () => {
    termination ??= (async () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === "win32") {
        const kill = Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
        if (await kill.exited !== 0 && child.exitCode === null && child.signalCode === null) throw new Error("无法确认脚本进程已终止");
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error: any) { if (error.code !== "ESRCH") throw error; }
      }
    })().catch((error) => {
      // Keep waiting for exit; browser cleanup must not race a live script.
      writeFileSync(logFd, `\nCould not stop script: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  signal.addEventListener("abort", stop, { once: true });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  // EOF is reserved for parent death; the runner reads its input from the first line.
  child.stdin!.on("error", () => {});
  child.stdin!.write(`${JSON.stringify(input)}\n`);
  if (signal.aborted) stop();
  try {
    const code = await exited;
    await termination;
    signal.throwIfAborted();
    if (code !== 0) throw new Error(`Script exited with code ${code ?? "unknown"}; see its log`);
  } finally {
    signal.removeEventListener("abort", stop);
    child.stdin!.destroy();
  }
};

interface ActiveRun {
  view: ScriptRun;
  scope: string;
  directory: string;
  logPath: string;
  abort: AbortController;
  done: Promise<void>;
}

export class ScriptSupervisor {
  private active?: ActiveRun;
  private closing = false;
  private pauses = 0;
  constructor(private readonly options: AgentControlDeps & { root: string; library: ScriptLibrary; execute?: ScriptExecution }) {}

  pause(): () => void {
    this.pauses++;
    return () => { this.pauses--; };
  }

  status(): ScriptRun | null {
    if (!this.active) return null;
    try {
      return this.active.scope === this.options.library.scope() ? structuredClone(this.active.view) : null;
    } catch (error) {
      if (error instanceof ScriptError && error.status === 401) return null;
      throw error;
    }
  }

  start(request: RunRequest): ScriptRun {
    if (this.closing || this.pauses) throw new ScriptError("IDFRI 正在切换账号或关闭，脚本执行已暂停", 409);
    if (this.active && this.active.view.status !== "finished") throw new ScriptError("已有脚本正在运行", 409);
    if (!request || typeof request.scriptId !== "string" || !request.scriptId
      || !Array.isArray(request.profileIds) || !request.profileIds.length || !request.profileIds.every((id) => typeof id === "string" && id)
      || !request.inputs || typeof request.inputs !== "object" || Array.isArray(request.inputs) || typeof request.useCredentials !== "boolean") {
      throw new ScriptError("请选择脚本和资料，并提供 JSON 对象作为输入");
    }
    const scope = this.options.library.scope();
    if (this.active) rmSync(this.active.directory, { recursive: true, force: true });
    mkdirSync(this.options.library.directory, { recursive: true });
    const directory = mkdtempSync(join(this.options.library.directory, "run-"));
    const run: ActiveRun = {
      view: { id: randomUUID(), scriptName: "脚本", status: "running", profiles: [...new Set(request.profileIds)].map((id) => ({ id, name: id, status: "queued" })) },
      scope, directory, logPath: join(directory, "output.log"), abort: new AbortController(), done: Promise.resolve(),
    };
    writeFileSync(run.logPath, "", { mode: 0o600 });
    this.active = run;
    run.done = this.run(run, request);
    return structuredClone(run.view);
  }

  async stop(): Promise<ScriptRun | null> {
    const run = this.active;
    if (run && run.view.status !== "finished") {
      run.view.status = "stopping";
      run.abort.abort();
      await run.done;
    }
    return this.status();
  }

  settled(): Promise<void> { return this.active?.done ?? Promise.resolve(); }

  async shutdown(): Promise<void> {
    this.closing = true;
    const run = this.active;
    if (run) { run.abort.abort(); await run.done; rmSync(run.directory, { recursive: true, force: true }); }
  }

  log(id: string, offset: number): { text: string; nextOffset: number } {
    const run = this.active;
    if (!run || run.scope !== this.options.library.scope() || run.view.id !== id) throw new ScriptError("未找到运行记录", 404);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ScriptError("日志偏移量无效");
    const fd = openSync(run.logPath, "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const length = readSync(fd, buffer, 0, buffer.length, offset);
      // Keep an incomplete UTF-8 character for the next poll.
      let end = length;
      let start = length - 1;
      while (start >= 0 && (buffer[start]! & 0xc0) === 0x80) start--;
      const lead = buffer[start] ?? 0;
      const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (start >= 0 && length - start < width && (length === buffer.length || run.view.status !== "finished")) end = start;
      return { text: buffer.subarray(0, end).toString("utf8"), nextOffset: offset + end };
    } finally { closeSync(fd); }
  }

  private async run(run: ActiveRun, request: RunRequest): Promise<void> {
    const signal = run.abort.signal;
    const fd = openSync(run.logPath, "a");
    try {
      const script = await this.options.library.get(request.scriptId);
      this.options.library.assertScope(run.scope);
      if (!this.options.execute) await verifyScriptRuntime(script.language);
      run.view.scriptName = script.name;
      const path = join(run.directory, script.language === "python" ? "script.py" : "script.mjs");
      writeFileSync(path, script.source, { mode: 0o600 });
      for (const item of run.view.profiles) {
        if (signal.aborted) { item.status = "cancelled"; continue; }
        const session = new AgentControlSession(this.options);
        let owned = false;
        let endpoint: string | undefined;
        const call = async (method: string) => {
          const response = await session.enqueue(JSON.stringify({
            protocol: AGENT_CONTROL_PROTOCOL, id: 1, method,
            params: { profileId: item.id, ...(method === "browser.close" ? { expectedEndpoint: endpoint } : {}) },
          }));
          if (!response.ok) throw new Error(response.error?.message ?? "浏览器操作失败");
          return response.result as { ws: string; ownedByConnection: boolean; sync?: string };
        };
        try {
          this.options.library.assertScope(run.scope);
          let cloudProfile;
          if (this.options.library.cloudMode) {
            const response = await this.options.cloudConnection!.client.getProfile(item.id);
            if (response.profile.permission !== "edit") throw new ScriptError("需要资料编辑权限", 403);
            cloudProfile = response.payload.profile;
          }
          signal.throwIfAborted();
          this.options.library.assertScope(run.scope);
          item.status = "running";
          const opened = await call("browser.open") as { ws?: string; engine?: string; ownedByConnection: boolean };
          owned = opened.ownedByConnection;
          endpoint = opened.ws;
          signal.throwIfAborted();
          this.options.library.assertScope(run.scope);
          const profile = this.options.store.getProfile(item.id) ?? cloudProfile;
          if (!profile) throw new ScriptError("未找到资料", 404);
          item.name = profile.name;
          writeFileSync(fd, `\n--- ${profile.name || item.id} ---\n`);
          const input = {
            profile: { id: item.id, name: profile.name, group: profile.group, platform: profile.platform ?? "" },
            inputs: request.inputs,
            credentials: request.useCredentials ? Object.fromEntries(["username", "password", "email", "emailPassword", "twofa"].map((key) => [key, (profile as unknown as Record<string, string>)[key] ?? ""])) : null,
          };
          if (opened.engine === "firefox") {
            const launch = this.options.store.getLaunch(item.id) as { firefoxOwner?: FirefoxOwner } | null;
            if (!launch?.firefoxOwner) throw new ScriptError("Firefox 浏览器所有者不可用", 503);
            const { endpoint } = await callFirefoxOwner<{ endpoint?: unknown }>(launch.firefoxOwner, "playwright-endpoint", {}, { signal });
            if (typeof endpoint !== "string" || !endpoint) throw new ScriptError("Firefox 浏览器端点不可用", 503);
            await (this.options.execute ?? executeScript)({
              scriptPath: path, language: script.language, logFd: fd, signal,
              input: { endpoint, engine: "firefox", ...input },
            });
          } else {
            await (this.options.execute ?? executeScript)({
              scriptPath: path, language: script.language, logFd: fd, signal,
              input: { endpoint: opened.ws!, ...input },
            });
          }
          item.status = signal.aborted ? "cancelled" : "succeeded";
        } catch (error) {
          item.status = signal.aborted ? "cancelled" : "failed";
          if (!signal.aborted) item.error = error instanceof Error ? error.message : "脚本执行失败";
        } finally {
          if (owned) {
            try {
              const closed = await call("browser.close");
              if (closed.sync && closed.sync !== "complete") item.warning = `资料会话保存：${closed.sync}`;
            } catch (error) {
              item.warning = error instanceof Error ? error.message : "无法确认浏览器已清理";
              // Durable browser ownership remains with the launcher; do not retry against a replacement browser.
              await call("browser.detach").catch(() => {});
            }
          }
          await session.disconnect();
        }
      }
    } catch (error) {
      for (const item of run.view.profiles.filter((item) => item.status === "queued")) {
        item.status = signal.aborted ? "cancelled" : "failed";
        if (!signal.aborted) item.error = error instanceof Error ? error.message : "脚本无法启动";
      }
    } finally {
      closeSync(fd);
      run.view.status = "finished";
    }
  }
}

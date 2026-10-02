import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { sha256File } from "../browser-install.ts";
import {
  FIREFOX_RUNTIME_VERSION,
  firefoxBuildForHost,
  installFirefox,
} from "../firefox-install.ts";
import { installSourceNode } from "../source-runtime.ts";
import { ALIASMODE_VERSION } from "../version.ts";
import { copyRuntimePackage } from "./prepare-windows-bundle.ts";

export const LINUX_CHROMIUM_VERSION = "153.0.8010.52-1";
export const LINUX_CHROMIUM_RUNTIME_VERSION = `ungoogled-chromium@${LINUX_CHROMIUM_VERSION}`;
export const LINUX_CHROMIUM_ARCHIVE_NAME = `ungoogled-chromium-${LINUX_CHROMIUM_VERSION}-x86_64_linux.tar.xz`;
export const LINUX_CHROMIUM_ARCHIVE_SHA256 = "49d01c59934c28d59caa30b3d283781bc32bfdc8b7f48bae831358526052a160";
export const LINUX_CHROMIUM_ARCHIVE_URL = `https://github.com/ungoogled-software/ungoogled-chromium-portablelinux/releases/download/${LINUX_CHROMIUM_VERSION}/${LINUX_CHROMIUM_ARCHIVE_NAME}`;

const TARGET_TRIPLE = "x86_64-unknown-linux-gnu";
const BUN_TARGET = "bun-linux-x64-baseline";

interface RuntimePin {
  path: string;
  sha256: string;
}

export interface PreparedLinuxBrowserMetadata {
  executable: "chrome";
  sha256: string;
  runtimeVersion: typeof LINUX_CHROMIUM_RUNTIME_VERSION;
  firefox: {
    executable: "aliasmode";
    sha256: string;
    version: typeof FIREFOX_RUNTIME_VERSION;
    archiveSha256: string;
  };
}

export interface PrepareLinuxBundleOptions {
  cwd?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  compileSidecar?: (output: string) => Promise<void>;
  compileAgent?: (output: string) => Promise<void>;
  installChromium?: (staging: string) => Promise<RuntimePin>;
  installFirefoxRuntime?: (staging: string) => Promise<RuntimePin>;
  installNode?: (staging: string) => Promise<string>;
}

function freshDirectory(path: string): void {
  if (statSync(path, { throwIfNoEntry: false })) {
    throw new Error(`Linux 打包目录已存在，请使用干净的检出目录：${relative(process.cwd(), path)}`);
  }
  mkdirSync(path, { recursive: true });
}

async function compile(cwd: string, entry: string, output: string, defineCompiled: boolean): Promise<void> {
  const args = [process.execPath, "build", "--compile", `--target=${BUN_TARGET}`];
  if (defineCompiled) args.push("--define=ALIASMODE_COMPILED=true", "--external=playwright-core", "--external=chromium-bidi", "--external=electron");
  args.push(entry, "--outfile", output);
  const child = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Linux 可执行文件编译失败：${basename(output)}`);
  chmodSync(output, 0o755);
}

function findExecutable(root: string, name: string): string {
  const matches: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === name) matches.push(path);
    }
  };
  visit(root);
  if (matches.length !== 1) throw new Error(`Linux 运行时必须且只能包含一个 ${name}`);
  accessSync(matches[0]!, constants.X_OK);
  return matches[0]!;
}

async function installChromium(staging: string): Promise<RuntimePin> {
  const response = await fetch(LINUX_CHROMIUM_ARCHIVE_URL, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Linux Chromium 下载失败（HTTP ${response.status}）`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== LINUX_CHROMIUM_ARCHIVE_SHA256) {
    throw new Error("Linux Chromium 归档 SHA-256 与固定版本不一致");
  }
  const archive = join(staging, LINUX_CHROMIUM_ARCHIVE_NAME);
  const extracted = join(staging, "chromium");
  writeFileSync(archive, bytes);
  mkdirSync(extracted);
  const child = Bun.spawn(["tar", "-xJf", archive, "-C", extracted], { stdout: "ignore", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("Linux Chromium 归档解压失败");
  const path = findExecutable(extracted, "chrome");
  return { path, sha256: await sha256File(path) };
}

async function copyBrowserRuntime(pin: RuntimePin, destination: string, executableName: string): Promise<string> {
  const sourceRoot = dirname(pin.path);
  cpSync(sourceRoot, destination, { recursive: true, errorOnExist: false });
  const copied = join(destination, executableName);
  accessSync(copied, constants.X_OK);
  const sha256 = await sha256File(copied);
  if (sha256 !== pin.sha256) throw new Error(`${executableName} 复制后的 SHA-256 不一致`);
  return sha256;
}

export async function prepareLinuxBundle(
  options: PrepareLinuxBundleOptions = {},
): Promise<PreparedLinuxBrowserMetadata> {
  if ((options.platform ?? process.platform) !== "linux" || (options.arch ?? process.arch) !== "x64") {
    throw new Error("Linux 桌面包必须在 Linux x64 上准备");
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  const tauri = join(cwd, "src-tauri");
  const generated = join(tauri, "generated");
  const binaries = join(tauri, "binaries");
  const resources = join(tauri, "resources");
  const staging = join(tauri, "target", "desktop-linux-staging");
  const chromiumRoot = join(resources, "chromium");
  const firefoxRoot = join(resources, "firefox");
  const playwrightRoot = join(resources, "playwright");
  const sidecar = join(binaries, `idfri-sidecar-${TARGET_TRIPLE}`);
  const agent = join(binaries, `idfri-mcp-${TARGET_TRIPLE}`);

  for (const directory of [staging, chromiumRoot, firefoxRoot, playwrightRoot]) freshDirectory(directory);
  for (const directory of [generated, binaries]) mkdirSync(directory, { recursive: true });

  await (options.compileSidecar ?? ((output) => compile(cwd, "cli.ts", output, true)))(sidecar);
  await (options.compileAgent ?? ((output) => compile(cwd, "agent/aliasmode-mcp.ts", output, false)))(agent);
  for (const executable of [sidecar, agent]) accessSync(executable, constants.X_OK);

  const chromium = await (options.installChromium ?? installChromium)(staging);
  const chromiumSha256 = await copyBrowserRuntime(chromium, chromiumRoot, "chrome");
  cpSync(join(cwd, "NOTICE"), join(chromiumRoot, "IDFRI-NOTICE.txt"));

  const firefoxBuild = firefoxBuildForHost("linux", "x64");
  const firefox = await (options.installFirefoxRuntime ?? (async (root) => installFirefox({
    cwd: root,
    platform: "linux",
    arch: "x64",
    writeEnv: false,
  })))(staging);
  const firefoxSha256 = await copyBrowserRuntime(firefox, firefoxRoot, "aliasmode");

  const node = await (options.installNode ?? ((root) => installSourceNode(root, { platform: "linux", arch: "x64" })))(staging);
  mkdirSync(join(playwrightRoot, "node"));
  cpSync(node, join(playwrightRoot, "node", "node"));
  chmodSync(join(playwrightRoot, "node", "node"), 0o755);
  for (const [source, destination] of [
    ["playwright-worker.mjs", "worker.mjs"],
    ["playwright-worker.mjs", "playwright-worker.mjs"],
    ["firefox-worker.mjs", "firefox-worker.mjs"],
  ] as const) cpSync(join(cwd, source), join(playwrightRoot, destination));

  const agentRoot = join(playwrightRoot, "agent");
  mkdirSync(agentRoot);
  for (const file of [
    "mcp-host.mjs",
    "playwright-proxy.mjs",
    "playwright-runner.mjs",
    "script-runner.mjs",
    "script-runner.py",
    "runtime-client.mjs",
  ]) cpSync(join(cwd, "agent", file), join(agentRoot, file));
  const copied = new Set<string>();
  for (const dependency of ["playwright-core", "ws", "@modelcontextprotocol/sdk", "@playwright/mcp", "playwright"]) {
    copyRuntimePackage(cwd, playwrightRoot, dependency, copied);
  }

  const metadata: PreparedLinuxBrowserMetadata = {
    executable: "chrome",
    sha256: chromiumSha256,
    runtimeVersion: LINUX_CHROMIUM_RUNTIME_VERSION,
    firefox: {
      executable: "aliasmode",
      sha256: firefoxSha256,
      version: FIREFOX_RUNTIME_VERSION,
      archiveSha256: firefoxBuild.archiveSha256,
    },
  };
  writeFileSync(join(generated, "browser.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(generated, "VERSION.txt"), `${ALIASMODE_VERSION}\n`, "utf8");
  return metadata;
}

if (import.meta.main) {
  try {
    const metadata = await prepareLinuxBundle();
    console.log(`IDFRI Linux 包已准备完成：Chromium SHA-256 ${metadata.sha256}，Firefox SHA-256 ${metadata.firefox.sha256}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

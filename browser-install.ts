import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { extractZipTo } from "./unzip.ts";

export const IDFRI_BROWSER_RELEASE = "browser-v153.0.8010.52-idfri.2";
export const IDFRI_BROWSER_ARCHIVE_NAME = "idfri-browser_153.0.8010.52-1.idfri2_windows_x64.zip";
export const IDFRI_BROWSER_ARCHIVE_SHA256 = "66df4bf70ba1f54145961a7e567acc0a019ac3c9df850f6d42e7fbbe7a825626";
export const IDFRI_BROWSER_EXECUTABLE_SHA256 = "74a095427ba38407405eb63ea330070278236838cf8f91532d8d66a42243096a";
export const IDFRI_BROWSER_ARCHIVE_URL = `https://github.com/16188/idfri-browser/releases/download/${IDFRI_BROWSER_RELEASE}/${IDFRI_BROWSER_ARCHIVE_NAME}`;
export const OPEN_CHROMIUM_RUNTIME_VERSION = "idfri-browser@153.0.8010.52-idfri.2";
export const OPEN_CHROMIUM_REVISION = "153.0.8010.52-1.idfri2";
export const OPEN_CHROMIUM_VERSION = "153.0.8010.52";

export interface BrowserInstallOptions {
  cwd?: string;
  cacheDir?: string;
  writeEnv?: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
  downloadArchive?: (url: string) => Promise<Uint8Array>;
  archiveHash?: (bytes: Uint8Array) => string;
  extractArchive?: (bytes: Uint8Array, destination: string) => Promise<number>;
  hashFile?: (path: string) => Promise<string>;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveDone, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolveDone);
  });
  return hash.digest("hex");
}

async function downloadArchive(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`IDFRI Browser 153 下载失败（HTTP ${response.status}）`);
  return new Uint8Array(await response.arrayBuffer());
}

function findChromiumExecutable(root: string): string {
  const matches: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.toLowerCase() === "chrome.exe") matches.push(path);
    }
  };
  visit(root);
  if (matches.length !== 1 || !statSync(matches[0]!).isFile()) {
    throw new Error("IDFRI Browser 153 归档必须且只能包含一个 chrome.exe");
  }
  return matches[0]!;
}

function archiveSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function browserEnvText(current: string, binaryPath: string, sha256: string, newline = "\n", prefix: "IDFRI_CHROMIUM" | "ALIASMODE_FIREFOX" = "IDFRI_CHROMIUM"): string {
  const pathKey = `${prefix}_BINARY_PATH`;
  const hashKey = `${prefix}_BINARY_SHA256`;
  const owned = new RegExp(`^\\s*(?:${pathKey}|${hashKey})\\s*=.*$`, "i");
  const kept = current.split(/\r?\n/).filter((line) => !owned.test(line));
  while (kept.length && !kept.at(-1)?.trim()) kept.pop();
  if (kept.length) kept.push("");
  kept.push(`${pathKey}=${binaryPath}`, `${hashKey}=${sha256.toLowerCase()}`, "");
  return kept.join(newline);
}

/** Install the pinned IDFRI Browser 153 preview, then pin its exact executable hash. */
export async function installOpenChromium(opts: BrowserInstallOptions = {}): Promise<{ path: string; sha256: string }> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const cacheDir = resolve(opts.cacheDir ?? join(cwd, "runtime", "chromium-cache"));
  if ((opts.platform ?? process.platform) !== "win32" || (opts.arch ?? process.arch) !== "x64") {
    throw new Error("IDFRI Browser 153 当前仅提供 Windows x64 版本");
  }
  mkdirSync(cacheDir, { recursive: true });
  const root = join(cacheDir, `idfri-browser-${OPEN_CHROMIUM_REVISION}`);
  const marker = join(root, ".archive-sha256");
  const hashFile = opts.hashFile ?? sha256File;
  let path: string | null = null;
  try {
    const cached = findChromiumExecutable(root);
    if (
      existsSync(marker)
      && readFileSync(marker, "utf8").trim() === IDFRI_BROWSER_ARCHIVE_SHA256
      && (await hashFile(cached)).toLowerCase() === IDFRI_BROWSER_EXECUTABLE_SHA256
    ) path = cached;
  } catch {
    // An absent or incomplete cache is replaced from the pinned release.
  }
  if (!path) {
    const bytes = await (opts.downloadArchive ?? downloadArchive)(IDFRI_BROWSER_ARCHIVE_URL);
    const archiveHash = (opts.archiveHash ?? archiveSha256)(bytes).toLowerCase();
    if (archiveHash !== IDFRI_BROWSER_ARCHIVE_SHA256) {
      throw new Error("IDFRI Browser 153 归档 SHA-256 与已批准版本不一致");
    }
    const staging = mkdtempSync(join(cacheDir, ".idfri-browser-"));
    try {
      await (opts.extractArchive ?? extractZipTo)(bytes, staging);
      const extracted = findChromiumExecutable(staging);
      if ((await hashFile(extracted)).toLowerCase() !== IDFRI_BROWSER_EXECUTABLE_SHA256) {
        throw new Error("IDFRI Browser 153 可执行文件 SHA-256 与已批准版本不一致");
      }
      writeFileSync(join(staging, ".archive-sha256"), `${archiveHash}\n`, "utf8");
      rmSync(root, { recursive: true, force: true });
      renameSync(staging, root);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    path = findChromiumExecutable(root);
  }

  const sha256 = (await hashFile(path)).toLowerCase();
  if (sha256 !== IDFRI_BROWSER_EXECUTABLE_SHA256) {
    throw new Error("IDFRI Browser 153 可执行文件 SHA-256 与已批准版本不一致");
  }

  if (opts.writeEnv !== false) {
    const envPath = resolve(cwd, ".env");
    const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const newline = current.includes("\r\n") || process.platform === "win32" ? "\r\n" : "\n";
    writeFileSync(envPath, browserEnvText(current, path, sha256, newline), "utf8");
  }
  return { path, sha256 };
}

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserEnvText,
  IDFRI_BROWSER_ARCHIVE_NAME,
  IDFRI_BROWSER_ARCHIVE_SHA256,
  IDFRI_BROWSER_ARCHIVE_URL,
  IDFRI_BROWSER_EXECUTABLE_SHA256,
  IDFRI_BROWSER_RELEASE,
  OPEN_CHROMIUM_REVISION,
  OPEN_CHROMIUM_RUNTIME_VERSION,
  OPEN_CHROMIUM_VERSION,
  installOpenChromium,
} from "./browser-install.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("Chromium runtime identity is pinned to the IDFRI Browser 153 preview", () => {
  expect(IDFRI_BROWSER_RELEASE).toBe("browser-v153.0.8010.52-idfri.2");
  expect(IDFRI_BROWSER_ARCHIVE_NAME).toBe("idfri-browser_153.0.8010.52-1.idfri2_windows_x64.zip");
  expect(IDFRI_BROWSER_ARCHIVE_URL).toBe(
    `https://github.com/16188/idfri-browser/releases/download/${IDFRI_BROWSER_RELEASE}/${IDFRI_BROWSER_ARCHIVE_NAME}`,
  );
  expect(IDFRI_BROWSER_ARCHIVE_SHA256).toBe("66df4bf70ba1f54145961a7e567acc0a019ac3c9df850f6d42e7fbbe7a825626");
  expect(IDFRI_BROWSER_EXECUTABLE_SHA256).toBe("74a095427ba38407405eb63ea330070278236838cf8f91532d8d66a42243096a");
  expect(OPEN_CHROMIUM_RUNTIME_VERSION).toBe("idfri-browser@153.0.8010.52-idfri.2");
  expect(OPEN_CHROMIUM_REVISION).toBe("153.0.8010.52-1.idfri2");
  expect(OPEN_CHROMIUM_VERSION).toBe("153.0.8010.52");
});

test("browserEnvText preserves unrelated config and replaces old browser pins", () => {
  const hash = "a".repeat(64);
  const next = browserEnvText(
    "HUB_URL=https://hub.example\r\nIDFRI_CHROMIUM_BINARY_PATH=C:\\old\\chrome.exe\r\nIDFRI_CHROMIUM_BINARY_SHA256=bad\r\nHUB_PASSWORD=secret\r\n",
    "C:\\IDFRI\\runtime\\idfri-browser-153.0.8010.52-1.idfri2\\chrome.exe",
    hash.toUpperCase(),
    "\r\n",
  );
  expect(next).toContain("HUB_URL=https://hub.example\r\n");
  expect(next).toContain("HUB_PASSWORD=secret\r\n");
  expect(next).not.toContain("C:\\old");
  expect(next).toContain("IDFRI_CHROMIUM_BINARY_PATH=C:\\IDFRI\\runtime\\idfri-browser-153.0.8010.52-1.idfri2\\chrome.exe\r\n");
  expect(next).toContain(`IDFRI_CHROMIUM_BINARY_SHA256=${hash}\r\n`);
});

test("installOpenChromium downloads, verifies, and records IDFRI Browser 153", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aliasmode-browser-install-"));
  dirs.push(dir);
  const binary = join(dir, "cache", `idfri-browser-${OPEN_CHROMIUM_REVISION}`, "chrome.exe");
  writeFileSync(join(dir, ".env"), "HUB_PASSWORD=keep-me\n");

  const result = await installOpenChromium({
    cwd: dir,
    cacheDir: join(dir, "cache"),
    platform: "win32",
    arch: "x64",
    downloadArchive: async (url) => {
      expect(url).toBe(IDFRI_BROWSER_ARCHIVE_URL);
      return new TextEncoder().encode("approved archive");
    },
    archiveHash: () => IDFRI_BROWSER_ARCHIVE_SHA256,
    extractArchive: async (_bytes, destination) => {
      writeFileSync(join(destination, "chrome.exe"), "browser");
      return 1;
    },
    hashFile: async () => IDFRI_BROWSER_EXECUTABLE_SHA256,
  });

  expect(result).toEqual({ path: binary, sha256: IDFRI_BROWSER_EXECUTABLE_SHA256 });
  const env = readFileSync(join(dir, ".env"), "utf8");
  expect(env).toContain("HUB_PASSWORD=keep-me");
  expect(env).toContain(`IDFRI_CHROMIUM_BINARY_PATH=${binary}`);
  expect(env).toContain(`IDFRI_CHROMIUM_BINARY_SHA256=${IDFRI_BROWSER_EXECUTABLE_SHA256}`);
});

test("installOpenChromium writes nothing when the IDFRI Browser archive hash is wrong", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aliasmode-browser-install-fail-"));
  dirs.push(dir);
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "HUB_PASSWORD=unchanged\n");
  await expect(installOpenChromium({
    cwd: dir,
    cacheDir: join(dir, "cache"),
    platform: "win32",
    arch: "x64",
    downloadArchive: async () => new TextEncoder().encode("changed archive"),
  })).rejects.toThrow("归档 SHA-256");
  expect(readFileSync(envPath, "utf8")).toBe("HUB_PASSWORD=unchanged\n");
});

test("installOpenChromium rejects an archive containing the wrong chrome.exe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aliasmode-browser-install-executable-fail-"));
  dirs.push(dir);
  await expect(installOpenChromium({
    cwd: dir,
    cacheDir: join(dir, "cache"),
    platform: "win32",
    arch: "x64",
    writeEnv: false,
    downloadArchive: async () => new TextEncoder().encode("approved archive"),
    archiveHash: () => IDFRI_BROWSER_ARCHIVE_SHA256,
    extractArchive: async (_bytes, destination) => {
      writeFileSync(join(destination, "chrome.exe"), "changed browser");
      return 1;
    },
    hashFile: async () => "0".repeat(64),
  })).rejects.toThrow("可执行文件 SHA-256");
});

test("installOpenChromium can return a verified binary without writing environment pins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aliasmode-browser-install-no-env-"));
  dirs.push(dir);
  const binary = join(dir, "cache", `idfri-browser-${OPEN_CHROMIUM_REVISION}`, "chrome.exe");
  const sha256 = IDFRI_BROWSER_EXECUTABLE_SHA256;

  await expect(installOpenChromium({
    cwd: dir,
    cacheDir: join(dir, "cache"),
    writeEnv: false,
    platform: "win32",
    arch: "x64",
    downloadArchive: async () => new TextEncoder().encode("approved archive"),
    archiveHash: () => IDFRI_BROWSER_ARCHIVE_SHA256,
    extractArchive: async (_bytes, destination) => {
      writeFileSync(join(destination, "chrome.exe"), "browser");
      return 1;
    },
    hashFile: async () => sha256,
  })).resolves.toEqual({ path: binary, sha256 });

  expect(existsSync(join(dir, ".env"))).toBe(false);
});

test("installOpenChromium reuses only a fully verified cached IDFRI browser", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aliasmode-browser-install-cache-"));
  dirs.push(dir);
  const root = join(dir, "cache", `idfri-browser-${OPEN_CHROMIUM_REVISION}`);
  const binary = join(root, "chrome.exe");
  mkdirSync(root, { recursive: true });
  writeFileSync(binary, "browser");
  writeFileSync(join(root, ".archive-sha256"), `${IDFRI_BROWSER_ARCHIVE_SHA256}\n`);

  await expect(installOpenChromium({
    cwd: dir,
    cacheDir: join(dir, "cache"),
    writeEnv: false,
    platform: "win32",
    arch: "x64",
    downloadArchive: async () => { throw new Error("verified cache must not download"); },
    hashFile: async () => IDFRI_BROWSER_EXECUTABLE_SHA256,
  })).resolves.toEqual({ path: binary, sha256: IDFRI_BROWSER_EXECUTABLE_SHA256 });
});

test("installOpenChromium rejects hosts without an IDFRI Browser 153 build", async () => {
  await expect(installOpenChromium({ platform: "linux", arch: "x64", writeEnv: false }))
    .rejects.toThrow("Windows x64");
});

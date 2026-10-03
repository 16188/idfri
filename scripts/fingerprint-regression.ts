import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { buildNewProfile } from "../create.ts";
import { fingerprintProbe, type FingerprintSample } from "../diagnose.ts";
import { deriveChromiumFingerprintArgs, deriveIdfriFingerprintConfig } from "../fingerprint.ts";
import { allocatePort } from "../ports.ts";
import type { Profile } from "../types.ts";

const STABLE_FIELDS: Array<keyof FingerprintSample> = [
  "userAgent", "uaDataPlatform", "uaDataBrands", "uaDataPlatformVersion", "uaFullVersionList",
  "platform", "language", "languages", "timezone", "hardwareConcurrency", "deviceMemory",
  "screen", "webglVendor", "webglRenderer", "canvasHash", "audioHash",
];

export function fingerprintDifferences(left: FingerprintSample, right: FingerprintSample): string[] {
  return STABLE_FIELDS.filter((field) => JSON.stringify(left[field]) !== JSON.stringify(right[field])).map(String);
}

export function fingerprintConsistency(profile: Profile, sample: FingerprintSample): string[] {
  const expected = deriveIdfriFingerprintConfig(profile);
  const checks: Array<[string, unknown, unknown]> = [
    ["userAgent", expected.navigator.userAgent, sample.userAgent],
    ["uaDataPlatform", expected.clientHints.platform, sample.uaDataPlatform],
    ["platform", expected.navigator.platform, sample.platform],
    ["language", expected.navigator.languages[0], sample.language],
    ["languages", expected.navigator.languages, sample.languages],
    ["timezone", expected.locale.timezone, sample.timezone],
    ["hardwareConcurrency", expected.navigator.hardwareConcurrency, sample.hardwareConcurrency],
    ["deviceMemory", expected.navigator.deviceMemory, sample.deviceMemory],
    ["webglVendor", expected.gpu.webglParams.UNMASKED_VENDOR_WEBGL, sample.webglVendor],
    ["webglRenderer", expected.gpu.webglParams.UNMASKED_RENDERER_WEBGL, sample.webglRenderer],
    ["screen", [expected.screen.width, expected.screen.height, expected.screen.availWidth, expected.screen.availHeight, expected.screen.colorDepth, expected.screen.devicePixelRatio], sample.screen ? [sample.screen.width, sample.screen.height, sample.screen.availWidth, sample.screen.availHeight, sample.screen.colorDepth, sample.screen.dpr] : null],
  ];
  return checks.filter(([, wanted, seen]) => JSON.stringify(wanted) !== JSON.stringify(seen)).map(([field]) => field);
}

interface SiteResult { url: string; finalUrl: string; status: number | null; title: string; bodyLength: number; turnstileFrames?: number; screenshot: string; ok: boolean }

async function launchAndProbe(binary: string, output: string, profile: Profile, label: string, websites: boolean) {
  const port = allocatePort({ start: 19333, end: 19999 });
  const userData = join(output, `${label}-${randomUUID()}`);
  mkdirSync(userData, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${userData}`,
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage",
    "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist",
    ...deriveChromiumFingerprintArgs(profile),
  ];
  const child = Bun.spawn([binary, ...args], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  child.stdin!.write(JSON.stringify(deriveIdfriFingerprintConfig(profile)));
  child.stdin!.end();
  let endpoint = "";
  for (let attempt = 0; attempt < 300 && !endpoint; attempt++) {
    await new Promise((done) => setTimeout(done, 200));
    endpoint = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json()).then((value) => value.webSocketDebuggerUrl ?? "").catch(() => "");
  }
  if (!endpoint) { child.kill(); throw new Error(`${label}: Chromium CDP 启动超时`); }
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error(`${label}: 浏览器上下文不可用`);
    const probePage = await context.newPage();
    await probePage.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 45_000 });
    const fingerprint = await probePage.evaluate(fingerprintProbe);
    await probePage.close();
    const sites: SiteResult[] = [];
    if (websites) for (const [index, url] of ["https://example.com/", "https://demo.turnstile.workers.dev/"] .entries()) {
      const page = await context.newPage();
      let status: number | null = null;
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        status = response?.status() ?? null;
        await page.waitForTimeout(2_000);
        const screenshot = join(output, `${label}-site-${index + 1}.png`);
        await page.screenshot({ path: screenshot, fullPage: false });
        const result: SiteResult = {
          url, finalUrl: page.url(), status, title: await page.title(),
          bodyLength: await page.locator("body").innerText({ timeout: 5_000 }).then((text) => text.length).catch(() => 0),
          ...(url.includes("turnstile") ? { turnstileFrames: page.frames().filter((frame) => frame.url().includes("challenges.cloudflare.com")).length } : {}),
          screenshot, ok: status !== null && status < 500 && (url.includes("turnstile") ? page.frames().some((frame) => frame.url().includes("challenges.cloudflare.com")) : true),
        };
        sites.push(result);
      } catch (error) {
        sites.push({ url, finalUrl: page.url(), status, title: "", bodyLength: 0, screenshot: "", ok: false, ...(url.includes("turnstile") ? { turnstileFrames: 0 } : {}), error: error instanceof Error ? error.message : String(error) } as SiteResult);
      } finally { await page.close().catch(() => {}); }
    }
    return { fingerprint, sites };
  } finally {
    try { const session = await browser.newBrowserCDPSession(); await session.send("Browser.close"); } catch { child.kill(); }
    await Promise.race([child.exited, new Promise((done) => setTimeout(done, 5_000))]);
    try { child.kill(); } catch {}
  }
}

async function main() {
  const binary = process.env.IDFRI_CHROMIUM_BINARY_PATH?.trim();
  const expectedSha = process.env.IDFRI_CHROMIUM_BINARY_SHA256?.trim().toLowerCase();
  if (!binary || !expectedSha) throw new Error("必须设置 IDFRI_CHROMIUM_BINARY_PATH 和 IDFRI_CHROMIUM_BINARY_SHA256");
  const actualSha = createHash("sha256").update(new Uint8Array(await Bun.file(binary).arrayBuffer())).digest("hex");
  if (actualSha !== expectedSha) throw new Error("IDFRI Chromium SHA-256 不匹配");
  const output = resolve(process.env.IDFRI_REGRESSION_OUTPUT || "artifacts/fingerprint-regression");
  mkdirSync(output, { recursive: true });
  const profileA = buildNewProfile({ name: "regression-a", screen: "1920x1080" }, () => false);
  const profileB = buildNewProfile({ name: "regression-b", screen: "1920x1080" }, (id) => id === profileA.id);
  profileA.fingerprintSeed = 153001;
  profileB.fingerprintSeed = 153002;
  const first = await launchAndProbe(binary, output, profileA, "same-profile-first", true);
  const second = await launchAndProbe(binary, output, profileA, "same-profile-second", false);
  const different = await launchAndProbe(binary, output, profileB, "different-profile", false);
  const stableDifferences = fingerprintDifferences(first.fingerprint, second.fingerprint);
  const consistency = fingerprintConsistency(profileA, first.fingerprint);
  const uniqueness = ["canvasHash", "audioHash"].filter((field) => first.fingerprint[field as keyof FingerprintSample] === different.fingerprint[field as keyof FingerprintSample]);
  const failures = [
    ...stableDifferences.map((field) => `同一资料重启后 ${field} 发生变化`),
    ...consistency.map((field) => `资料设置与浏览器 ${field} 不一致`),
    ...uniqueness.map((field) => `不同种子的 ${field} 未变化`),
    ...first.sites.filter((site) => !site.ok).map((site) => `真实网站回归失败：${site.url}`),
  ];
  const report = { generatedAt: new Date().toISOString(), binarySha256: actualSha, stableDifferences, consistency, uniqueness, websites: first.sites, samples: { first: first.fingerprint, second: second.fingerprint, different: different.fingerprint }, failures, ok: failures.length === 0 };
  writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: report.ok, failures, report: join(output, "report.json") }));
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.main) await main();

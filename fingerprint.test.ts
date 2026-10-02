import { test, expect } from "bun:test";
import {
  deterministicSeed,
  parseResolution,
  platformFromUA,
  chromeMajorFromUA,
  deriveChromiumFingerprintArgs,
  deriveIdfriFingerprintConfig,
  parseProfileFingerprintSettings,
  proxyServerFlag,
  isMobileUserAgent,
  convertMobilePersonaToDesktop,
  hostPlatformOs,
} from "./fingerprint.ts";
import type { Profile } from "./types.ts";

const UA_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const UA_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "k1d0cd11",
    accId: "1",
    name: "n",
    group: "g",
    username: "",
    password: "",
    twofa: "",
    proxy: { type: "http", host: "1.2.3.4", port: "8080", user: "u", pass: "p@ss word" },
    ua: UA_WIN,
    timezone: "",
    screenWidth: 1680,
    screenHeight: 1050,
    fingerprintSeed: deterministicSeed("k1d0cd11"),
    cookies: [],
    seeded: false,
    ...overrides,
  };
}

test("deterministicSeed is stable and non-zero for the same id", () => {
  const a = deterministicSeed("k1d0cd11");
  const b = deterministicSeed("k1d0cd11");
  expect(a).toBe(b);
  expect(a).toBeGreaterThan(0);
});

test("deterministicSeed differs across ids", () => {
  expect(deterministicSeed("k1d0cd11")).not.toBe(deterministicSeed("k1d0ccwr"));
});

test("parseResolution handles * and x and defaults", () => {
  expect(parseResolution("1680*1050")).toEqual({ width: 1680, height: 1050 });
  expect(parseResolution("1920x1080")).toEqual({ width: 1920, height: 1080 });
  expect(parseResolution("garbage")).toEqual({ width: 1920, height: 1080 });
  expect(parseResolution("")).toEqual({ width: 1920, height: 1080 });
});

test("platform + chrome version inferred from UA", () => {
  expect(platformFromUA(UA_WIN)).toBe("windows");
  expect(platformFromUA(UA_MAC)).toBe("macos");
  expect(platformFromUA("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  expect(platformFromUA("")).toBeNull();
  expect(platformFromUA("Mozilla/5.0 (Linux; Android 14; Mobile)")).toBeNull();
  expect(chromeMajorFromUA(UA_WIN)).toBe("143");
  expect(chromeMajorFromUA("no chrome here")).toBeNull();
});

test("mobile user agents are identified without classifying desktop Linux", () => {
  expect(isMobileUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/146.0 Mobile Safari/537.36")).toBe(true);
  expect(isMobileUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148")).toBe(true);
  expect(isMobileUserAgent("Mozilla/5.0 (X11; Linux x86_64) Chrome/146.0.0.0 Safari/537.36")).toBe(false);
});

test("Android conversion preserves account identity and maps the old effective persona to Windows desktop", () => {
  const original = profile({
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/146.0.0.0 Mobile Safari/537.36",
    timezone: "America/New_York",
    screenWidth: 412,
    screenHeight: 915,
    cookies: [{ name: "auth_token", value: "secret", domain: ".x.com", path: "/" }],
    extensions: ["ext-one"],
    tags: ["warm"],
    seeded: true,
  });

  const conversion = convertMobilePersonaToDesktop(original);
  expect(conversion.platform).toBe("windows");
  expect(conversion.screenChanged).toBe(true);
  expect(conversion.profile.ua).toContain("Windows NT 10.0");
  expect(conversion.profile.ua).toContain("Chrome/146.0.0.0");
  expect(isMobileUserAgent(conversion.profile.ua)).toBe(false);
  expect(conversion.profile.screenWidth).toBeGreaterThanOrEqual(1024);
  expect(conversion.profile.screenWidth).toBeGreaterThanOrEqual(conversion.profile.screenHeight);
  for (const key of ["id", "fingerprintSeed", "proxy", "timezone", "cookies", "extensions", "tags", "seeded"] as const) {
    expect(conversion.profile[key]).toEqual(original[key]);
  }
  // The helper returns a replacement; a failed save cannot partially mutate the source.
  expect(original.screenWidth).toBe(412);
  expect(isMobileUserAgent(original.ua)).toBe(true);
});

test("iPhone conversion maps to macOS and preserves an already plausible desktop screen", () => {
  const conversion = convertMobilePersonaToDesktop(profile({
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    screenWidth: 1440,
    screenHeight: 900,
  }));
  expect(conversion.platform).toBe("macos");
  expect(conversion.screenChanged).toBe(false);
  expect(conversion.profile.ua).toContain("Macintosh");
  expect([conversion.profile.screenWidth, conversion.profile.screenHeight]).toEqual([1440, 900]);
});

test("desktop profiles cannot be accidentally converted through the mobile migration helper", () => {
  expect(() => convertMobilePersonaToDesktop(profile())).toThrow("does not have a mobile persona");
});

test("IDFRI fingerprint config is deterministic and uses stored identity", () => {
  const p = profile();
  const a = deriveIdfriFingerprintConfig(p);
  const b = deriveIdfriFingerprintConfig(p);
  expect(a).toEqual(b);
  expect(a.schema_version).toBe(1);
  expect(a.screen.width).toBe(1680);
  expect(a.screen.height).toBe(1050);
  expect(a.locale.timezone).toBe("Asia/Shanghai");
  expect(a.navigator.userAgent).toContain("Chrome/153.0.0.0");
  expect(a.clientHints.fullVersion).toBe("153.0.8010.52");
  expect(a.clientHints.fullVersionList).toContain("Chromium/153.0.8010.52");
  expect(a.gpu.webglParams.UNMASKED_RENDERER_WEBGL).toContain("RTX 4060");
});

test("IDFRI fingerprint config keeps UA, UA-CH, locale, screen and noise coherent", () => {
  const config = deriveIdfriFingerprintConfig(profile({ timezone: "America/New_York" }));
  expect(config.navigator.platform).toBe("Win32");
  expect(config.clientHints.platform).toBe("Windows");
  expect(config.clientHints.brands).toContain("Chromium/153");
  expect(config.locale.timezone).toBe("America/New_York");
  expect(config.screen.availHeight).toBe(1002);
  expect(config.noise.canvasSeed).toBeGreaterThanOrEqual(0);
  expect(config.noise.canvasSeed).toBeLessThan(0x80000000);
});

test("profile overrides reach every supported IDFRI fingerprint surface", () => {
  const fingerprint = parseProfileFingerprintSettings({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.8010.52 Safari/537.36",
    languages: ["en-US", "en"], locale: "en-US",
    hardwareConcurrency: 8, deviceMemory: 4, devicePixelRatio: 1.25, colorDepth: 30,
    webglVendor: "Google Inc. (Intel)", webglRenderer: "ANGLE (Intel, Intel Iris Xe, D3D11)",
    canvasNoise: false, audioNoise: false, clientRectsNoise: false,
    mediaDevices: { audioInputCount: 1, audioOutputCount: 2, videoInputCount: 0 },
    fonts: ["Arial", "Calibri"], speechVoices: ["Microsoft Huihui"],
    geolocation: { latitude: 31.23, longitude: 121.47, accuracy: 20_000 },
    geolocationPermission: "granted", webrtcPolicy: "default_public_interface_only",
    webgpuMode: "disabled", doNotTrack: true, hardwareAcceleration: false,
  })!;
  const config = deriveIdfriFingerprintConfig(profile({ fingerprint }));
  expect(config.navigator).toMatchObject({ hardwareConcurrency: 8, deviceMemory: 4, languages: ["en-US", "en"] });
  expect(config.locale.locale).toBe("en-US");
  expect(config.screen).toMatchObject({ devicePixelRatio: 1.25, colorDepth: 30 });
  expect(config.gpu.webglParams.UNMASKED_VENDOR_WEBGL).toBe("Google Inc. (Intel)");
  expect(config.gpu.webgpu.vendor).toBe("intel");
  expect(config.noise.canvasSeed).toBeUndefined();
  expect(config.noise.audioSeed).toBeUndefined();
  expect(config.noise.clientRectsSeed).toBeUndefined();
  expect(config.mediaDevices).toEqual(fingerprint.mediaDevices);
  expect(config.speech!.voices).toEqual(["Microsoft Huihui"]);
  expect(config.geolocation).toEqual(fingerprint.geolocation);
  expect(config.permissions.geolocation).toBe("granted");
  expect(config.webrtc.ipHandlingPolicy).toBe("default_public_interface_only");
  const args = deriveChromiumFingerprintArgs(profile({ fingerprint }));
  expect(args).toContain("--idfri-fp-stdin");
  expect(args).toContain("--disable-features=WebGPU");
  expect(args).toContain("--disable-gpu");
  expect(args).toContain("--accept-lang=en-US,en");
});

test("fingerprint validation rejects incoherent or unsafe custom values", () => {
  expect(() => parseProfileFingerprintSettings({ userAgent: "Mozilla/5.0 Chrome/149.0.0.0" })).toThrow("当前 Chromium 153");
  expect(() => parseProfileFingerprintSettings({ userAgent: "Mozilla/5.0 Android Chrome/153.0.0.0 Mobile" })).toThrow("桌面版 Chrome UA");
  expect(() => parseProfileFingerprintSettings({ geolocation: { latitude: 91, longitude: 0, accuracy: 1 } })).toThrow("纬度");
  expect(() => parseProfileFingerprintSettings({ deviceMemory: 3 })).toThrow("设备内存必须是");
});

test("different profile seeds change noise without changing the measured device", () => {
  const a = deriveIdfriFingerprintConfig(profile({ fingerprintSeed: 1 }));
  const b = deriveIdfriFingerprintConfig(profile({ fingerprintSeed: 2 }));
  expect(a.noise).not.toEqual(b.noise);
  expect(a.gpu).toEqual(b.gpu);
  expect(a.navigator).toEqual(b.navigator);
});

test("IDFRI Chromium refuses a non-Windows persona instead of partially spoofing it", () => {
  expect(() => deriveIdfriFingerprintConfig(profile({ platformOs: "macos", ua: UA_MAC })))
    .toThrow("当前仅支持 Windows 指纹资料");
});

test("IDFRI Browser 153 args keep version, locale, screen, GPU and TLS coherent", () => {
  const args = deriveChromiumFingerprintArgs(profile({ timezone: "America/New_York" }));
  for (const expected of [
    "--fingerprint-platform=windows",
    "--fingerprint-brand=chrome",
    "--fingerprint-brand-version=153.0.8010.52",
    "--fingerprint-screen-width=1680",
    "--fingerprint-screen-height=1050",
    "--timezone=America/New_York",
    "--accept-lang=zh-CN,zh",
    "--lang=zh-CN",
    "--idfri-fp-stdin",
    "--fingerprint-tls-profile=chrome-153",
  ]) expect(args).toContain(expected);
  expect(args.filter((arg) => arg.startsWith("--fingerprint-device-memory="))).toHaveLength(1);
  expect(args.some((arg) => arg.startsWith("--user-agent="))).toBe(true);
});

test("proxyServerFlag url-encodes credentials and respects scheme", () => {
  expect(proxyServerFlag(profile())).toBe("--proxy-server=http://u:p%40ss%20word@1.2.3.4:8080");
  expect(proxyServerFlag(profile({ proxy: null }))).toBeNull();
  expect(proxyServerFlag(profile({ proxy: { type: "socks5", host: "h", port: "1", user: "", pass: "" } }))).toBe(
    "--proxy-server=socks5://h:1",
  );
  expect(proxyServerFlag(profile({ proxy: { type: "socks5", host: "h", port: "1", user: "u", pass: "p@ss" } }))).toBe(
    "--proxy-server=socks5://u:p%40ss@h:1",
  );
});

test("hostPlatformOs reports a recognized desktop platform", () => {
  expect(["windows", "macos", "linux"]).toContain(hostPlatformOs());
});

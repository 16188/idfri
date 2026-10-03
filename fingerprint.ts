/** Deterministic IDFRI Browser fingerprint derivation. */

import type { Profile, ProfileFingerprintSettings } from "./types.ts";
import { proxyUrl } from "./proxy.ts";

/** FNV-1a 32-bit hash → positive integer. Stable across runs and platforms. */
export function deterministicSeed(profileId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < profileId.length; i++) {
    h ^= profileId.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in integer range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  // Keep it well clear of 0 so a seed is always "set".
  return h === 0 ? 1 : h;
}

/** Parse AdsPower "1680*1050" (or "1680x1050") → width/height; default 1920x1080. */
export function parseResolution(res: string): { width: number; height: number } {
  const m = (res ?? "").trim().match(/^(\d{3,5})\s*[*x×]\s*(\d{3,5})$/i);
  if (!m) return { width: 1920, height: 1080 };
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** Mobile UAs cannot be represented coherently by AliasMode's desktop browser. */
export function isMobileUserAgent(ua: string): boolean {
  return /\b(?:android|iphone|ipad|ipod|windows phone|mobile)\b/i.test(ua ?? "");
}

/** Infer a recognized desktop platform; blank/mobile/unknown UAs have no imported persona. */
export function platformFromUA(ua: string): "windows" | "macos" | "linux" | null {
  const s = (ua ?? "").toLowerCase();
  if (s.includes("mac os") || s.includes("macintosh")) return "macos";
  if (s.includes("linux") && !s.includes("android")) return "linux";
  if (s.includes("windows")) return "windows";
  return null;
}

/** The platform this host would present, recorded once at profile creation. */
export function hostPlatformOs(): "windows" | "macos" | "linux" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

/** Infer only architecture tokens that a desktop UA states explicitly. */
export function architectureFromUA(ua: string): "x64" | "arm64" | null {
  const s = (ua ?? "").toLowerCase();
  if (/\b(?:arm64|aarch64)\b/.test(s)) return "arm64";
  if (/\b(?:x86_64|x64|amd64|win64|wow64)\b/.test(s)) return "x64";
  return null;
}

/** Pull the Chrome major version (e.g. "143") out of a UA, or null. */
export function chromeMajorFromUA(ua: string): string | null {
  const m = (ua ?? "").match(/Chrome\/(\d+)/);
  return m ? m[1]! : null;
}

export type DesktopPersonaPlatform = "windows" | "macos";

export interface MobilePersonaConversion {
  profile: Profile;
  platform: DesktopPersonaPlatform;
  screenChanged: boolean;
}

const DESKTOP_SCREENS: ReadonlyArray<readonly [number, number]> = [
  [1920, 1080],
  [1536, 864],
  [1366, 768],
  [1440, 900],
  [1600, 900],
  [2560, 1440],
];

function mobilePersonaDesktopPlatform(ua: string): DesktopPersonaPlatform {
  // This deliberately follows the effective pre-hardening behavior. The old
  // platform classifier mapped Apple mobile UAs to macOS and defaulted Android
  // and Windows Phone to Windows. Keeping that family minimizes account-visible
  // discontinuity while replacing the impossible mobile claim.
  return /\b(?:iphone|ipad|ipod)\b|mac os/i.test(ua) ? "macos" : "windows";
}

function sourceChromiumMajor(ua: string): string {
  // Preserve the imported major when one exists. Current AliasMode does not
  // force it at launch; this only keeps the persisted/exported desktop UA
  // meaningful and remains compatible with older managers.
  return ua.match(/\b(?:Chrome|CriOS)\/(\d+)/i)?.[1] ?? "146";
}

function desktopUserAgent(platform: DesktopPersonaPlatform, sourceUa: string): string {
  const major = sourceChromiumMajor(sourceUa);
  if (platform === "macos") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * Convert an imported mobile persona into the closest coherent desktop one.
 *
 * This is intentionally a narrow, explicit migration: account credentials,
 * cookies, proxy, timezone, fingerprint seed, extensions and tags remain
 * untouched. A plausible landscape desktop screen is preserved; a phone/tablet
 * screen is replaced deterministically from the existing seed so retries are
 * idempotent and the result does not rotate between operators.
 */
export function convertMobilePersonaToDesktop(profile: Profile): MobilePersonaConversion {
  if (!isMobileUserAgent(profile.ua)) {
    throw new Error("profile does not have a mobile persona");
  }
  const platform = mobilePersonaDesktopPlatform(profile.ua);
  const plausibleDesktopScreen = profile.screenWidth >= 1024
    && profile.screenHeight >= 600
    && profile.screenWidth >= profile.screenHeight;
  const screen = plausibleDesktopScreen
    ? [profile.screenWidth, profile.screenHeight] as const
    : DESKTOP_SCREENS[profile.fingerprintSeed % DESKTOP_SCREENS.length]!;
  return {
    platform,
    screenChanged: !plausibleDesktopScreen,
    profile: {
      ...profile,
      ua: desktopUserAgent(platform, profile.ua),
      screenWidth: screen[0],
      screenHeight: screen[1],
    },
  };
}

const WEBRTC_POLICIES = new Set<ProfileFingerprintSettings["webrtcPolicy"]>([
  "default", "default_public_interface_only", "disable_non_proxied_udp",
]);

function finiteNumber(value: unknown, label: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label}必须在 ${min} 到 ${max} 之间`);
  }
  return number;
}

function optionalString(value: unknown, label: string, max = 512): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) throw new Error(`${label}最多 ${max} 个字符`);
  return text;
}

function stringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label}必须是文本列表`);
  }
  const list = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (list.length > 128 || list.some((item) => item.length > 128)) {
    throw new Error(`${label}最多 128 项，每项最多 128 个字符`);
  }
  return list.length ? list : undefined;
}

/** Validate and normalize profile-level settings at every persistence boundary. */
export function parseProfileFingerprintSettings(value: unknown): ProfileFingerprintSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("指纹设置必须是对象");
  const input = value as Record<string, unknown>;
  const out: ProfileFingerprintSettings = {};
  const userAgent = optionalString(input.userAgent, "用户代理", 1024);
  if (userAgent) {
    if (!/\bChrome\/\d+(?:\.\d+){0,3}\b/.test(userAgent) || isMobileUserAgent(userAgent)) {
      throw new Error("用户代理必须是桌面版 Chrome UA");
    }
    if (chromeMajorFromUA(userAgent) !== CHROMIUM_MAJOR) {
      throw new Error(`用户代理必须与当前 Chromium ${CHROMIUM_MAJOR} 内核版本一致`);
    }
    out.userAgent = userAgent;
  }
  const languages = stringList(input.languages, "语言");
  if (languages) {
    try { out.languages = Intl.getCanonicalLocales(languages); }
    catch { throw new Error("语言必须使用有效的 BCP 47 标签，例如 zh-CN"); }
  }
  const locale = optionalString(input.locale, "界面语言", 64);
  if (locale) {
    try { out.locale = Intl.getCanonicalLocales(locale)[0]!; }
    catch { throw new Error("界面语言必须使用有效的 BCP 47 标签，例如 zh-CN"); }
  }
  if (input.hardwareConcurrency !== undefined) {
    const count = finiteNumber(input.hardwareConcurrency, "CPU 核心数", 1, 128);
    if (!Number.isInteger(count)) throw new Error("CPU 核心数必须是整数");
    out.hardwareConcurrency = count;
  }
  if (input.deviceMemory !== undefined) {
    const memory = finiteNumber(input.deviceMemory, "设备内存", 0.25, 8);
    if (![0.25, 0.5, 1, 2, 4, 8].includes(memory)) throw new Error("设备内存必须是 0.25、0.5、1、2、4 或 8 GB");
    out.deviceMemory = memory;
  }
  if (input.devicePixelRatio !== undefined) out.devicePixelRatio = finiteNumber(input.devicePixelRatio, "设备像素比", 0.5, 4);
  if (input.colorDepth !== undefined) {
    const depth = finiteNumber(input.colorDepth, "颜色深度", 1, 64);
    if (!Number.isInteger(depth)) throw new Error("颜色深度必须是整数");
    out.colorDepth = depth;
  }
  for (const [key, label] of [["webglVendor", "WebGL 厂商"], ["webglRenderer", "WebGL 渲染器"]] as const) {
    const text = optionalString(input[key], label, 512);
    if (text) out[key] = text;
  }
  if (input.webgpuMode !== undefined) {
    if (input.webgpuMode !== "match-webgl" && input.webgpuMode !== "disabled") throw new Error("WebGPU 设置无效");
    out.webgpuMode = input.webgpuMode;
  }
  if (input.webrtcPolicy !== undefined) {
    if (!WEBRTC_POLICIES.has(input.webrtcPolicy as ProfileFingerprintSettings["webrtcPolicy"])) throw new Error("WebRTC 策略无效");
    out.webrtcPolicy = input.webrtcPolicy as ProfileFingerprintSettings["webrtcPolicy"];
  }
  for (const key of ["canvasNoise", "audioNoise", "clientRectsNoise", "doNotTrack", "hardwareAcceleration"] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean") throw new Error(`${key} 必须是布尔值`);
      out[key] = input[key];
    }
  }
  if (input.mediaDevices !== undefined) {
    if (!input.mediaDevices || typeof input.mediaDevices !== "object" || Array.isArray(input.mediaDevices)) throw new Error("媒体设备设置无效");
    const media = input.mediaDevices as Record<string, unknown>;
    const count = (key: string, label: string) => {
      const result = finiteNumber(media[key], label, 0, 32);
      if (!Number.isInteger(result)) throw new Error(`${label}必须是整数`);
      return result;
    };
    out.mediaDevices = {
      audioInputCount: count("audioInputCount", "麦克风数量"),
      audioOutputCount: count("audioOutputCount", "扬声器数量"),
      videoInputCount: count("videoInputCount", "摄像头数量"),
    };
  }
  const fonts = stringList(input.fonts, "字体");
  if (fonts) out.fonts = fonts;
  const speechVoices = stringList(input.speechVoices, "语音列表");
  if (speechVoices) out.speechVoices = speechVoices;
  if (input.geolocation !== undefined) {
    if (!input.geolocation || typeof input.geolocation !== "object" || Array.isArray(input.geolocation)) throw new Error("地理位置设置无效");
    const geo = input.geolocation as Record<string, unknown>;
    out.geolocation = {
      latitude: finiteNumber(geo.latitude, "纬度", -90, 90),
      longitude: finiteNumber(geo.longitude, "经度", -180, 180),
      accuracy: finiteNumber(geo.accuracy, "定位精度", 1, 1_000_000),
    };
  }
  if (input.geolocationPermission !== undefined) {
    if (!["prompt", "granted", "denied"].includes(String(input.geolocationPermission))) throw new Error("地理位置权限无效");
    out.geolocationPermission = input.geolocationPermission as ProfileFingerprintSettings["geolocationPermission"];
  }
  return Object.keys(out).length ? out : undefined;
}

const CHROMIUM_VERSION = "153.0.8010.52";
const CHROMIUM_MAJOR = "153";

const WINDOWS_FONTS = [
  "Arial", "Arial Black", "Bahnschrift", "Calibri", "Cambria", "Candara",
  "Comic Sans MS", "Consolas", "Constantia", "Corbel", "Courier New", "Ebrima",
  "Gadugi", "Georgia", "Impact", "Leelawadee UI", "MS Gothic", "MV Boli",
  "Malgun Gothic", "Microsoft JhengHei", "Microsoft YaHei", "Nirmala UI",
  "Segoe UI", "Segoe UI Emoji", "Segoe UI Variable", "Sitka", "Sylfaen",
  "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "Webdings", "Wingdings",
  "Yu Gothic",
];

const WEBGL_EXTENSIONS = [
  "ANGLE_instanced_arrays", "EXT_blend_minmax", "EXT_clip_control",
  "EXT_color_buffer_half_float", "EXT_depth_clamp", "EXT_float_blend",
  "EXT_frag_depth", "EXT_polygon_offset_clamp", "EXT_shader_texture_lod",
  "EXT_texture_compression_bptc", "EXT_texture_compression_rgtc",
  "EXT_texture_filter_anisotropic", "EXT_texture_mirror_clamp_to_edge", "EXT_sRGB",
  "OES_element_index_uint", "OES_fbo_render_mipmap", "OES_standard_derivatives",
  "OES_texture_float", "OES_texture_float_linear", "OES_texture_half_float",
  "OES_texture_half_float_linear", "OES_vertex_array_object",
  "WEBGL_blend_func_extended", "WEBGL_color_buffer_float",
  "WEBGL_compressed_texture_s3tc", "WEBGL_compressed_texture_s3tc_srgb",
  "WEBGL_debug_renderer_info", "WEBGL_debug_shaders", "WEBGL_depth_texture",
  "WEBGL_draw_buffers", "WEBGL_lose_context", "WEBGL_multi_draw", "WEBGL_polygon_mode",
];

const WEBGL_PARAMS = {
  MAX_TEXTURE_SIZE: 16384,
  MAX_RENDERBUFFER_SIZE: 16384,
  MAX_CUBE_MAP_TEXTURE_SIZE: 16384,
  MAX_TEXTURE_IMAGE_UNITS: 16,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
  MAX_VERTEX_ATTRIBS: 16,
  MAX_VERTEX_UNIFORM_VECTORS: 4096,
  MAX_FRAGMENT_UNIFORM_VECTORS: 1024,
  MAX_VARYING_VECTORS: 30,
  RED_BITS: 8,
  GREEN_BITS: 8,
  BLUE_BITS: 8,
  ALPHA_BITS: 8,
  DEPTH_BITS: 24,
  STENCIL_BITS: 0,
  SUBPIXEL_BITS: 4,
  SAMPLE_BUFFERS: 0,
  SAMPLES: 0,
  MAX_VIEWPORT_DIMS: "32767,32767",
  ALIASED_LINE_WIDTH_RANGE: "1,1",
  ALIASED_POINT_SIZE_RANGE: "1,1024",
  VENDOR: "WebKit",
  RENDERER: "WebKit WebGL",
  UNMASKED_VENDOR_WEBGL: "Google Inc. (NVIDIA)",
  UNMASKED_RENDERER_WEBGL: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
};

const U64_MASK = (1n << 64n) - 1n;

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function subSeed(seed: number, purpose: string): number {
  let value = BigInt(seed >>> 0);
  for (const byte of new TextEncoder().encode(purpose)) value = mix64(value ^ BigInt(byte));
  return Number(mix64(value) & 0x7fffffffn);
}

/**
 * Build the complete schema consumed by the source-level IDFRI Chromium patches.
 * The hardware values come from Fury's measured Windows 11 / RTX 4060 persona;
 * profile-owned screen, timezone and noise seeds stay stable across launches.
 */
export function deriveIdfriFingerprintConfig(profile: Profile) {
  const settings = profile.fingerprint ?? {};
  const platform = profile.platformOs || platformFromUA(profile.ua) || "windows";
  if (platform !== "windows") {
    throw new Error(`IDFRI Browser 当前仅支持 Windows 指纹资料，收到：${platform}`);
  }
  const width = Math.max(640, Math.round(profile.screenWidth));
  const height = Math.max(480, Math.round(profile.screenHeight));
  const userAgent = settings.userAgent
    ?? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36`;
  const customVersion = settings.userAgent?.match(/\bChrome\/(\d+(?:\.\d+){0,3})\b/)?.[1];
  const version = customVersion
    ? customVersion.split(".").concat("0", "0", "0", "0").slice(0, 4).join(".")
    : CHROMIUM_VERSION;
  const major = chromeMajorFromUA(userAgent) ?? CHROMIUM_MAJOR;
  const languages = settings.languages ?? ["zh-CN", "zh"];
  const locale = settings.locale ?? languages[0] ?? "zh-CN";
  const webglParams = {
    ...WEBGL_PARAMS,
    ...(settings.webglVendor ? { UNMASKED_VENDOR_WEBGL: settings.webglVendor } : {}),
    ...(settings.webglRenderer ? { UNMASKED_RENDERER_WEBGL: settings.webglRenderer } : {}),
  };
  const renderer = webglParams.UNMASKED_RENDERER_WEBGL.toLowerCase();
  const webgpu = renderer.includes("intel")
    ? { vendor: "intel", architecture: "gen-12" }
    : renderer.includes("amd") || renderer.includes("radeon")
      ? { vendor: "amd", architecture: "rdna" }
      : { vendor: "nvidia", architecture: "ada" };
  const fullBrands = [
    "Not;A=Brand/8.0.0.0",
    `Chromium/${version}`,
    `Google Chrome/${version}`,
  ];
  return {
    schema_version: 1,
    navigator: {
      userAgent,
      platform: "Win32",
      languages,
      hardwareConcurrency: settings.hardwareConcurrency ?? 12,
      deviceMemory: settings.deviceMemory ?? 8,
      maxTouchPoints: 0,
    },
    clientHints: {
      brands: ["Not;A=Brand/8", `Chromium/${major}`, `Google Chrome/${major}`],
      fullVersionList: fullBrands,
      platform: "Windows",
      platformVersion: "15.0.0",
      architecture: "x86",
      bitness: "64",
      model: "",
      mobile: false,
      wow64: false,
      fullVersion: version,
      formFactors: [],
    },
    screen: {
      width,
      height,
      availWidth: width,
      availHeight: Math.max(480, height - 48),
      availLeft: 0,
      availTop: 0,
      colorDepth: settings.colorDepth ?? 24,
      devicePixelRatio: settings.devicePixelRatio ?? 1,
      chromeHeightDelta: 139,
      chromeWidthDelta: 0,
      scrollbarWidth: 15,
    },
    gpu: {
      webglParams,
      webglExtensions: WEBGL_EXTENSIONS,
      webgpu: {
        ...webgpu,
        device: "",
        description: "",
        limits: {
          maxTextureDimension1D: 16384,
          maxTextureDimension2D: 16384,
          maxTextureDimension3D: 2048,
          maxTextureArrayLayers: 2048,
          maxBindGroups: 4,
          maxBindingsPerBindGroup: 1000,
          maxVertexAttributes: 16,
          maxVertexBuffers: 8,
          maxColorAttachments: 8,
          maxBufferSize: 2147483648,
          maxUniformBufferBindingSize: 65536,
          maxStorageBufferBindingSize: 2147483644,
          minUniformBufferOffsetAlignment: 256,
          minStorageBufferOffsetAlignment: 256,
        },
        features: [
          "depth-clip-control", "depth32float-stencil8", "texture-compression-bc",
          "timestamp-query", "indirect-first-instance", "shader-f16",
          "rg11b10ufloat-renderable", "float32-filterable",
        ],
      },
    },
    audio: { sampleRate: 48000, baseLatency: 0.01, outputLatency: 0.02 },
    fonts: settings.fonts ?? WINDOWS_FONTS,
    ...(settings.speechVoices ? { speech: { voices: settings.speechVoices } } : {}),
    locale: { timezone: profile.timezone || "Asia/Shanghai", locale },
    noise: {
      ...(settings.canvasNoise === false ? {} : { canvasSeed: subSeed(profile.fingerprintSeed, "canvas") }),
      ...(settings.audioNoise === false ? {} : { audioSeed: subSeed(profile.fingerprintSeed, "audio") }),
      ...(settings.clientRectsNoise === false ? {} : { clientRectsSeed: subSeed(profile.fingerprintSeed, "clientRects") }),
    },
    ...(settings.mediaDevices ? { mediaDevices: settings.mediaDevices } : {}),
    ...(settings.geolocation ? { geolocation: settings.geolocation } : {}),
    permissions: { notifications: "prompt", geolocation: settings.geolocationPermission ?? "prompt" },
    engine: { jsHeapSizeLimit: 4294705152 },
    automation: { hideTraces: true },
    webrtc: {
      ipHandlingPolicy: settings.webrtcPolicy
        ?? (profile.proxy ? "disable_non_proxied_udp" : "default"),
    },
    battery: { charging: true, level: 1, chargingTime: 0, dischargingTime: -1 },
  };
}

/** Map the stored IDFRI persona to IDFRI Browser's native switches. */
export function deriveChromiumFingerprintArgs(
  profile: Profile,
  hostPlatform: NodeJS.Platform = process.platform,
): string[] {
  const config = deriveIdfriFingerprintConfig(profile);
  return [
    `--fingerprint=${profile.fingerprintSeed}`,
    hostPlatform === "win32" ? "--idfri-fp-stdin" : "--fury-fp-fd=0",
    `--user-agent=${config.navigator.userAgent}`,
    "--fingerprint-platform=windows",
    `--fingerprint-platform-version=${config.clientHints.platformVersion}`,
    "--fingerprint-brand=chrome",
    `--fingerprint-brand-version=${CHROMIUM_VERSION}`,
    `--fingerprint-gpu-vendor=${config.gpu.webglParams.UNMASKED_VENDOR_WEBGL}`,
    `--fingerprint-gpu-renderer=${config.gpu.webglParams.UNMASKED_RENDERER_WEBGL}`,
    `--fingerprint-hardware-concurrency=${config.navigator.hardwareConcurrency}`,
    `--fingerprint-device-memory=${config.navigator.deviceMemory}`,
    `--fingerprint-screen-width=${config.screen.width}`,
    `--fingerprint-screen-height=${config.screen.height}`,
    `--fingerprint-avail-width=${config.screen.availWidth}`,
    `--fingerprint-avail-height=${config.screen.availHeight}`,
    `--fingerprint-color-depth=${config.screen.colorDepth}`,
    `--fingerprint-device-pixel-ratio=${config.screen.devicePixelRatio}`,
    `--fingerprint-max-touch-points=${config.navigator.maxTouchPoints}`,
    `--timezone=${config.locale.timezone}`,
    `--accept-lang=${config.navigator.languages.join(",")}`,
    `--lang=${config.locale.locale}`,
    `--force-webrtc-ip-handling-policy=${config.webrtc.ipHandlingPolicy}`,
    `--fingerprint-tls-profile=chrome-${CHROMIUM_MAJOR}`,
    ...(profile.fingerprint?.webgpuMode === "disabled" ? ["--disable-features=WebGPU"] : []),
    ...(profile.fingerprint?.hardwareAcceleration === false ? ["--disable-gpu"] : []),
  ];
}

/** Render a ProxySpec as a Chromium `--proxy-server` value with inline credentials. */
export function proxyServerFlag(profile: Profile): string | null {
  const p = profile.proxy;
  if (!p) return null;
  return `--proxy-server=${proxyUrl(p)}`;
}

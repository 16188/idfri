/**
 * Build a brand-new profile from scratch (the "New Profile" flow).
 *
 * Unlike AdsPower's multi-tab fingerprint form, the operator does NOT configure
 * the fingerprint by hand: a fresh unique id yields a unique deterministic seed,
 * and CloakBrowser derives a coherent, unique fingerprint + UA from that seed at
 * launch (forcing a separate UA would risk UA/UA-CH desync). The operator only
 * supplies name / folder / proxy / (optional) screen; timezone is resolved from
 * the proxy's geoip by the caller. Chromium receives a deterministic launch seed;
 * Firefox receives a complete persisted Camoufox config.
 */

import type { CookieRecord, Profile, ProfileEngine, ProfileFingerprintSettings, ProxySpec } from "./types.ts";
import { createFirefoxProfileConfig } from "./firefox-config.ts";
import { deterministicSeed, hostPlatformOs, parseProfileFingerprintSettings } from "./fingerprint.ts";
import { applyProfileLocale, parseBrowserLocale, parseIanaTimezone } from "./geoip.ts";
import { normalizeProxySpec } from "./proxy.ts";
import { parseProfileNote, parseStartupUrl, parseStrictCustomNo, parseStrictResolution } from "./parse.ts";

export interface NewProfileInput {
  /** Browser identity engine. Defaults to Chromium for compatibility. */
  engine?: ProfileEngine;
  name?: string;
  group?: string;
  /** Account platform: "x.com", "telegram.org", or "" (none). */
  platform?: string;
  startupUrl?: string;
  note?: string;
  tags?: string | string[];
  cookies?: CookieRecord[];
  username?: string;
  password?: string;
  email?: string;
  emailPassword?: string;
  twofa?: string;
  proxy?: { type?: string; host?: string; port?: string; user?: string; pass?: string } | null;
  /** "1920x1080" / "1920*1080"; empty → a random realistic resolution. */
  screen?: string;
  /** Operator-chosen serial shown in the roster and the browser window title. */
  customNo?: string;
  /** Manual IANA timezone. Empty leaves automatic proxy synchronization enabled. */
  timezone?: string;
  /** Manual BCP 47 locale/language controls shared by Chromium and Firefox. */
  locale?: string;
  languages?: string[];
  fingerprint?: ProfileFingerprintSettings;
}

// Realistic desktop resolutions, so each created profile gets a varied screen.
const SCREENS: Array<[number, number]> = [
  [1920, 1080],
  [1536, 864],
  [1366, 768],
  [1440, 900],
  [1600, 900],
  [2560, 1440],
];

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join(""); // 8 base36 chars, AdsPower-ish
}

/** A unique profile id, collision-checked against `exists`. */
export function generateId(exists: (id: string) => boolean): string {
  for (let i = 0; i < 100; i++) {
    const id = randomId();
    if (!exists(id)) return id;
  }
  throw new Error("could not generate a unique profile id");
}

export function buildNewProfile(input: NewProfileInput, exists: (id: string) => boolean): Profile {
  const id = generateId(exists);

  const proxy: ProxySpec | null = normalizeProxySpec(input.proxy);

  const screen = (input.screen || "").trim();
  const selected = screen
    ? parseStrictResolution(screen)
    : (() => {
      const [width, height] = SCREENS[Math.floor(Math.random() * SCREENS.length)]!;
      return { width, height };
    })();
  const engine = input.engine === undefined ? "chromium" : input.engine;
  if (engine !== "chromium" && engine !== "firefox") throw new Error("unsupported profile engine");
  const fingerprint = parseProfileFingerprintSettings(input.fingerprint);
  if (engine === "firefox" && fingerprint) throw new Error("Firefox 使用独立的持久指纹配置");
  const firefox = engine === "firefox"
    ? createFirefoxProfileConfig(selected.width, selected.height)
    : undefined;
  const firefoxUa = firefox?.config["navigator.userAgent"];
  const firefoxScreenWidth = firefox?.config["screen.width"];
  const firefoxScreenHeight = firefox?.config["screen.height"];
  const firefoxTimezone = firefox?.config.timezone;

  const profile: Profile = {
    id,
    engine,
    ...(firefox ? { firefox } : {}),
    accId: "",
    name: (input.name || "").trim() || id, // AdsPower auto-names blank profiles after the id
    group: (input.group || "").trim(),
    platform: (input.platform || "").trim(),
    startupUrl: parseStartupUrl(input.startupUrl),
    note: parseProfileNote(input.note),
    tags: (Array.isArray(input.tags) ? input.tags : String(input.tags ?? "").split(","))
      .map((tag) => tag.trim()).filter(Boolean),
    username: (input.username || "").trim(),
    password: input.password || "",
    email: (input.email || "").trim(),
    emailPassword: input.emailPassword || "",
    twofa: (input.twofa || "").trim(),
    proxy,
    customNo: parseStrictCustomNo(input.customNo),
    ua: typeof firefoxUa === "string" ? firefoxUa : "", // Firefox's UA is generated with its persisted Camoufox config
    // ...but the platform must be pinned, or a blank UA means no
    // --fingerprint-platform flag and the browser inherits whatever host it
    // happens to run on — a silent identity change on a move between boxes.
    platformOs: engine === "firefox" ? "windows" : hostPlatformOs(),
    ...(fingerprint ? { fingerprint } : {}),
    timezone: input.timezone === undefined
      ? (typeof firefoxTimezone === "string" ? firefoxTimezone : "")
      : parseIanaTimezone(input.timezone),
    screenWidth: typeof firefoxScreenWidth === "number" ? firefoxScreenWidth : selected.width,
    screenHeight: typeof firefoxScreenHeight === "number" ? firefoxScreenHeight : selected.height,
    fingerprintSeed: deterministicSeed(id),
    cookies: input.cookies ?? [],
    seeded: false,
  };
  const locale = parseBrowserLocale(input.locale, input.languages);
  if (locale) applyProfileLocale(profile, locale);
  if (profile.firefox && profile.timezone) {
    profile.firefox = { ...profile.firefox, config: { ...profile.firefox.config, timezone: profile.timezone } };
  }
  return profile;
}

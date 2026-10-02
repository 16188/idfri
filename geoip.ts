/** Best-effort proxy timezone/locale enrichment and shared SOCKS5 tunneling. */

import { connect as netConnect, type Socket } from "node:net";
import type { FirefoxProfileConfig, ProfileFingerprintSettings, ProxySpec } from "./types.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<{ json(): Promise<any> }>;

export interface BrowserLocale {
  locale: string;
  languages: string[];
}

export interface ProxyLocation {
  timezone: string;
  countryCode?: string;
  locale?: string;
  languages?: string[];
}

type LocalizedProfile = {
  proxy: { host: string } | null;
  timezone: string;
  engine?: string;
  fingerprint?: ProfileFingerprintSettings;
  firefox?: FirefoxProfileConfig;
};

/** Validate an operator-supplied IANA timezone while preserving an empty automatic value. */
export function parseIanaTimezone(value: unknown): string {
  const timezone = String(value ?? "").trim();
  if (!timezone) return "";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error("时区无效，请使用 IANA 时区名称，例如 Asia/Kolkata");
  }
  return timezone;
}

/** Normalize locale controls shared by Chromium and Camoufox. */
export function parseBrowserLocale(localeValue: unknown, languagesValue: unknown): BrowserLocale | null {
  const rawLanguages = Array.isArray(languagesValue)
    ? languagesValue.map(String)
    : String(languagesValue ?? "").split(",");
  const filtered = rawLanguages.map((value) => value.trim()).filter(Boolean);
  const rawLocale = String(localeValue ?? "").trim() || filtered[0] || "";
  if (!rawLocale && filtered.length === 0) return null;
  try {
    const parsed = new Intl.Locale(Intl.getCanonicalLocales(rawLocale)[0]!).maximize();
    const locale = Intl.getCanonicalLocales([
      [parsed.language, parsed.script && new Intl.Locale(rawLocale).script, parsed.region].filter(Boolean).join("-"),
    ])[0]!;
    const languages = Intl.getCanonicalLocales([locale, ...filtered]);
    return { locale, languages: [...new Set(languages)] };
  } catch {
    throw new Error("语言必须使用有效的 BCP 47 标签，例如 zh-CN");
  }
}

/** Pick the dominant browser language for a two-letter proxy country code. */
export function browserLocaleForCountry(countryCode: string): BrowserLocale | null {
  const region = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) return null;
  try {
    const language = new Intl.Locale(`und-${region}`).maximize().language;
    return parseBrowserLocale(`${language}-${region}`, [language]);
  } catch {
    return null;
  }
}

export function profileBrowserLocale(profile: LocalizedProfile): BrowserLocale | null {
  if (profile.engine === "firefox") {
    const config = profile.firefox?.config;
    const language = typeof config?.["locale:language"] === "string" ? config["locale:language"] : "";
    const region = typeof config?.["locale:region"] === "string" ? config["locale:region"] : "";
    const script = typeof config?.["locale:script"] === "string" ? config["locale:script"] : "";
    const all = typeof config?.["locale:all"] === "string" ? config["locale:all"] : "";
    return language && region
      ? parseBrowserLocale([language, script, region].filter(Boolean).join("-"), all || [language])
      : null;
  }
  return parseBrowserLocale(profile.fingerprint?.locale, profile.fingerprint?.languages);
}

/** Apply one coherent Intl / navigator.languages identity to either browser engine. */
export function applyProfileLocale(profile: LocalizedProfile, locale: BrowserLocale | null): void {
  if (profile.engine === "firefox") {
    if (!profile.firefox) throw new Error("Firefox 资料缺少已保存的配置");
    const config = { ...profile.firefox.config };
    for (const key of ["locale:language", "locale:region", "locale:script", "locale:all"]) delete config[key];
    if (locale) {
      const parsed = new Intl.Locale(locale.locale);
      config["locale:language"] = parsed.language;
      config["locale:region"] = parsed.region!;
      if (parsed.script) config["locale:script"] = parsed.script;
      if (locale.languages.length > 1) config["locale:all"] = locale.languages.join(", ");
    }
    profile.firefox = { ...profile.firefox, config };
    return;
  }
  const fingerprint = { ...profile.fingerprint };
  delete fingerprint.locale;
  delete fingerprint.languages;
  if (locale) Object.assign(fingerprint, locale);
  if (Object.keys(fingerprint).length) profile.fingerprint = fingerprint;
  else delete profile.fingerprint;
}

function readExactly(socket: Socket, length: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onClose);
      socket.off("close", onClose);
      socket.pause();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    // A proxy that rejects the handshake by simply closing the connection (no
    // SOCKS error reply, no socket error) would otherwise leave this read
    // pending until the full timeout. Fail fast on end/close instead.
    const onClose = () => {
      cleanup();
      reject(new Error("SOCKS5 proxy closed the connection before the expected response"));
    };
    const onData = (raw: Buffer | Uint8Array) => {
      const chunk = Buffer.from(raw);
      const needed = length - received;
      if (chunk.length <= needed) {
        chunks.push(chunk);
        received += chunk.length;
      } else {
        chunks.push(chunk.subarray(0, needed));
        received += needed;
        socket.pause();
        socket.unshift(chunk.subarray(needed));
      }
      if (received === length) {
        cleanup();
        resolve(Buffer.concat(chunks, length));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("SOCKS5 proxy response timed out"));
    }, timeoutMs);
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onClose);
    socket.on("close", onClose);
    socket.resume();
  });
}

/** Open an RFC 1928/1929 TCP tunnel, keeping DNS resolution at the proxy. */
export async function openSocks5Tunnel(
  proxy: ProxySpec,
  host: string,
  port: number,
  timeoutMs: number,
  onSocket?: (socket: Socket) => void,
): Promise<Socket> {
  const socket = netConnect({ host: proxy.host, port: Number(proxy.port) });
  onSocket?.(socket);
  socket.setNoDelay(true);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SOCKS5 proxy connection timed out")), timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });

    const wantsAuth = !!proxy.user;
    // Credentials are an identity boundary: never advertise NO AUTH alongside
    // username/password, because a proxy selecting it would silently downgrade
    // an authenticated (often geo-targeted) session.
    socket.write(Buffer.from(wantsAuth ? [5, 1, 2] : [5, 1, 0]));
    const greeting = await readExactly(socket, 2, timeoutMs);
    if (greeting[0] !== 5 || greeting[1] === 0xff) throw new Error("SOCKS5 proxy rejected all authentication methods");
    if (wantsAuth) {
      if (greeting[1] !== 2) {
        throw new Error(`SOCKS5 proxy refused required username/password authentication (selected ${greeting[1]})`);
      }
      const user = Buffer.from(proxy.user, "utf8");
      const pass = Buffer.from(proxy.pass, "utf8");
      if (!user.length || user.length > 255 || pass.length > 255) throw new Error("invalid SOCKS5 username/password length");
      socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
      const auth = await readExactly(socket, 2, timeoutMs);
      if (auth[0] !== 1 || auth[1] !== 0) throw new Error("SOCKS5 proxy authentication failed");
    } else if (greeting[1] !== 0) {
      throw new Error(`SOCKS5 proxy selected unsupported authentication method ${greeting[1]}`);
    }

    const domain = Buffer.from(host, "ascii");
    if (!domain.length || domain.length > 255) throw new Error("invalid SOCKS5 destination hostname");
    socket.write(Buffer.concat([
      Buffer.from([5, 1, 0, 3, domain.length]),
      domain,
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    ]));
    const reply = await readExactly(socket, 4, timeoutMs);
    if (reply[0] !== 5 || reply[1] !== 0) throw new Error(`SOCKS5 CONNECT failed with status ${reply[1]}`);
    const addressLength = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3
      ? (await readExactly(socket, 1, timeoutMs))[0]!
      : -1;
    if (addressLength < 0) throw new Error(`SOCKS5 CONNECT returned unknown address type ${reply[3]}`);
    await readExactly(socket, addressLength + 2, timeoutMs);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** Map of proxy exit IP → timezone and browser locale for resolved locations. */
export async function lookupProxyLocations(
  queries: string[],
  fetchFn: FetchLike = (url, init) => fetch(url, init),
): Promise<Map<string, ProxyLocation>> {
  const out = new Map<string, ProxyLocation>();
  const unique = [...new Set(queries.filter((query) => query && query.trim()))];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    try {
      const res = await fetchFn("http://ip-api.com/batch?fields=query,timezone,countryCode,status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chunk.map((q) => ({ query: q }))),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as Array<{
        query?: string;
        timezone?: string;
        countryCode?: string;
        status?: string;
      }>;
      for (const row of Array.isArray(data) ? data : []) {
        if (row.status !== "success" || !row.query || !row.timezone) continue;
        const locale = row.countryCode ? browserLocaleForCountry(row.countryCode) : null;
        out.set(row.query, {
          ...(locale ?? {}),
          timezone: row.timezone,
          ...(row.countryCode ? { countryCode: row.countryCode.toUpperCase() } : {}),
        });
      }
    } catch {
      /* offline / blocked / rate-limited → leave this chunk unresolved */
    }
  }
  return out;
}

/** Compatibility wrapper for callers that only need timezone values. */
export async function lookupTimezones(hosts: string[], fetchFn?: FetchLike): Promise<Map<string, string>> {
  const locations = await lookupProxyLocations(hosts, fetchFn);
  return new Map([...locations].map(([query, location]) => [query, location.timezone]));
}

/**
 * Resolve and attach timezone and browser locale to each profile. Callers may
 * replace the default proxy-host query with the verified proxy exit IP.
 */
export async function attachTimezones<T extends LocalizedProfile>(
  profiles: T[],
  fetchFn?: FetchLike,
  options: {
    query?: (profile: T) => string | undefined;
    timezone?: boolean;
    locale?: boolean;
  } = {},
): Promise<{ profiles: T[]; resolved: number; localeResolved: number }> {
  const query = options.query ?? ((profile: T) => profile.proxy?.host);
  const queries = profiles.map(query).filter((value): value is string => !!value);
  if (queries.length === 0) return { profiles, resolved: 0, localeResolved: 0 };
  const locations = await lookupProxyLocations(queries, fetchFn);
  let resolved = 0, localeResolved = 0;
  for (const p of profiles) {
    const location = locations.get(query(p) ?? "");
    if (!location) continue;
    if (options.timezone !== false) {
      p.timezone = location.timezone;
      resolved++;
    }
    if (options.locale !== false && location.locale && location.languages) {
      applyProfileLocale(p, { locale: location.locale, languages: location.languages });
      localeResolved++;
    }
  }
  return { profiles, resolved, localeResolved };
}

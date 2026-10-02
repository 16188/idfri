import { test, expect } from "bun:test";
import {
  applyProfileLocale,
  attachTimezones,
  browserLocaleForCountry,
  lookupTimezones,
  profileBrowserLocale,
} from "./geoip.ts";

function fakeFetch(byIp: Record<string, { timezone: string; countryCode: string }>) {
  return async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Array<{ query: string }>;
    return {
      json: async () =>
        body.map(({ query }) =>
          byIp[query]
            ? { query, status: "success", ...byIp[query] }
            : { query, status: "fail" },
        ),
    };
  };
}

test("lookupTimezones maps resolved IPs and skips failures", async () => {
  const tz = await lookupTimezones(
    ["1.2.3.4", "5.6.7.8", "9.9.9.9"],
    fakeFetch({
      "1.2.3.4": { timezone: "America/New_York", countryCode: "US" },
      "5.6.7.8": { timezone: "Europe/London", countryCode: "GB" },
    }),
  );
  expect(tz.get("1.2.3.4")).toBe("America/New_York");
  expect(tz.get("5.6.7.8")).toBe("Europe/London");
  expect(tz.has("9.9.9.9")).toBe(false);
});

test("lookupTimezones returns empty when the lookup throws (offline)", async () => {
  const tz = await lookupTimezones(["1.2.3.4"], async () => {
    throw new Error("network down");
  });
  expect(tz.size).toBe(0);
});

test("country codes produce coherent locale and language lists", () => {
  expect(browserLocaleForCountry("US")).toEqual({ locale: "en-US", languages: ["en-US", "en"] });
  expect(browserLocaleForCountry("CN")).toEqual({ locale: "zh-CN", languages: ["zh-CN", "zh"] });
  expect(browserLocaleForCountry("FR")).toEqual({ locale: "fr-FR", languages: ["fr-FR", "fr"] });
  expect(browserLocaleForCountry("invalid")).toBeNull();
});

test("attachTimezones sets timezone and locale from each profile query", async () => {
  const profiles = [
    { proxy: { host: "1.2.3.4" }, timezone: "" },
    { proxy: { host: "5.6.7.8" }, timezone: "" },
    { proxy: null, timezone: "" },
  ];
  const { resolved, localeResolved } = await attachTimezones(profiles, fakeFetch({
    "1.2.3.4": { timezone: "America/New_York", countryCode: "US" },
    "5.6.7.8": { timezone: "Europe/London", countryCode: "GB" },
  }));
  expect(resolved).toBe(2);
  expect(localeResolved).toBe(2);
  expect(profiles[0]!.timezone).toBe("America/New_York");
  expect(profiles[1]!.timezone).toBe("Europe/London");
  expect(profiles[2]!.timezone).toBe(""); // no proxy → unchanged
  expect(profileBrowserLocale(profiles[0]!)).toEqual({ locale: "en-US", languages: ["en-US", "en"] });
});

test("Firefox locale writes Camoufox locale fields", () => {
  const profile = {
    engine: "firefox",
    proxy: null,
    timezone: "UTC",
    firefox: { version: 1 as const, runtimeVersion: "test", config: {} },
  };
  applyProfileLocale(profile, browserLocaleForCountry("TW"));
  expect(profile.firefox.config).toMatchObject({
    "locale:language": "zh",
    "locale:region": "TW",
    "locale:all": "zh-TW, zh",
  });
});

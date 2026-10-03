import { expect, test } from "bun:test";
import { fingerprintConsistency, fingerprintDifferences } from "./fingerprint-regression.ts";
import { buildNewProfile } from "../create.ts";
import { deriveIdfriFingerprintConfig } from "../fingerprint.ts";

test("fingerprint regression compares stable fields and configured identity", () => {
  const profile = buildNewProfile({ name: "regression", screen: "1920x1080" }, () => false);
  const expected = deriveIdfriFingerprintConfig(profile);
  const sample = {
    userAgent: expected.navigator.userAgent, uaDataPlatform: expected.clientHints.platform,
    platform: expected.navigator.platform, language: expected.navigator.languages[0], languages: expected.navigator.languages,
    timezone: expected.locale.timezone, hardwareConcurrency: expected.navigator.hardwareConcurrency,
    deviceMemory: expected.navigator.deviceMemory, webglVendor: expected.gpu.webglParams.UNMASKED_VENDOR_WEBGL,
    webglRenderer: expected.gpu.webglParams.UNMASKED_RENDERER_WEBGL,
    screen: { width: expected.screen.width, height: expected.screen.height, availWidth: expected.screen.availWidth, availHeight: expected.screen.availHeight, colorDepth: expected.screen.colorDepth, dpr: expected.screen.devicePixelRatio },
    canvasHash: "a", audioHash: "b",
  };
  expect(fingerprintConsistency(profile, sample)).toEqual([]);
  expect(fingerprintDifferences(sample, { ...sample, canvasHash: "changed" })).toEqual(["canvasHash"]);
});

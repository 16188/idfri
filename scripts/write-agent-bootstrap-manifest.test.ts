import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ALIASMODE_VERSION } from "../version.ts";
import { buildAgentBootstrapManifest } from "./write-agent-bootstrap-manifest.ts";

test("agent bootstrap manifest pins an exact installer URL and SHA-256", () => {
  const dir = mkdtempSync(join(tmpdir(), "aliasmode-agent-manifest-"));
  const name = `IDFRI_${ALIASMODE_VERSION}_x64-offline-setup.exe`;
  const releaseBase = `https://github.com/16188/idfri/releases/download/v${ALIASMODE_VERSION}`;
  try {
    const installer = join(dir, name);
    writeFileSync(installer, "installer");
    expect(buildAgentBootstrapManifest({
      installer,
      releaseBase,
    })).toEqual({
      schema: 1,
      version: ALIASMODE_VERSION,
      wingetId: "IDFRI.IDFRI",
      installer: {
        name,
        url: `${releaseBase}/${name}`,
        sha256: createHash("sha256").update("installer").digest("hex"),
        size: 9,
      },
    });
    expect(() => buildAgentBootstrapManifest({
      installer,
      releaseBase: "https://github.com/16188/idfri/releases/latest",
    })).toThrow("exact IDFRI GitHub Release URL");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent bootstrap installer trusts only IDFRI releases", () => {
  const script = readFileSync(join(import.meta.dir, "install-agent.ps1"), "utf8");
  expect(script).toContain("--id IDFRI.IDFRI");
  expect(script).toContain("^https://github\\.com/16188/idfri/releases/download/");
  expect(script).not.toContain("github\\.com/aliasmode/aliasmode/releases/download/");
});

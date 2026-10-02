import { expect, test } from "bun:test";
import {
  describeDesktopUpdateResult,
  parseDesktopUpdateResult,
} from "./desktop-update-result.ts";

test("parses only safe durable desktop update results", () => {
  expect(parseDesktopUpdateResult(null)).toBeNull();
  expect(parseDesktopUpdateResult({
    state: "succeeded",
    fromVersion: "0.1.0-beta.47",
    version: "0.1.0-beta.48",
    expectedRoot: "C:\\private\\install",
  })).toEqual({
    state: "succeeded",
    fromVersion: "0.1.0-beta.47",
    version: "0.1.0-beta.48",
  });
  expect(parseDesktopUpdateResult({
    state: "installedRelaunchUnconfirmed",
    version: "0.1.0-beta.48",
  })).toEqual({
    state: "installedRelaunchUnconfirmed",
    version: "0.1.0-beta.48",
  });
  expect(parseDesktopUpdateResult({
    state: "failedOrInterrupted",
    fromVersion: "0.1.0-beta.47",
    expectedVersion: "0.1.0-beta.48",
    reason: "browserCleanup",
  })).toEqual({
    state: "failedOrInterrupted",
    fromVersion: "0.1.0-beta.47",
    expectedVersion: "0.1.0-beta.48",
    reason: "browserCleanup",
  });
});

test("rejects malformed or unknown durable update results", () => {
  for (const value of [
    undefined,
    {},
    { state: "succeeded", version: "0.1.0-beta.48" },
    { state: "installedRelaunchUnconfirmed", version: "" },
    {
      state: "failedOrInterrupted",
      fromVersion: "0.1.0-beta.47",
      expectedVersion: "0.1.0-beta.48",
      reason: "privateDiagnostic",
    },
  ]) {
    expect(() => parseDesktopUpdateResult(value)).toThrow("IDFRI 返回了无效的更新结果。");
  }
});

test("describes confirmed, unconfirmed, and failed updates without private diagnostics", () => {
  expect(describeDesktopUpdateResult({
    state: "succeeded",
    fromVersion: "0.1.0-beta.47",
    version: "0.1.0-beta.48",
  })).toEqual({
    tone: "success",
    title: "IDFRI 0.1.0-beta.48 已安装。",
    detail: "已从 0.1.0-beta.47 更新，并在重启后验证安装。",
  });
  expect(describeDesktopUpdateResult({
    state: "installedRelaunchUnconfirmed",
    version: "0.1.0-beta.48",
  }).detail).toContain("Windows“开始”菜单");
  expect(describeDesktopUpdateResult({
    state: "failedOrInterrupted",
    fromVersion: "0.1.0-beta.47",
    expectedVersion: "0.1.0-beta.48",
    reason: "installationUnconfirmed",
  }).detail).toContain("完整离线安装包");
});

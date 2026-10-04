import { expect, test } from "bun:test";
import {
  LINUX_CHROMIUM_ARCHIVE_NAME,
  LINUX_CHROMIUM_ARCHIVE_SHA256,
  LINUX_CHROMIUM_ARCHIVE_URL,
  LINUX_CHROMIUM_EXECUTABLE_SHA256,
  LINUX_CHROMIUM_RUNTIME_VERSION,
  LINUX_CHROMIUM_VERSION,
} from "./prepare-linux-bundle.ts";

test("Linux 桌面包固定使用 IDFRI Browser 153 指纹内核", () => {
  expect(LINUX_CHROMIUM_VERSION).toBe("153.0.8010.52-1.idfri3");
  expect(LINUX_CHROMIUM_RUNTIME_VERSION).toBe("idfri-browser@153.0.8010.52-1.idfri3");
  expect(LINUX_CHROMIUM_ARCHIVE_NAME).toBe("idfri-browser_153.0.8010.52-1.idfri3_linux_x64.tar.xz");
  expect(LINUX_CHROMIUM_ARCHIVE_URL).toBe(
    "https://github.com/16188/idfri-browser/releases/download/browser-v153.0.8010.52-idfri.3/idfri-browser_153.0.8010.52-1.idfri3_linux_x64.tar.xz",
  );
  expect(LINUX_CHROMIUM_ARCHIVE_SHA256).toBe("fac4b625e3b43d46167a62e80da72c0051455ae337fca070cd09b645e051439f");
  expect(LINUX_CHROMIUM_EXECUTABLE_SHA256).toBe("2ad8f62b49da3d8e20ee005df9de8e6b203a83ad15ce2534103eae59acbe1c8f");
});

import { chromium } from "playwright-core";

const MAX_TEXT = 10_000;
const browsers = [];
let stopped = false;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function lines() {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of process.stdin) {
        buffer += chunk;
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (line.trim()) yield JSON.parse(line);
        }
      }
    },
  };
}

function validAction(value) {
  if (!value || typeof value !== "object") return false;
  if (["click", "fill", "press"].includes(value.type) && (typeof value.selector !== "string" || !value.selector || value.selector.length > 1000)) return false;
  if (value.type === "fill" && (typeof value.value !== "string" || value.value.length > MAX_TEXT)) return false;
  if (value.type === "press" && value.key !== "Enter") return false;
  if (value.type === "scroll" && (![value.x, value.y].every(Number.isFinite) || Math.abs(value.x) > 1_000_000 || Math.abs(value.y) > 1_000_000)) return false;
  if (value.type === "goto") {
    try { const url = new URL(value.url); return ["http:", "https:"].includes(url.protocol) && url.href.length <= 2048; } catch { return false; }
  }
  return ["click", "fill", "press", "scroll", "goto"].includes(value.type);
}

async function main(config) {
  if (!Array.isArray(config?.profiles) || config.profiles.length < 2) throw new Error("同步器配置无效");
  for (const profile of config.profiles) {
    if (typeof profile?.endpoint !== "string" || !profile.endpoint.startsWith("ws")) throw new Error("浏览器连接无效");
    const browser = await chromium.connectOverCDP(profile.endpoint, { timeout: 15_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("浏览器上下文不可用");
    browsers.push({ browser, context });
  }
  const leader = browsers[0];
  const followers = browsers.slice(1);

  const targetPage = async (follower, sourcePage) => {
    const index = Math.max(0, leader.context.pages().indexOf(sourcePage));
    return follower.context.pages()[index] ?? await follower.context.newPage();
  };
  const broadcast = async (sourcePage, action) => {
    if (stopped || !validAction(action)) return;
    let failures = 0;
    await Promise.all(followers.map(async (follower) => {
      try {
        const page = await targetPage(follower, sourcePage);
        if (action.type === "click") await page.locator(action.selector).first().click({ timeout: 5_000 });
        else if (action.type === "fill") await page.locator(action.selector).first().fill(action.value, { timeout: 5_000 });
        else if (action.type === "press") await page.locator(action.selector).first().press(action.key, { timeout: 5_000 });
        else if (action.type === "scroll") await page.evaluate(({ x, y }) => window.scrollTo(x, y), action);
        else if (action.type === "goto") await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch { failures++; }
    }));
    send({ type: "event", count: 1, failures });
  };
  await leader.context.exposeBinding("__idfriWindowSync", async ({ page, frame }, action) => {
    if (frame !== page.mainFrame()) return;
    await broadcast(page, action);
  });
  await leader.context.addInitScript(() => {
    if (globalThis.__idfriWindowSyncInstalled) return;
    globalThis.__idfriWindowSyncInstalled = true;
    const selector = (element) => {
      if (!(element instanceof Element)) return "";
      if (element.id) return `#${CSS.escape(element.id)}`;
      for (const key of ["data-testid", "data-test", "name"]) {
        const value = element.getAttribute(key);
        if (value) return `[${key}="${CSS.escape(value)}"]`;
      }
      const parts = [];
      for (let node = element; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {
        const siblings = node.parentElement ? [...node.parentElement.children].filter((item) => item.tagName === node.tagName) : [];
        parts.unshift(`${node.tagName.toLowerCase()}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ""}`);
      }
      return parts.join(" > ");
    };
    const sendAction = (action) => globalThis.__idfriWindowSync(action).catch(() => {});
    document.addEventListener("click", (event) => { const value = selector(event.target); if (value) sendAction({ type: "click", selector: value }); }, true);
    document.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) || target.type === "password") return;
      const value = selector(target); if (value) sendAction({ type: "fill", selector: value, value: target.value });
    }, true);
    document.addEventListener("keydown", (event) => { if (event.key === "Enter") { const value = selector(event.target); if (value) sendAction({ type: "press", selector: value, key: "Enter" }); } }, true);
    let queued = false;
    addEventListener("scroll", () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; sendAction({ type: "scroll", x: scrollX, y: scrollY }); }); } }, { passive: true });
  });
  const attach = (page) => page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && ["http:", "https:"].includes(new URL(frame.url()).protocol)) void broadcast(page, { type: "goto", url: frame.url() });
  });
  leader.context.pages().forEach(attach);
  leader.context.on("page", attach);
  send({ type: "ready" });
}

try {
  const iterator = lines()[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new Error("同步器配置缺失");
  await main(first.value);
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) if (next.value?.type === "stop") break;
} catch (error) {
  send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  stopped = true;
  await Promise.all(browsers.map(({ browser }) => browser.close().catch(() => {})));
}

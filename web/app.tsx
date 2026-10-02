import { Channel } from "@tauri-apps/api/core";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProfileFingerprintSettings } from "../types.ts";
import "./styles.css";
import "./proxies.css";
import { ProxiesPage } from "./proxies.tsx";
import { TrashPage } from "./trash.tsx";
import { parsePastedProxy } from "./proxy-input.ts";
import { ScriptRunPanel, ScriptsPage } from "./scripts.tsx";
import { THEME_KEY, readThemeChoice, themeCookie, type ThemeChoice } from "./theme.ts";
import {
  describeDesktopUpdateResult,
  parseDesktopUpdateResult,
  type DesktopUpdateResult,
} from "./desktop-update-result.ts";
import {
  type UiProfile,
  type HealthSource,
  type DiagnoseReport,
  type EditProfile,
  type Extension,
  type GroupExtensionDefaults,
  type AppModeConfig,
  type CloudAuthState,
  CloudSessionRestoreError,
  type CloudDiagnosticEvent,
  type CloudTeamState,
  acceptCloudInvitation,
  acceptCloudLegal,
  createCloudConnector,
  fetchCloudConnector,
  revokeCloudConnector,
  cloudSessionContextReady,
  cloudWorkspaceReady,
  fetchAppMode,
  fetchCloudAuth,
  fetchCloudEvents,
  fetchCloudTeam,
  cloudWorkspaceAction,
  forgetCloudSession,
  signInCloud,
  signOutCloud,
  signUpCloud,
  restoreCloudSession,
  resendCloudSignUp,
  selectAppMode,
  fetchProfiles,
  fetchHealth,
  fetchLogs,
  fetchDiagnose,
  checkProxy,
  ProxyCheckError,
  type ProxyCheckInput,
  type ProxyCheckResult,
  addProfileCookie,
  openProfile,
  closeProfile,
  raiseProfile,
  restoreParkedSession,
  fetchExtensions,
  installWebStoreExtension,
  uploadExtensions,
  removeExtension,
  assignExtensionBulk,
  fetchGroupExtensionDefaults,
  setGroupExtensionDefaults,
  uploadExports,
  moveProfiles,
  deleteProfiles,
  createProfile,
  fetchProfileEdit,
  updateProfile,
  refreshProfileTimezone,
  convertMobileProfile,
  exportProfiles,
  type ExportFormat,
  type ExportProgress,
  updateFromFile,
  createGroup,
  renameGroup,
  deleteGroup,
  fetchTotp,
} from "./api.ts";

/** Run async tasks with bounded concurrency (so "Open 50" isn't 50 at once). */
async function runPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]!); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

const CSV_TEMPLATE =
  "name,group,platform,proxy,username,password,email,emailpassword,twofa\n" +
  "alice_warmup,Warmup,x.com,1.2.3.4:8080:proxyuser:proxypass,alice_user,SuperSecret1,alice@example.com,MailboxSecret1,JBSWY3DPEHPK3PXP\n" +
  "bob_eu,EU,telegram.org,,bob_user,SuperSecret2,bob@example.com,MailboxSecret2,\n" +
  "carol_noproxy,Warmup,,,carol_user,SuperSecret3,carol@example.com,MailboxSecret3,KRSXG5CTMVRXEZLU\n";

const TXT_EXAMPLE =
  "id=k1example01\ngroup=Warmup\nplatform=x.com\nname=alice_warmup\nusername=alice@example.com\n" +
  "password=SuperSecret1\nemail=mailbox@example.com\nemailpassword=MailboxSecret1\nfakey=JBSWY3DPEHPK3PXP\ncookie=[]\nproxytype=http\n" +
  "proxy=1.2.3.4:8080:proxyuser:proxypass\nua=\nresolution=1920*1080\n******************\n";

// Example sheet for the Update-from-file flow. The FIRST column (id) is what
// matches each row to an existing profile — keep it. Edit the other columns;
// delete any column you don't want to change.
const UPDATE_TEMPLATE_CSV =
  "id,name,group,platform,proxy,proxytype,username,password,twofa,resolution,custom_no\n" +
  "<paste-the-profile-id-here>,New name,Warmup,x.com,1.2.3.4:8080:user:pass,http,new@example.com,NewPass1,JBSWY3DPEHPK3PXP,1920*1080,123456\n";

/**
 * How many profiles a pasted AdsPower export would create. Every record starts
 * with its own `id=` line, so counting those is exact rather than a guess at
 * blocks — and it gives the operator a number to sanity-check before importing.
 */
function countPastedRecords(text: string): number {
  return (text.match(/^id=/gm) ?? []).length;
}

function sameExtensionSelection(left: string[], right: string[]): boolean {
  const leftIds = new Set(left);
  const rightIds = new Set(right);
  return leftIds.size === rightIds.size && [...leftIds].every((id) => rightIds.has(id));
}

function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

const REFRESH_MS = 3000;
const PROFILE_PAGE_SIZE = 50;
const PAGE_SIZES = [25, 50, 100, 200];

const PAGE_TITLES: Record<"profiles" | "scripts" | "settings" | "extensions" | "proxies" | "trash", string> = {
  profiles: "资料",
  scripts: "脚本",
  settings: "设置",
  extensions: "扩展",
  proxies: "代理",
  trash: "回收站",
};

const SETTINGS_TABS = [
  { key: "account", label: "账户" },
  { key: "team", label: "工作区" },
  { key: "advanced", label: "高级" },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]["key"];

/** Mirrors MAX_CUSTOM_NO_LENGTH in parse.ts — the server rejects anything longer. */
const MAX_CUSTOM_NO = 12;

/**
 * Roster columns. `width` is the single source of truth: each column is laid out
 * at exactly that width and the table's min-width is their sum, so a column can
 * never be squeezed below a readable size — the roster scrolls sideways instead.
 * Only the checkbox column is fixed; everything else can be hidden.
 */
const COLUMNS = [
  { key: "no", label: "编号", sort: true, width: 96 },
  { key: "name", label: "名称", sort: true, width: 220 },
  { key: "group", label: "分组", sort: true, width: 120 },
  { key: "platform", label: "平台", sort: true, width: 128 },
  { key: "tags", label: "标签", sort: false, width: 140 },
  { key: "proxy", label: "代理", sort: true, width: 160 },
  /* Every row action lives here, beside Open/Close — no hover reveal. */
  { key: "action", label: "操作", sort: false, width: 230 },
] as const;

/** Width of the always-present select-all checkbox column. */
const CHECKBOX_COLUMN_WIDTH = 44;

type ColumnKey = (typeof COLUMNS)[number]["key"];
type SortKey = ColumnKey | "status";

const THEMES = [
  { key: "system", label: "跟随系统", icon: "laptop" },
  { key: "light", label: "浅色", icon: "sun" },
  { key: "dark", label: "深色", icon: "moon" },
] as const;

function readTheme(): ThemeChoice {
  let cookies = "";
  let stored: string | null = null;
  try { cookies = document.cookie; } catch {}
  try { stored = localStorage.getItem(THEME_KEY); } catch {}
  return readThemeChoice(cookies, stored);
}

const SIDEBAR_KEY = "aliasmode.shell.sidebarCollapsed";

/**
 * Below this width the sidebar always renders as the icon rail. Hiding it
 * entirely (the old breakpoint behavior) left a small window with no
 * navigation at all — this is a desktop app and the user sizes it freely.
 */
const RAIL_MEDIA = "(max-width: 760px)";

function readRailForced(): boolean {
  try { return window.matchMedia(RAIL_MEDIA).matches; } catch { return false; }
}
const HIDDEN_COLUMNS_KEY = "aliasmode.roster.hiddenColumns";
const PAGE_SIZE_KEY = "aliasmode.roster.pageSize";

/** Tags are off until an operator asks for them — most rosters do not use them. */
const DEFAULT_HIDDEN_COLUMNS: ColumnKey[] = ["tags"];

/** Roster layout preferences are a convenience: a hostile/empty store must not break the view. */
function readHiddenColumns(): Set<ColumnKey> {
  try {
    const stored = localStorage.getItem(HIDDEN_COLUMNS_KEY);
    if (stored === null) return new Set(DEFAULT_HIDDEN_COLUMNS);
    const raw = JSON.parse(stored);
    const known = new Set(COLUMNS.map((column) => column.key as string));
    return new Set((Array.isArray(raw) ? raw : []).filter((key) => known.has(key)) as ColumnKey[]);
  } catch { return new Set(DEFAULT_HIDDEN_COLUMNS); }
}

function readSidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_KEY) === "1"; } catch { return false; }
}

function readPageSize(): number {
  try {
    const stored = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return PAGE_SIZES.includes(stored) ? stored : PROFILE_PAGE_SIZE;
  } catch { return PROFILE_PAGE_SIZE; }
}

function writeSetting(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode / disabled storage */ }
}

const CLOUD_DIAGNOSTIC_LABELS: Record<CloudDiagnosticEvent["type"], string> = {
  open_started: "开始打开 Cloud 资料",
  cloud_registered: "Cloud 会话已注册",
  browser_started: "IDFRI Browser 已启动",
  browser_launch_preflight_failed: "浏览器资料准备失败",
  browser_launch_relay_setup_failed: "代理中继初始化失败",
  browser_launch_process_spawn_failed: "IDFRI Browser 进程无法启动",
  browser_launch_cdp_readiness_failed: "IDFRI Browser 调试连接尚未就绪",
  session_restore_started: "开始恢复会话",
  session_restore_completed: "会话恢复完成",
  session_restore_unclassified_failed: "会话恢复在分类前失败",
  session_restore_invalid_bundle_failed: "会话数据无效",
  session_restore_invalid_bundle_timeout: "会话数据校验超时",
  session_restore_connect_failed: "浏览器连接失败",
  session_restore_connect_timeout: "浏览器连接超时",
  session_restore_context_failed: "持久浏览器上下文不可用",
  session_restore_context_timeout: "持久浏览器上下文超时",
  session_restore_origin_storage_failed: "网站存储恢复失败",
  session_restore_origin_storage_timeout: "网站存储恢复超时",
  session_restore_cookie_clear_failed: "Cookie 清除失败",
  session_restore_cookie_clear_timeout: "Cookie 清除超时",
  session_restore_cookie_add_failed: "Cookie 恢复失败",
  session_restore_cookie_add_timeout: "Cookie 恢复超时",
  session_restore_navigation_failed: "启动页面导航失败",
  session_restore_navigation_timeout: "启动页面导航超时",
  session_restore_disconnect_failed: "浏览器连接清理失败",
  session_restore_disconnect_timeout: "浏览器连接清理超时",
  open_running: "Cloud 资料正在运行",
  open_failed: "Cloud 资料打开失败",
  close_started: "开始关闭 Cloud 资料",
  session_captured: "会话已捕获",
  browser_stopped: "IDFRI Browser 已停止",
  session_synced: "会话已同步",
  checkpoint_saved: "会话检查点已保存",
  checkpoint_unchanged: "会话检查点未变化",
  checkpoint_capture_failed: "会话检查点捕获失败",
  checkpoint_invalid: "会话检查点无效",
  manual_stop_detected: "检测到手动关闭浏览器",
  session_sync_pending: "会话正在等待同步",
  dirty_monitor_unavailable: "快速会话监控不可用",
  cloud_registration_released: "Cloud 会话注册已释放",
  cleanup_retained: "浏览器或恢复状态已保留",
  heartbeat_failed: "Cloud 心跳失败",
  heartbeat_terminal_conflict: "版本冲突导致 Cloud 租约结束",
  heartbeat_terminal_access_ended: "访问权限被撤销，Cloud 租约已结束",
  no_page_observed: "浏览器没有可见页面",
  no_page_close_requested: "页面消失后已请求关闭浏览器",
  browser_death_confirmed: "已确认浏览器进程退出",
  browser_teardown_unconfirmed: "无法确认浏览器已完全关闭",
  session_sync_conflict: "会话同步发生终止性冲突",
  access_ended: "Cloud 访问已结束",
  parked_session_restored: "已保存的会话已恢复到 Cloud",
};

function cloudDiagnosticFailed(type: CloudDiagnosticEvent["type"]): boolean {
  return type.includes("failed") || type.includes("timeout") || type === "checkpoint_invalid"
    || type === "session_sync_pending" || type === "session_sync_conflict"
    || type === "cleanup_retained" || type === "heartbeat_terminal_conflict"
    || type === "heartbeat_terminal_access_ended" || type === "no_page_close_requested"
    || type === "browser_teardown_unconfirmed" || type === "access_ended";
}

/**
 * Stroke-icon set (16px grid, 1.7 stroke) used everywhere a control needs a
 * glyph. Inline so the dashboard ships no icon font or sprite request, and one
 * `.icon` rule in styles.css controls size and color for all of them.
 */
const ICONS = {
  plus: <path d="M12 5v14M5 12h14" />,
  import: <><path d="M12 3v12" /><path d="M8 11l4 4 4-4" /><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" /></>,
  /* Pulling a file INTO the app. A bare download tray reads as "save to disk",
     which is the opposite of what the import control does. */
  fileImport: <><path d="M15 2H7a2 2 0 00-2 2v16a2 2 0 002 2h10a2 2 0 002-2V6z" /><path d="M14 2v4a2 2 0 002 2h3" /><path d="M12 18v-7" /><path d="M9 14l3-3 3 3" /></>,
  export: <><path d="M12 15V3" /><path d="M8 7l4-4 4 4" /><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  close: <path d="M18 6L6 18M6 6l12 12" />,
  refresh: <><path d="M20 11a8 8 0 10-2.3 5.7" /><path d="M20 4v7h-7" /></>,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  sort: <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />,
  sortUp: <path d="M7 14l5-5 5 5" />,
  sortDown: <path d="M7 10l5 5 5-5" />,
  profiles: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 9v11" /></>,
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  folders: <><path d="M8 17a2 2 0 01-2-2V5a2 2 0 012-2h2.88a2 2 0 011.41.59l.71.7A2 2 0 0014.41 5H18a2 2 0 012 2v8a2 2 0 01-2 2z" /><path d="M2 8v11a2 2 0 002 2h14" /></>,
  puzzle: <path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z" />,
  logs: <><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
  user: <><circle cx="12" cy="8" r="3.6" /><path d="M5 20c.6-4 3-6 7-6s6.4 2 7 6" /></>,
  settings: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>,
  columns: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></>,
  play: <path d="M7 4.5l12 7.5-12 7.5z" />,
  power: <><path d="M12 3v9" /><path d="M6.5 6.5a8 8 0 1011 0" /></>,
  trash: <><path d="M4 7h16M10 7V5a1 1 0 011-1h2a1 1 0 011 1v2" /><path d="M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12" /></>,
  edit: <><path d="M4 20h4L20 8a2.8 2.8 0 10-4-4L4 16z" /><path d="M14 6l4 4" /></>,
  move: <><path d="M4 20h13a3 3 0 003-3v-6a2 2 0 00-2-2h-7.5a2 2 0 01-1.6-.8L7.6 5.8A2 2 0 006 5H4a2 2 0 00-2 2v11a2 2 0 002 2z" /><path d="M9 14h6M13 11.5l2.5 2.5L13 16.5" /></>,
  raise: <><rect x="8" y="3" width="13" height="13" rx="2" /><path d="M16 16v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-9a2 2 0 012-2h3" /></>,
  key: <><circle cx="8" cy="12" r="4" /><path d="M12 12h9M18 12v3M15.5 12v2.5" /></>,
  cookie: <><circle cx="12" cy="12" r="9" /><circle cx="8.5" cy="10" r="1" /><circle cx="13.5" cy="15" r="1" /><circle cx="16" cy="9" r="1" /></>,
  more: <><circle cx="6" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18" cy="12" r="1.4" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16.2v.3" /></>,
  warning: <><path d="M10.3 4.2L2.8 17a2 2 0 001.7 3h15a2 2 0 001.7-3L13.7 4.2a2 2 0 00-3.4 0z" /><path d="M12 9.5v4M12 17v.3" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  activity: <path d="M3 12h4l3 8 4-16 3 8h4" />,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 118 0v3" /></>,
  cloud: <path d="M7.5 19a4.5 4.5 0 01-.4-9 6 6 0 0111.4 1.6A3.9 3.9 0 0117.5 19z" />,
  laptop: <><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M2 20h20" /></>,
  hash: <path d="M9 4L7 20M17 4l-2 16M4 9h16M3 15h16" />,
  window: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /></>,
  file: <><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 012-2h8" /></>,
  filter: <path d="M4 5h16l-6 7v6l-4 2v-8z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.4 9.1a2.7 2.7 0 015.3.7c0 1.8-2.7 2.2-2.7 3.7" /><path d="M12 16.8v.3" /></>,
} as const;

type IconName = keyof typeof ICONS;

/**
 * Official IDFRI project links.
 */
const PROJECT_LINKS = [
  {
    href: "https://github.com/16188/idfri",
    label: "GitHub",
    path: "M12 .3a12 12 0 00-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.9 1.2 1.9 1.2 1.1 1.9 2.9 1.3 3.6 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 016 0C17.4 5.4 18.4 5.7 18.4 5.7c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0012 .3z",
  },
] as const;

function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

/**
 * Close a popover on outside click or Escape. The returned ref goes on the
 * wrapper holding BOTH the trigger and the panel, so clicking the trigger again
 * toggles it instead of closing and immediately reopening.
 */
function useDismiss<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  const onClose = useRef(close);
  onClose.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose.current();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose.current(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return ref;
}

/**
 * Minimal IDFRI mark, inlined so it follows the active theme.
 */
function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className ? `alias-loop ${className}` : "alias-loop"} viewBox="0 0 512 512" aria-hidden="true">
      <path d="M128 80H384V432H128Z" stroke="currentColor" />
      <path className="loop-accent" d="M184 152H328M256 152V360M184 360H328" stroke="#2457D6" />
    </svg>
  );
}

/**
 * The number an operator sees for a profile: their custom NO. when set, else the
 * store serial, else the row's position. Mirrors profileDisplayNo in launcher.ts
 * so the roster, the browser window title and the identity bookmark agree.
 */
function displayNo(profile: UiProfile, fallbackIndex: number): { value: string; custom: boolean } {
  const custom = (profile.customNo ?? "").trim();
  if (custom) return { value: custom, custom: true };
  if (profile.serial != null) return { value: String(profile.serial), custom: false };
  return { value: String(fallbackIndex + 1), custom: false };
}

/**
 * Whether this profile's last measured fingerprint still matches the one its
 * import claimed. Renders nothing when there is no attestation to check
 * against — "unknown" must not look like "verified".
 */
function FingerprintBadge({ p }: { p: UiProfile }) {
  const v = p.fpVerdict;
  if (!v) return null;
  if (v.verdict === "match") {
    return (
      <span className="fpbadge ok" title={`指纹与导入记录一致${p.fpCapturedAt ? ` · 测量于 ${p.fpCapturedAt}` : ""}`}>
        verified
      </span>
    );
  }
  const detail = v.differences
    .map((d) => `${d.field}：${d.expected || "（无）"} → ${d.observed || "（无）"}`)
    .join("; ");
  return (
    <span className="fpbadge warn" title={`此浏览器与导入的指纹不再一致 · ${detail}`}>
      identity changed
    </span>
  );
}

function StatusDot({ running }: { running: boolean }) {
  return <span className={`dot ${running ? "on" : ""}`} title={running ? "运行中" : "已停止"} />;
}

function HealthSources({ sources }: { sources: HealthSource[] }) {
  if (sources.length === 0) return <div className="health-sources none">无自动化节点</div>;
  return (
    <div className="health-sources" aria-label="自动化节点状态">
      {sources.map((source) => (
        <span
          key={source.sourceId}
          className={`health-source${source.stale ? " stale" : ""}`}
          title={`上次快照：${new Date(source.lastSnapshotAt).toLocaleString()}`}
        >
          <Icon name="activity" className="sm" />
          {source.sourceId} · {source.stale ? "已过期" : "最新"} · {new Date(source.lastSnapshotAt).toLocaleTimeString()}
        </span>
      ))}
    </div>
  );
}

/**
 * Real brand marks for the platforms a profile can target. A letter in a colored
 * box reads as a placeholder; the actual logo is what makes a row scannable at a
 * glance. Paths are the official single-color marks on a 24x24 grid, filled (not
 * stroked) — see .brandmark in styles.css. Tile colors live in CSS as .pm-*.
 */
const PLATFORM_MARKS: Record<string, { key: string; path: string }> = {
  "x.com": {
    key: "x",
    path: "M18.9 1.153h3.682l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.153h7.594l5.243 6.932ZM17.61 20.644h2.04L6.486 3.24H4.298Z",
  },
  "telegram.org": {
    key: "telegram",
    path: "M23.91 3.79 20.3 20.84c-.25 1.21-.98 1.5-1.99.93l-5.49-4.05-2.65 2.55c-.3.3-.55.55-1.12.55l.4-5.63 10.24-9.25c.45-.4-.1-.62-.69-.22L6.44 13.09.2 11.14c-1.36-.42-1.38-1.36.28-2.01L22.17 1.8c1.13-.42 2.12.26 1.74 1.99Z",
  },
  "instagram.com": {
    key: "instagram",
    path: "M12 0C8.74 0 8.33.01 7.05.07 5.78.13 4.9.33 4.14.63a5.9 5.9 0 0 0-2.13 1.38A5.9 5.9 0 0 0 .63 4.14C.33 4.9.13 5.78.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.06 1.27.26 2.15.56 2.91a5.9 5.9 0 0 0 1.38 2.13 5.9 5.9 0 0 0 2.13 1.38c.76.3 1.64.5 2.91.56C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c1.27-.06 2.15-.26 2.91-.56a5.9 5.9 0 0 0 2.13-1.38 5.9 5.9 0 0 0 1.38-2.13c.3-.76.5-1.64.56-2.91.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.06-1.27-.26-2.15-.56-2.91a5.9 5.9 0 0 0-1.38-2.13A5.9 5.9 0 0 0 19.86.63c-.76-.3-1.64-.5-2.91-.56C15.67.01 15.26 0 12 0Zm0 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23-.06-1.27-.07-1.65-.07-4.85s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16Zm0 3.68a6.16 6.16 0 1 0 0 12.32 6.16 6.16 0 0 0 0-12.32ZM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm7.85-10.4a1.44 1.44 0 1 1-2.88 0 1.44 1.44 0 0 1 2.88 0Z",
  },
  "facebook.com": {
    key: "facebook",
    path: "M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.09 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.09 24 18.1 24 12.07Z",
  },
  "tiktok.com": {
    key: "tiktok",
    path: "M12.53.02C13.84 0 15.14.01 16.44 0c.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07Z",
  },
  "linkedin.com": {
    key: "linkedin",
    path: "M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13Zm1.78 13.02H3.56V9h3.56v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0Z",
  },
  "reddit.com": {
    key: "reddit",
    path: "M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0Zm6.07 6.53a1.4 1.4 0 0 1 1.4 1.4 1.4 1.4 0 0 1-.83 1.28c.02.15.03.3.03.45 0 2.87-3.44 5.2-7.67 5.2s-7.67-2.33-7.67-5.2c0-.16.01-.31.03-.46a1.4 1.4 0 1 1 1.58-2.28 7.6 7.6 0 0 1 4.1-1.31l.78-3.66a.34.34 0 0 1 .4-.26l2.6.55a1 1 0 1 1-.14.67l-2.24-.48-.7 3.3c1.5.06 2.9.5 4.05 1.2a1.4 1.4 0 0 1 1.28-.8ZM8.1 10.42a1.16 1.16 0 1 0 0 2.32 1.16 1.16 0 0 0 0-2.32Zm7.8 0a1.16 1.16 0 1 0 0 2.32 1.16 1.16 0 0 0 0-2.32Zm-7.6 4.9a.34.34 0 0 0-.24.58c.98.98 2.53 1.46 3.94 1.46s2.96-.48 3.94-1.46a.34.34 0 0 0-.48-.48c-.78.78-2.1 1.18-3.46 1.18s-2.68-.4-3.46-1.18a.34.34 0 0 0-.24-.1Z",
  },
};

const KNOWN_PLATFORMS: { value: string; label: string }[] = [
  { value: "", label: "（无）" },
  { value: "x.com", label: "Twitter / X" },
  { value: "instagram.com", label: "Instagram" },
  { value: "facebook.com", label: "Facebook" },
  { value: "tiktok.com", label: "TikTok" },
  { value: "linkedin.com", label: "LinkedIn" },
  { value: "reddit.com", label: "Reddit" },
  { value: "telegram.org", label: "Telegram" },
];

function PlatformPill({ platform }: { platform: string }) {
  if (!platform) return <span className="muted">—</span>;
  const known = KNOWN_PLATFORMS.find((candidate) => candidate.value === platform);
  const mark = PLATFORM_MARKS[platform];
  return (
    <span className="platform-pill" title={platform}>
      <span className={`glyph pm-${mark?.key ?? "other"}`}>
        {mark
          ? <svg className="brandmark" viewBox="0 0 24 24" aria-hidden="true"><path d={mark.path} /></svg>
          : platform.slice(0, 1).toUpperCase()}
      </span>
      {known?.label ?? platform}
    </span>
  );
}

/**
 * Group selector used in every dialog: a styled <select> of existing groups
 * plus "➕ 新建分组…", which flips to an inline text field so you can create a
 * group on the fly. Consistent with the other modal selects (no native datalist).
 */
function GroupPicker({ value, onChange, groups, allowCreate = true }: { value: string; onChange: (v: string) => void; groups: string[]; allowCreate?: boolean }) {
  const [creating, setCreating] = useState(false);
  if (creating) {
    return (
      <div className="grouppick">
        <input autoFocus placeholder="新分组名称" value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="btn gp-back tip" data-tip="选择已有分组" title="选择已有分组" onClick={() => { setCreating(false); onChange(""); }}><Icon name="chevronLeft" /></button>
      </div>
    );
  }
  return (
    <select
      value={groups.includes(value) ? value : ""}
      onChange={(e) => {
        if (e.target.value === "__new__") { setCreating(true); onChange(""); }
        else onChange(e.target.value);
      }}
    >
      <option value="">（未分组）</option>
      {groups.map((g) => <option key={g} value={g}>{g}</option>)}
      {allowCreate && <option value="__new__">➕ 新建分组…</option>}
    </select>
  );
}

function PlatformPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const known = KNOWN_PLATFORMS.some((p) => p.value === value);
  const [creating, setCreating] = useState(false);
  if (creating || (!!value && !known)) {
    return (
      <div className="grouppick">
        <input autoFocus placeholder="新平台（例如 linkedin.com）" value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="btn gp-back tip" data-tip="选择已知平台" title="选择已知平台" onClick={() => { setCreating(false); onChange(""); }}><Icon name="chevronLeft" /></button>
      </div>
    );
  }
  return (
    <select value={value} onChange={(e) => { if (e.target.value === "__new__") { setCreating(true); onChange(""); } else onChange(e.target.value); }}>
      {KNOWN_PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
      <option value="__new__">➕ 新建平台…</option>
    </select>
  );
}

async function copyPlainText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("复制失败");
}

function CopyField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyPlainText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="fld grow">
      <span>{label}</span>
      {/* Copy sits inside the field rather than beside it: a separate bordered
          button per credential turned the dialog into a grid of grey boxes. */}
      <div className="inputwrap">
        <input value={value} onChange={(event) => onChange(event.target.value)} />
        <button
          type="button"
          className={`inline-action tip${copied ? " ok" : ""}`}
          data-tip={copied ? "已复制" : `复制${label}`}
          aria-label={`复制${label}`}
          onClick={copy}
        >
          <Icon name={copied ? "check" : "copy"} className="sm" />
        </button>
      </div>
    </div>
  );
}

function splitFingerprintList(value: string): string[] | undefined {
  const list = [...new Set(value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))];
  return list.length ? list : undefined;
}

function fingerprintInput(values: Record<string, string>): ProfileFingerprintSettings | undefined {
  const out: ProfileFingerprintSettings = {};
  const text = (key: string) => values[key]?.trim() || undefined;
  const number = (key: string) => text(key) === undefined ? undefined : Number(text(key));
  const boolean = (key: string) => values[key] === "true" ? true : values[key] === "false" ? false : undefined;
  const set = <K extends keyof ProfileFingerprintSettings>(key: K, value: ProfileFingerprintSettings[K]) => {
    if (value !== undefined) out[key] = value;
  };
  set("userAgent", text("fpUserAgent"));
  set("hardwareConcurrency", number("fpCpu"));
  set("deviceMemory", number("fpMemory"));
  set("devicePixelRatio", number("fpPixelRatio"));
  set("colorDepth", number("fpColorDepth"));
  set("webglVendor", text("fpWebglVendor"));
  set("webglRenderer", text("fpWebglRenderer"));
  set("webgpuMode", text("fpWebgpu") as ProfileFingerprintSettings["webgpuMode"]);
  set("webrtcPolicy", text("fpWebrtc") as ProfileFingerprintSettings["webrtcPolicy"]);
  set("canvasNoise", boolean("fpCanvasNoise"));
  set("audioNoise", boolean("fpAudioNoise"));
  set("clientRectsNoise", boolean("fpClientRectsNoise"));
  set("fonts", splitFingerprintList(values.fpFonts ?? ""));
  set("speechVoices", splitFingerprintList(values.fpSpeechVoices ?? ""));
  set("geolocationPermission", text("fpGeoPermission") as ProfileFingerprintSettings["geolocationPermission"]);
  set("doNotTrack", boolean("fpDnt"));
  set("hardwareAcceleration", boolean("fpHardwareAcceleration"));
  const mediaCounts = ["fpAudioInputs", "fpAudioOutputs", "fpVideoInputs"].map(text);
  if (mediaCounts.some((count) => count !== undefined)) {
    if (mediaCounts.some((count) => count === undefined)) throw new Error("麦克风、扬声器和摄像头数量必须全部填写");
    out.mediaDevices = {
      audioInputCount: Number(mediaCounts[0]),
      audioOutputCount: Number(mediaCounts[1]),
      videoInputCount: Number(mediaCounts[2]),
    };
  }
  const latitude = text("fpLatitude");
  const longitude = text("fpLongitude");
  const accuracy = text("fpAccuracy");
  if ([latitude, longitude, accuracy].some((coordinate) => coordinate !== undefined)) {
    if (latitude === undefined || longitude === undefined) throw new Error("纬度和经度必须同时填写");
    out.geolocation = {
      latitude: Number(latitude),
      longitude: Number(longitude),
      accuracy: Number(accuracy ?? "20000"),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

function fingerprintFormFields(settings: ProfileFingerprintSettings = {}): Record<string, string> {
  const value = (input: unknown) => input === undefined ? "" : String(input);
  return {
    fpUserAgent: settings.userAgent ?? "",
    fpLanguages: settings.languages?.join(", ") ?? "",
    fpLocale: settings.locale ?? "",
    fpCpu: value(settings.hardwareConcurrency),
    fpMemory: value(settings.deviceMemory),
    fpPixelRatio: value(settings.devicePixelRatio),
    fpColorDepth: value(settings.colorDepth),
    fpWebglVendor: settings.webglVendor ?? "",
    fpWebglRenderer: settings.webglRenderer ?? "",
    fpWebgpu: settings.webgpuMode ?? "",
    fpWebrtc: settings.webrtcPolicy ?? "",
    fpCanvasNoise: value(settings.canvasNoise),
    fpAudioNoise: value(settings.audioNoise),
    fpClientRectsNoise: value(settings.clientRectsNoise),
    fpFonts: settings.fonts?.join(", ") ?? "",
    fpSpeechVoices: settings.speechVoices?.join(", ") ?? "",
    fpAudioInputs: value(settings.mediaDevices?.audioInputCount),
    fpAudioOutputs: value(settings.mediaDevices?.audioOutputCount),
    fpVideoInputs: value(settings.mediaDevices?.videoInputCount),
    fpLatitude: value(settings.geolocation?.latitude),
    fpLongitude: value(settings.geolocation?.longitude),
    fpAccuracy: value(settings.geolocation?.accuracy),
    fpGeoPermission: settings.geolocationPermission ?? "",
    fpDnt: value(settings.doNotTrack),
    fpHardwareAcceleration: value(settings.hardwareAcceleration),
  };
}

function FingerprintSettings({
  engine,
  screen,
  values,
  onScreenChange,
  onChange,
}: {
  engine: "chromium" | "firefox";
  screen: string;
  values: Record<string, string>;
  onScreenChange: (value: string) => void;
  onChange: (key: string, value: string) => void;
}) {
  const select = (key: string, label: string, options: ReadonlyArray<readonly [string, string]>) => (
    <label className="fld">
      <span>{label}</span>
      <select value={values[key] ?? ""} onChange={(event) => onChange(key, event.target.value)}>
        {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      </select>
    </label>
  );
  const automaticBoolean = [["", "自动"], ["true", "开启"], ["false", "关闭"]] as const;
  return (
    <details className="fingerprint-settings">
      <summary>
        <span>指纹设置</span>
        <span className="automatic-badge">自动 / 自定义</span>
      </summary>
      <div className="fingerprint-grid">
        <label className="fld">
          <span>浏览器</span>
          <input value={engine === "firefox" ? "AliasMode Firefox" : "IDFRI Browser"} readOnly tabIndex={-1} className="ro" />
        </label>
        <label className="fld"><span>浏览器语言</span><input value={values.fpLanguages ?? ""} placeholder="自动 · zh-CN, zh" onChange={(event) => onChange("fpLanguages", event.target.value)} /></label>
        <label className="fld"><span>界面语言 / Intl</span><input value={values.fpLocale ?? ""} placeholder="自动 · zh-CN" onChange={(event) => onChange("fpLocale", event.target.value)} /></label>
        {engine === "chromium" && (
          <>
            <label className="fld"><span>浏览器版本</span><input value="跟随已安装的 IDFRI Chromium 内核" readOnly tabIndex={-1} className="ro" /></label>
            <label className="fld"><span>操作系统</span><input value="Windows 桌面（自动一致）" readOnly tabIndex={-1} className="ro" /></label>
            <label className="fld fingerprint-wide"><span>用户代理（UA）</span><input value={values.fpUserAgent ?? ""} placeholder="自动；自定义值必须与当前 Chromium 主版本一致" onChange={(event) => onChange("fpUserAgent", event.target.value)} /></label>
            <label className="fld"><span>屏幕分辨率</span><input value={screen} placeholder="自动 · 例如 1920x1080" onChange={(event) => onScreenChange(event.target.value)} /></label>
            <label className="fld"><span>CPU 核心数</span><input type="number" min="1" max="128" value={values.fpCpu ?? ""} placeholder="自动 · 12" onChange={(event) => onChange("fpCpu", event.target.value)} /></label>
            <label className="fld"><span>设备内存（GB）</span><select value={values.fpMemory ?? ""} onChange={(event) => onChange("fpMemory", event.target.value)}><option value="">自动 · 8</option>{[0.25, 0.5, 1, 2, 4, 8].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            <label className="fld"><span>设备像素比</span><input type="number" min="0.5" max="4" step="0.25" value={values.fpPixelRatio ?? ""} placeholder="自动 · 1" onChange={(event) => onChange("fpPixelRatio", event.target.value)} /></label>
            <label className="fld"><span>颜色深度</span><input type="number" min="1" max="64" value={values.fpColorDepth ?? ""} placeholder="自动 · 24" onChange={(event) => onChange("fpColorDepth", event.target.value)} /></label>
            {select("fpWebrtc", "WebRTC", [["", "自动 · 使用代理时仅走代理"], ["disable_non_proxied_udp", "仅代理 UDP"], ["default_public_interface_only", "仅默认公网接口"], ["default", "真实网络接口"]])}
            {select("fpWebgpu", "WebGPU", [["", "自动 · 与 WebGL 一致"], ["match-webgl", "与 WebGL 一致"], ["disabled", "关闭"]])}
            <label className="fld"><span>WebGL 厂商</span><input value={values.fpWebglVendor ?? ""} placeholder="自动" onChange={(event) => onChange("fpWebglVendor", event.target.value)} /></label>
            <label className="fld fingerprint-wide"><span>WebGL 渲染器</span><input value={values.fpWebglRenderer ?? ""} placeholder="自动" onChange={(event) => onChange("fpWebglRenderer", event.target.value)} /></label>
            {select("fpCanvasNoise", "Canvas / WebGL 图像", automaticBoolean)}
            {select("fpAudioNoise", "AudioContext", automaticBoolean)}
            {select("fpClientRectsNoise", "ClientRects", automaticBoolean)}
            {select("fpDnt", "请勿跟踪（DNT）", [["", "自动 · 关闭"], ["true", "开启"], ["false", "关闭"]])}
            {select("fpHardwareAcceleration", "硬件加速", automaticBoolean)}
            <div className="fingerprint-subhead">媒体设备数量</div>
            <div className="fld-row fingerprint-wide">
              <label className="fld grow"><span>麦克风</span><input type="number" min="0" max="32" value={values.fpAudioInputs ?? ""} placeholder="自动" onChange={(event) => onChange("fpAudioInputs", event.target.value)} /></label>
              <label className="fld grow"><span>扬声器</span><input type="number" min="0" max="32" value={values.fpAudioOutputs ?? ""} placeholder="自动" onChange={(event) => onChange("fpAudioOutputs", event.target.value)} /></label>
              <label className="fld grow"><span>摄像头</span><input type="number" min="0" max="32" value={values.fpVideoInputs ?? ""} placeholder="自动" onChange={(event) => onChange("fpVideoInputs", event.target.value)} /></label>
            </div>
            <label className="fld fingerprint-wide"><span>字体白名单</span><textarea value={values.fpFonts ?? ""} placeholder="自动使用一致的 Windows 字体；自定义时用逗号或换行分隔" onChange={(event) => onChange("fpFonts", event.target.value)} /></label>
            <label className="fld fingerprint-wide"><span>SpeechVoices 白名单</span><textarea value={values.fpSpeechVoices ?? ""} placeholder="自动使用系统语音；自定义名称必须已安装" onChange={(event) => onChange("fpSpeechVoices", event.target.value)} /></label>
            {select("fpGeoPermission", "地理位置权限", [["", "自动 · 每次询问"], ["prompt", "询问"], ["granted", "允许"], ["denied", "拒绝"]])}
            <div className="fld-row fingerprint-wide">
              <label className="fld grow"><span>纬度</span><input type="number" min="-90" max="90" step="any" value={values.fpLatitude ?? ""} placeholder="自动" onChange={(event) => onChange("fpLatitude", event.target.value)} /></label>
              <label className="fld grow"><span>经度</span><input type="number" min="-180" max="180" step="any" value={values.fpLongitude ?? ""} placeholder="自动" onChange={(event) => onChange("fpLongitude", event.target.value)} /></label>
              <label className="fld grow"><span>精度（米）</span><input type="number" min="1" max="1000000" value={values.fpAccuracy ?? ""} placeholder="20000" onChange={(event) => onChange("fpAccuracy", event.target.value)} /></label>
            </div>
            <label className="fld"><span>TLS 指纹</span><input value="跟随当前 Chromium 内核" readOnly tabIndex={-1} className="ro" /></label>
            <label className="fld"><span>指纹种子</span><input value="自动 · 每个资料唯一且稳定" readOnly tabIndex={-1} className="ro" /></label>
          </>
        )}
        <div className="hint">{engine === "firefox"
          ? "AliasMode Firefox 使用原生资料，不支持 CDP、PDF 和 Chrome 扩展。"
          : "留空即使用一致的自动值。Canvas 噪声同时覆盖 WebGL 图像读取；字体、语音和媒体设备只能隐藏本机已有项目，不能伪造不存在的硬件。设备名称、MAC 和端口扫描保护尚需后续内核支持。"}</div>
      </div>
    </details>
  );
}

type DesktopInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type DesktopUpdateStatus =
  | { state: "upToDate"; currentVersion: string }
  | { state: "available"; currentVersion: string; version: string; highlights: string[] };
type DesktopUpdateProgress =
  | { phase: "preparing" | "verifying" | "closingBrowsers" | "installing" }
  | { phase: "downloading"; percent: number | null };
type DesktopUpdateMessage =
  | DesktopUpdateProgress
  | { phase: "ready"; version: string; highlights: string[] };
type SavedSessionPhase = "restoring" | "manual-signin" | "retryable-failure";
type RemoteMcpCredential =
  | { version: 1; state: "active"; connectorId: string; deviceId: string; token: string }
  | { version: 1; state: "disabled" };
interface RemoteMcpSettings {
  state: "idle" | "loading" | "active" | "disabled" | "error";
  connectorId?: string;
  deviceId?: string;
  url?: string;
  token?: string;
  error?: string;
}

function parseRemoteMcpCredential(value: string): RemoteMcpCredential {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (parsed.version !== 1) throw new Error("已保存的 Remote MCP 设置无效。");
  if (parsed.state === "disabled") return { version: 1, state: "disabled" };
  if (
    parsed.state === "active" &&
    typeof parsed.connectorId === "string" && parsed.connectorId &&
    typeof parsed.deviceId === "string" && parsed.deviceId &&
    typeof parsed.token === "string" && parsed.token
  ) {
    return {
      version: 1,
      state: "active",
      connectorId: parsed.connectorId,
      deviceId: parsed.deviceId,
      token: parsed.token,
    };
  }
  throw new Error("已保存的 Remote MCP 设置无效。");
}

async function readDesktopRemoteMcpCredential(): Promise<RemoteMcpCredential | null | undefined> {
  const invoke = desktopInvoke();
  if (!invoke) return undefined;
  const value = await invoke("credential_get", { key: "remote_mcp_connector" });
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("已保存的 Remote MCP 设置无效。");
  return parseRemoteMcpCredential(value);
}

async function storeDesktopRemoteMcpCredential(value: RemoteMcpCredential): Promise<void> {
  const invoke = desktopInvoke();
  if (!invoke) throw new Error("Remote MCP 设置仅可在 Windows 应用中使用。");
  await invoke("credential_set", { key: "remote_mcp_connector", secret: JSON.stringify(value) });
}

async function deleteDesktopRemoteMcpCredential(): Promise<void> {
  const invoke = desktopInvoke();
  if (invoke) await invoke("credential_delete", { key: "remote_mcp_connector" });
}

function isUpdateHighlights(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 3 && value.every((highlight) => typeof highlight === "string");
}

function parseDesktopUpdateStatus(value: unknown): DesktopUpdateStatus {
  if (!value || typeof value !== "object") throw new Error("IDFRI 返回了无效的更新状态。");
  const status = value as Record<string, unknown>;
  if (status.state === "upToDate" && typeof status.currentVersion === "string") {
    return { state: "upToDate", currentVersion: status.currentVersion };
  }
  if (
    status.state === "available" &&
    typeof status.currentVersion === "string" &&
    typeof status.version === "string" &&
    isUpdateHighlights(status.highlights)
  ) {
    return {
      state: "available",
      currentVersion: status.currentVersion,
      version: status.version,
      highlights: status.highlights,
    };
  }
  throw new Error("IDFRI 返回了无效的更新状态。");
}

function parseDesktopUpdateMessage(value: unknown): DesktopUpdateMessage {
  if (!value || typeof value !== "object") throw new Error("IDFRI 返回了无效的更新进度。");
  const progress = value as Record<string, unknown>;
  if (progress.phase === "ready" && typeof progress.version === "string" && isUpdateHighlights(progress.highlights)) {
    return { phase: "ready", version: progress.version, highlights: progress.highlights };
  }
  if (
    progress.phase === "preparing" ||
    progress.phase === "verifying" ||
    progress.phase === "closingBrowsers" ||
    progress.phase === "installing"
  ) {
    return { phase: progress.phase };
  }
  if (
    progress.phase === "downloading" &&
    (progress.percent === null ||
      (typeof progress.percent === "number" && Number.isInteger(progress.percent) && progress.percent >= 0 && progress.percent <= 100))
  ) {
    return { phase: "downloading", percent: progress.percent as number | null };
  }
  throw new Error("IDFRI 返回了无效的更新进度。");
}

function desktopInvoke(): DesktopInvoke | undefined {
  return (window as any).__TAURI_INTERNALS__?.invoke as DesktopInvoke | undefined;
}

function UpdateHighlights({ version, highlights }: { version: string; highlights: string[] }) {
  if (highlights.length === 0) return null;
  return (
    <details className="update-highlights">
      <summary>{version} 更新内容</summary>
      <ul>{highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>
    </details>
  );
}

function DesktopUpdateProgressView({ progress }: { progress: DesktopUpdateProgress }) {
  const percent = progress.phase === "downloading" ? progress.percent : null;
  const label = progress.phase === "preparing"
    ? "正在准备更新…"
    : progress.phase === "downloading"
      ? percent === null ? "正在下载更新…" : `正在下载更新… ${percent}%`
      : progress.phase === "verifying"
        ? "正在验证更新…"
        : progress.phase === "closingBrowsers"
          ? "正在保存并关闭浏览器…"
          : "正在安装并重启…";
  return (
    <div className="update-progress" role="status">
      <span>{label}</span>
      <progress max={100} value={percent ?? undefined} aria-label="更新进度" />
    </div>
  );
}

async function readDesktopCloudCredentials(): Promise<{
  refreshToken?: string;
  deviceCredential?: string;
  queueKey?: string;
} | null> {
  const invoke = desktopInvoke();
  if (!invoke) return null;
  const [refreshToken, deviceCredential, queueKey] = await Promise.all([
    invoke("credential_get", { key: "refresh_token" }),
    invoke("credential_get", { key: "device_credential" }),
    invoke("credential_get", { key: "queue_encryption_key" }),
  ]);
  return {
    ...(typeof refreshToken === "string" && refreshToken ? { refreshToken } : {}),
    ...(typeof deviceCredential === "string" && deviceCredential ? { deviceCredential } : {}),
    ...(typeof queueKey === "string" && queueKey ? { queueKey } : {}),
  };
}

async function storeDesktopCloudCredentials(
  refreshToken: string,
  deviceCredential: string,
  createdQueueKey?: string,
): Promise<boolean> {
  const invoke = desktopInvoke();
  if (!invoke) return false;
  if (createdQueueKey) {
    await invoke("credential_set", { key: "queue_encryption_key", secret: createdQueueKey });
  }
  await invoke("credential_set", { key: "device_credential", secret: deviceCredential });
  await invoke("credential_set", { key: "refresh_token", secret: refreshToken });
  return true;
}

const BLANK_FORM = {
  name: "", engine: "chromium" as "chromium" | "firefox", group: "", platform: "", proxyType: "http", host: "", port: "", user: "", pass: "",
  startupUrl: "", note: "", tags: "", cookies: "", screen: "", customNo: "", timezone: "", username: "", password: "", email: "", emailPassword: "", twofa: "",
  ...fingerprintFormFields(),
};

const BLANK_COOKIE_FORM = { name: "", value: "", domain: "", path: "/" };

type ProxyCheckUiState = {
  checking: boolean;
  result: ProxyCheckResult | null;
  error: "invalid" | "unavailable" | null;
};

const EMPTY_PROXY_CHECK: ProxyCheckUiState = { checking: false, result: null, error: null };

function proxyFailureMessage(reason: ProxyCheckResult["reason"]): string {
  if (reason === "authentication_failed") return "代理身份验证失败。";
  if (reason === "timeout") return "代理连接超时。";
  if (reason === "dns_failed") return "无法解析代理主机。";
  if (reason === "unreachable") return "无法连接代理服务器。";
  if (reason === "proxy_bypassed") return "流量未经过此代理。";
  return "代理连接失败。";
}

function ProxyCheckFeedback({ hasProxy, state }: { hasProxy: boolean; state: ProxyCheckUiState }) {
  if (!hasProxy) return null;
  if (state.error) {
    const invalid = state.error === "invalid";
    return (
      <div className={`proxy-check-result ${invalid ? "failed" : "unavailable"}`} role="status">
        <Icon name={invalid ? "alert" : "activity"} className="sm" />
        <span>{invalid
          ? "代理信息无效，请检查后重试。"
          : "代理检测暂不可用，请稍后重试。"}</span>
      </div>
    );
  }
  const result = state.result;
  if (!result) return null;
  const location = [result.city, result.region, result.country].filter(Boolean).join(", ");
  const exit = [result.ip ? `出口 IP：${result.ip}` : "", location].filter(Boolean).join(" · ");
  if (result.status === "working") {
    return (
      <div className="proxy-check-result working" role="status">
        <Icon name="check" className="sm" />
        <span><strong>代理可用。</strong>{exit && <> {exit}。</>}{result.rotating && <> 检测到轮换出口 IP。</>}</span>
      </div>
    );
  }
  if (result.status === "unstable") {
    return (
      <div className="proxy-check-result unstable" role="status">
        <Icon name="warning" className="sm" />
        <span><strong>代理状态不稳定。</strong> {result.attempts} 次检测中有 {result.successes} 次成功。</span>
      </div>
    );
  }
  if (result.status === "failed") {
    return (
      <div className="proxy-check-result failed" role="status">
        <Icon name="alert" className="sm" />
        <span>{proxyFailureMessage(result.reason)}</span>
      </div>
    );
  }
  return (
    <div className="proxy-check-result unavailable" role="status">
      <Icon name="activity" className="sm" />
      <span>代理检测暂不可用，请稍后重试。</span>
    </div>
  );
}

function App() {
  const [profiles, setProfiles] = useState<UiProfile[]>([]);
  const [registeredGroups, setRegisteredGroups] = useState<string[]>([]);
  const [appMode, setAppMode] = useState<AppModeConfig | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [modeErr, setModeErr] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  // "profiles" is the roster; "settings" replaces it in the same content area
  // rather than opening a dialog — Settings outgrew a modal. New Profile and
  // Edit stay dialogs: short forms, and a page felt like too much ceremony.
  const [view, setView] = useState<"profiles" | "scripts" | "settings" | "extensions" | "proxies" | "trash">("profiles");
  const [scriptRunOpen, setScriptRunOpen] = useState(false);
  const [scriptRunProfiles, setScriptRunProfiles] = useState<UiProfile[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("account");
  const [remoteMcp, setRemoteMcp] = useState<RemoteMcpSettings>({ state: "idle" });
  const [remoteMcpTokenVisible, setRemoteMcpTokenVisible] = useState(false);
  const [remoteMcpCopied, setRemoteMcpCopied] = useState<"url" | "token" | null>(null);
  const [cloudEvents, setCloudEvents] = useState<CloudDiagnosticEvent[]>([]);
  const [cloudEventsBusy, setCloudEventsBusy] = useState(false);
  const [cloudEventsErr, setCloudEventsErr] = useState<string | null>(null);
  const [cloudAuth, setCloudAuth] = useState<CloudAuthState | null>(null);
  const [savedSessionPhase, setSavedSessionPhase] = useState<SavedSessionPhase>("restoring");
  const [scheduledRefreshPending, setScheduledRefreshPending] = useState(false);
  const [authView, setAuthView] = useState<"signin" | "signup">("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [confirmationEmail, setConfirmationEmail] = useState("");
  const [invitationCode, setInvitationCode] = useState("");
  const [team, setTeam] = useState<CloudTeamState | null>(null);
  const [teamEmail, setTeamEmail] = useState("");
  const [teamRole, setTeamRole] = useState<"admin" | "member">("member");
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamErr, setTeamErr] = useState<string | null>(null);
  const [healthSources, setHealthSources] = useState<HealthSource[]>([]);
  const [appVersion, setAppVersion] = useState("");
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateStatus | null>(null);
  const [desktopUpdateResult, setDesktopUpdateResult] = useState<DesktopUpdateResult | null>(null);
  const [desktopUpdateResultDismissed, setDesktopUpdateResultDismissed] = useState(false);
  const [desktopUpdateChecking, setDesktopUpdateChecking] = useState(false);
  const [desktopUpdateInstalling, setDesktopUpdateInstalling] = useState(false);
  const [desktopUpdateProgress, setDesktopUpdateProgress] = useState<DesktopUpdateProgress | null>(null);
  const [desktopUpdateErr, setDesktopUpdateErr] = useState<string | null>(null);
  const [logDir, setLogDir] = useState<string | undefined>(undefined);
  const [logView, setLogView] = useState<{ file: string; content: string } | null>(null);
  const [logErr, setLogErr] = useState<string | null>(null);
  const [diag, setDiag] = useState<DiagnoseReport | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("all");
  const [profilePage, setProfilePage] = useState(0);
  const [pageSize, setPageSize] = useState(readPageSize);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "no", dir: 1 });
  const [hiddenCols, setHiddenCols] = useState<Set<ColumnKey>>(readHiddenColumns);
  const [colsOpen, setColsOpen] = useState(false);
  const [nodesOpen, setNodesOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [railForced, setRailForced] = useState(readRailForced);
  const [tableScrolled, setTableScrolled] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  // Two error slots so an auto-refresh can't silently wipe why an action failed:
  // actionErr is sticky (Open/Close/move/import), connErr tracks load() only.
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [connErr, setConnErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null); // transient success banner
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const deleteInFlight = useRef(false);
  // Active profile export: null when idle, otherwise how far the server-side
  // collection has progressed ({completed: total} = file being built).
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [newMode, setNewMode] = useState(false);
  const [newGroup, setNewGroup] = useState("");
  const [dragging, setDragging] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [form, setForm] = useState(BLANK_FORM);
  const [createProxyCheck, setCreateProxyCheck] = useState<ProxyCheckUiState>(EMPTY_PROXY_CHECK);
  const createProxyCheckGeneration = useRef(0);
  const [cookieProfile, setCookieProfile] = useState<UiProfile | null>(null);
  const [cookieForm, setCookieForm] = useState(BLANK_COOKIE_FORM);
  const [cookieErr, setCookieErr] = useState<string | null>(null);
  const [cookieSaving, setCookieSaving] = useState(false);
  const [proxyPaste, setProxyPaste] = useState("");
  const [proxyPasteOk, setProxyPasteOk] = useState<string | null>(null);
  // Edit modal + bulk export/update + group rename
  const [editId, setEditId] = useState<string | null>(null);
  const [editExpectedVersion, setEditExpectedVersion] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editProxyCheck, setEditProxyCheck] = useState<ProxyCheckUiState>(EMPTY_PROXY_CHECK);
  const editProxyCheckGeneration = useRef(0);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  // Cloud profile open on this device: edits land in the local cache and sync
  // to Cloud with the running session — no expectedVersion handshake.
  const [editLive, setEditLive] = useState(false);
  const [editEngine, setEditEngine] = useState<"chromium" | "firefox">("chromium");
  const [timezoneBusy, setTimezoneBusy] = useState(false);
  const editFetchId = useRef<string | null>(null);
  const [editMobile, setEditMobile] = useState<NonNullable<EditProfile["desktopConversion"]> | null>(null);
  const [editTotp, setEditTotp] = useState<{ code: string; secs: number } | null>(null);
  const [twoFaFlash, setTwoFaFlash] = useState<{ id: string; code: string } | null>(null);
  const [editExts, setEditExts] = useState<string[]>([]);
  const [editInitialExts, setEditInitialExts] = useState<string[]>([]);
  // Local extension registry + Extensions page
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [groupExtensionDefaults, setGroupExtensionDefaultsState] = useState<GroupExtensionDefaults[]>([]);
  const [groupDefaultName, setGroupDefaultName] = useState("");
  const [groupDefaultExts, setGroupDefaultExts] = useState<string[]>([]);
  const [groupDefaultBusy, setGroupDefaultBusy] = useState(false);
  const [extSource, setExtSource] = useState("");
  const [extInstallBusy, setExtInstallBusy] = useState(false);
  const [extBusy, setExtBusy] = useState(false);
  const [extErr, setExtErr] = useState<string | null>(null);
  const extFileRef = useRef<HTMLInputElement>(null);
  const [bulkExt, setBulkExt] = useState(""); // extension chosen for bulk assign
  // Update-from-file modal (export → edit → re-upload, matched by id)
  const [showUpdate, setShowUpdate] = useState(false);
  const [updateFile, setUpdateFile] = useState<File | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateErr, setUpdateErr] = useState<string | null>(null);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const [updateOver, setUpdateOver] = useState(false);
  const updateFileRef = useRef<HTMLInputElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [addingGroup, setAddingGroup] = useState(false);
  const [sidebarGroupName, setSidebarGroupName] = useState("");
  // Bulk add accounts from provider files or pasted AdsPower text.
  const [showBulk, setShowBulk] = useState(false);
  const [bulkFiles, setBulkFiles] = useState<File[]>([]);
  const [bulkText, setBulkText] = useState("");
  const [bulkGroup, setBulkGroup] = useState("");
  const [bulkPlatform, setBulkPlatform] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkErr, setBulkErr] = useState<string | null>(null);
  const [bulkOver, setBulkOver] = useState(false);
  // One source at a time: two full-height inputs stacked made it ambiguous which
  // one the Import button would actually read.
  const [bulkSource, setBulkSource] = useState<"file" | "paste">("file");
  const bulkFileRef = useRef<HTMLInputElement>(null);
  const authGeneration = useRef(0);
  const remoteMcpInFlight = useRef<Promise<void> | null>(null);
  const remoteMcpAccountExit = useRef(false);
  const publishedRuntimeReadiness = useRef<string | null>(null);
  const [runtimeReadinessAttempt, setRuntimeReadinessAttempt] = useState(0);
  const restoreInFlight = useRef(false);
  const savedSessionRestoreEnabled = useRef(true);
  const desktopUpdateCheckStarted = useRef(false);
  const isCloudMode = appMode?.mode === "cloud";
  const workspaceReady = appMode?.mode === "local" || (isCloudMode && cloudWorkspaceReady(cloudAuth));
  const canEditCloud = !isCloudMode || cloudAuth?.workspace?.role === "owner" || cloudAuth?.workspace?.role === "admin" ||
    profiles.some((profile) => profile.permission === "edit") || team?.folders.some((folder) => folder.permission === "edit") === true;
  const canManageCloudFolders = cloudAuth?.workspace?.role === "owner" || cloudAuth?.workspace?.role === "admin";

  // The app resolves "system" itself and stamps the result on <html>, so the
  // stylesheet carries exactly one dark palette instead of a duplicated media query.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    // Only follow the OS while the operator has actually asked us to.
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia(RAIL_MEDIA);
    const apply = () => setRailForced(media.matches);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  // Escape closes whatever dialog is open, topmost first — standard desktop
  // behavior the mouse-only close buttons don't cover.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (logView || logErr) { setLogView(null); setLogErr(null); return; }
      if (showUpdate) { setShowUpdate(false); return; }
      if (showBulk) { closeBulk(); return; }
      if (cookieProfile) { if (!cookieSaving) closeCookie(); return; }
      if (editId) { closeEdit(); return; }
      if (showCreate) closeCreate();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const reloadGroupExtensionDefaults = async () => {
    try {
      setGroupExtensionDefaultsState(await fetchGroupExtensionDefaults());
    } catch (error) {
      setExtErr(error instanceof Error ? error.message : String(error));
    }
  };

  const load = async () => {
    try {
      const roster = await fetchProfiles();
      setProfiles(roster.profiles);
      setRegisteredGroups(roster.groups);
      setHealthSources(roster.healthSources);
      setConnErr(null); // manages connectivity only; never clears an action error
    } catch (e) {
      setConnErr(String(e));
    } finally {
      setLoaded(true);
    }
  };

  const loadCloudEvents = async () => {
    if (!isCloudMode) {
      setCloudEvents([]);
      setCloudEventsErr(null);
      return;
    }
    setCloudEventsBusy(true);
    setCloudEventsErr(null);
    try {
      setCloudEvents((await fetchCloudEvents()).slice().reverse());
    } catch {
      setCloudEventsErr("无法加载最近的诊断记录。");
    } finally {
      setCloudEventsBusy(false);
    }
  };

  const loadTeam = async () => {
    if (!isCloudMode) return;
    setTeamBusy(true);
    setTeamErr(null);
    try { setTeam(await fetchCloudTeam()); }
    catch (error) { setTeamErr(error instanceof Error ? error.message : String(error)); }
    finally { setTeamBusy(false); }
  };

  const runTeamAction = async (action: string, input: Record<string, string>, done?: string): Promise<boolean> => {
    setTeamBusy(true);
    setTeamErr(null);
    try {
      await cloudWorkspaceAction(action, input);
      await loadTeam();
      if (done) flash(done);
      return true;
    } catch (error) {
      setTeamErr(error instanceof Error ? error.message : String(error));
      setTeamBusy(false);
      return false;
    }
  };

  const inviteTeamMember = async () => {
    const email = teamEmail.trim();
    const ok = await runTeamAction("invite", { email, role: teamRole }, `邀请已发送至 ${email}`);
    if (ok) setTeamEmail("");
  };

  const checkDesktopUpdate = async (manual: boolean) => {
    const invoke = desktopInvoke();
    if (!invoke) {
      if (manual) setDesktopUpdateErr("更新功能仅可在 Windows 桌面应用中使用。");
      return;
    }
    setDesktopUpdateChecking(true);
    if (manual) setDesktopUpdateErr(null);
    try {
      setDesktopUpdate(parseDesktopUpdateStatus(await invoke("check_for_updates")));
    } catch (error) {
      if (manual) setDesktopUpdateErr(error instanceof Error ? error.message : String(error));
    } finally {
      setDesktopUpdateChecking(false);
    }
  };

  const installDesktopUpdate = async () => {
    const invoke = desktopInvoke();
    if (!invoke || desktopUpdate?.state !== "available") return;
    const onProgress = new Channel<unknown>();
    onProgress.onmessage = (value) => {
      try {
        const message = parseDesktopUpdateMessage(value);
        if (message.phase === "ready") {
          setDesktopUpdate((status) => status?.state === "available"
            ? { ...status, version: message.version, highlights: message.highlights }
            : status);
        } else {
          setDesktopUpdateProgress(message);
        }
      } catch { /* Ignore malformed native progress without interrupting the update. */ }
    };
    setDesktopUpdateInstalling(true);
    setDesktopUpdateProgress({ phase: "preparing" });
    setDesktopUpdateErr(null);
    try {
      await invoke("update_now", { onProgress });
    } catch (error) {
      setDesktopUpdateErr(error instanceof Error ? error.message : String(error));
      setDesktopUpdateProgress(null);
      setDesktopUpdateInstalling(false);
    }
  };

  const provisionRemoteMcp = async (): Promise<RemoteMcpSettings> => {
    const created = await createCloudConnector();
    if (
      created.state !== "active" ||
      typeof created.connectorId !== "string" || !created.connectorId ||
      typeof created.deviceId !== "string" || !created.deviceId ||
      typeof created.url !== "string" || !created.url ||
      typeof created.token !== "string" || !created.token
    ) {
      throw new Error("IDFRI Cloud 返回了无效的 Remote MCP 设置。");
    }
    try {
      await storeDesktopRemoteMcpCredential({
        version: 1,
        state: "active",
        connectorId: created.connectorId,
        deviceId: created.deviceId,
        token: created.token,
      });
    } catch {
      await revokeCloudConnector(created.connectorId).catch(() => undefined);
      throw new Error("无法安全保存 Remote MCP 访问密钥。");
    }
    return {
      state: "active",
      connectorId: created.connectorId,
      deviceId: created.deviceId,
      url: created.url,
      token: created.token,
    };
  };

  const runRemoteMcpTask = (work: () => Promise<void>): Promise<void> => {
    if (remoteMcpAccountExit.current) return Promise.resolve();
    if (remoteMcpInFlight.current) return remoteMcpInFlight.current;
    const task = work().finally(() => {
      if (remoteMcpInFlight.current === task) remoteMcpInFlight.current = null;
    });
    remoteMcpInFlight.current = task;
    return task;
  };

  const loadRemoteMcp = (): Promise<void> => runRemoteMcpTask(async () => {
    if (!isCloudMode || !cloudWorkspaceReady(cloudAuth)) {
      setRemoteMcp({ state: "idle" });
      return;
    }
    setRemoteMcpTokenVisible(false);
    setRemoteMcpCopied(null);
    setRemoteMcp({ state: "loading" });
    try {
      const stored = await readDesktopRemoteMcpCredential();
      if (stored === undefined) {
        throw new Error("Remote MCP 设置仅可在 Windows 桌面应用中使用。");
      }
      if (stored?.state === "disabled") {
        setRemoteMcp({ state: "disabled" });
        return;
      }
      if (stored?.state === "active") {
        const status = await fetchCloudConnector(stored.connectorId);
        if (status.state === "active" && status.url) {
          setRemoteMcp({
            state: "active",
            connectorId: stored.connectorId,
            deviceId: stored.deviceId,
            url: status.url,
            token: stored.token,
          });
          return;
        }
      }
      setRemoteMcp(await provisionRemoteMcp());
    } catch (error) {
      setRemoteMcp({ state: "error", error: error instanceof Error ? error.message : String(error) });
    }
  });

  const enableRemoteMcp = (): Promise<void> => runRemoteMcpTask(async () => {
    setRemoteMcp({ state: "loading" });
    setRemoteMcpTokenVisible(false);
    try {
      setRemoteMcp(await provisionRemoteMcp());
    } catch (error) {
      setRemoteMcp({ state: "error", error: error instanceof Error ? error.message : String(error) });
    }
  });

  const disableRemoteMcp = async () => {
    if (remoteMcp.state !== "active" || !remoteMcp.connectorId) return;
    if (!window.confirm("确定禁用此 Remote MCP 连接吗？已连接的客户端将停止工作。")) return;
    await runRemoteMcpTask(async () => {
      setRemoteMcp({ state: "loading" });
      setRemoteMcpTokenVisible(false);
      try {
        await revokeCloudConnector(remoteMcp.connectorId!);
        await storeDesktopRemoteMcpCredential({ version: 1, state: "disabled" });
        setRemoteMcp({ state: "disabled" });
      } catch (error) {
        setRemoteMcp({ state: "error", error: error instanceof Error ? error.message : String(error) });
      }
    });
  };

  const regenerateRemoteMcp = async () => {
    if (remoteMcp.state !== "active" || !remoteMcp.connectorId) return;
    if (!window.confirm("确定生成新的 Remote MCP 访问密钥吗？现有客户端将断开连接。")) return;
    await runRemoteMcpTask(async () => {
      setRemoteMcp({ state: "loading" });
      setRemoteMcpTokenVisible(false);
      try {
        await revokeCloudConnector(remoteMcp.connectorId!);
        await storeDesktopRemoteMcpCredential({ version: 1, state: "disabled" });
        setRemoteMcp(await provisionRemoteMcp());
      } catch (error) {
        setRemoteMcp({ state: "error", error: error instanceof Error ? error.message : String(error) });
      }
    });
  };

  const copyRemoteMcp = async (kind: "url" | "token", value: string) => {
    try {
      await copyPlainText(value);
      setRemoteMcpCopied(kind);
      window.setTimeout(() => setRemoteMcpCopied((current) => current === kind ? null : current), 1200);
    } catch {
      setRemoteMcp((current) => ({ ...current, error: "无法复制 Remote MCP 连接信息。" }));
    }
  };

  const prepareRemoteMcpForAccountExit = async (bestEffort = false) => {
    remoteMcpAccountExit.current = true;
    try {
      if (remoteMcpInFlight.current) await remoteMcpInFlight.current;
      const connector = await readDesktopRemoteMcpCredential();
      if (connector?.state === "active") {
        await revokeCloudConnector(connector.connectorId);
        await storeDesktopRemoteMcpCredential({ version: 1, state: "disabled" });
        setRemoteMcp({ state: "disabled" });
        setRemoteMcpTokenVisible(false);
      }
    } catch (error) {
      if (!bestEffort) throw error;
    }
  };

  const openAccountSettings = () => {
    setModeErr(null);
    setView("settings");
    setRemoteMcpTokenVisible(false);
    void loadRemoteMcp();
    void loadCloudEvents();
    void loadTeam();
  };

  /** Leaving Settings must never keep a revealed Remote MCP key on screen. */
  const closeAccountSettings = () => {
    setRemoteMcpTokenVisible(false);
    setRemoteMcpCopied(null);
    setView("profiles");
  };

  const chooseMode = async (mode: "local" | "cloud"): Promise<boolean> => {
    setModeBusy(true);
    setModeErr(null);
    try {
      const result = await selectAppMode(mode);
      setAppMode(result.config);
      const needsRestart = result.restartRequired === true;
      setRestartRequired(needsRestart);
      const invoke = desktopInvoke();
      if (needsRestart && invoke) await invoke("restart_after_mode_change");
      return true;
    } catch (error) {
      setModeErr(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setModeBusy(false);
    }
  };

  const restoreSavedSession = async (startup: boolean) => {
    if (!savedSessionRestoreEnabled.current || restoreInFlight.current) return;
    restoreInFlight.current = true;
    const generation = authGeneration.current;
    if (startup) {
      setSavedSessionPhase("restoring");
      setAuthBusy(true);
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const stored = await readDesktopCloudCredentials();
          if (generation !== authGeneration.current || !savedSessionRestoreEnabled.current) return;
          if (!stored?.refreshToken || !stored.deviceCredential || !stored.queueKey) {
            setCloudAuth({ authenticated: false });
            setSavedSessionPhase("manual-signin");
            setScheduledRefreshPending(false);
            setAuthErr(null);
            return;
          }
          const result = await restoreCloudSession(
            stored.refreshToken,
            stored.deviceCredential,
            stored.queueKey,
            startup,
          );
          if (generation !== authGeneration.current || !savedSessionRestoreEnabled.current) return;
          if (typeof result.refreshToken !== "string" || !result.refreshToken) {
            throw new Error("Cloud 未返回刷新令牌");
          }
          await storeDesktopCloudCredentials(result.refreshToken, stored.deviceCredential);
          if (generation !== authGeneration.current || !savedSessionRestoreEnabled.current) return;
          setCloudAuth({
            authenticated: true,
            expiresAt: result.expiresAt,
            user: result.user,
            workspace: result.workspace,
            legal: result.legal,
          });
          setSavedSessionPhase("manual-signin");
          setScheduledRefreshPending(false);
          setAuthErr(null);
          return;
        } catch (error) {
          if (generation !== authGeneration.current || !savedSessionRestoreEnabled.current) return;
          if (error instanceof CloudSessionRestoreError && !error.retryable) {
            await deleteDesktopRemoteMcpCredential().catch(() => undefined);
            setRemoteMcp({ state: "idle" });
            setRemoteMcpTokenVisible(false);
            setCloudAuth({ authenticated: false });
            setSavedSessionPhase("manual-signin");
            setScheduledRefreshPending(false);
            setAuthErr(error.message);
            return;
          }
          if (attempt === 0) continue;
          const message = error instanceof CloudSessionRestoreError
            ? error.message
            : "无法恢复已保存的 Cloud 会话，请在网络连接可用后重试。";
          setAuthErr(message);
          if (startup) setSavedSessionPhase("retryable-failure");
          else setScheduledRefreshPending(true);
        }
      }
    } finally {
      restoreInFlight.current = false;
      if (startup && generation === authGeneration.current) setAuthBusy(false);
    }
  };

  const signInInstead = async () => {
    savedSessionRestoreEnabled.current = false;
    const generation = ++authGeneration.current;
    setAuthBusy(true);
    setAuthErr(null);
    try {
      await prepareRemoteMcpForAccountExit(true);
      await forgetCloudSession();
      await deleteDesktopRemoteMcpCredential().catch(() => undefined);
      setRemoteMcp({ state: "idle" });
      if (generation !== authGeneration.current) return;
      setCloudAuth({ authenticated: false });
      setSavedSessionPhase("manual-signin");
      setScheduledRefreshPending(false);
      setProfiles([]);
      setHealthSources([]);
      setSelected(new Set());
      setTeam(null);
      setCloudEvents([]);
      setAuthPassword("");
      setAuthNotice(null);
    } catch (error) {
      if (generation === authGeneration.current) {
        savedSessionRestoreEnabled.current = true;
        setAuthErr(error instanceof Error ? error.message : String(error));
      }
    } finally {
      remoteMcpAccountExit.current = false;
      if (generation === authGeneration.current) setAuthBusy(false);
    }
  };

  const submitCloudAuth = async () => {
    const generation = authGeneration.current;
    setAuthBusy(true);
    setAuthErr(null);
    setAuthNotice(null);
    try {
      if (authView === "signup") {
        const result = await signUpCloud(authEmail, authPassword);
        setAuthNotice(result.verificationRequired
          ? "请检查邮箱、验证账号，然后登录。"
          : "账号已创建，现在可以登录。");
        setConfirmationEmail(result.verificationRequired ? authEmail : "");
        setAuthView("signin");
      } else {
        const stored = await readDesktopCloudCredentials();
        const result = await signInCloud(authEmail, authPassword, stored?.queueKey);
        if (generation !== authGeneration.current) return;
        if (typeof result.refreshToken !== "string" || !result.refreshToken) {
          throw new Error("Cloud 未返回刷新令牌");
        }
        if (typeof result.deviceCredential !== "string" || !result.deviceCredential) {
          throw new Error("Cloud 未返回设备凭据");
        }
        if (
          !stored?.queueKey &&
          result.queueKeyPersisted !== true &&
          (typeof result.queueKey !== "string" || !result.queueKey)
        ) {
          throw new Error("Cloud 未初始化加密的待同步队列");
        }
        const persisted = await storeDesktopCloudCredentials(
          result.refreshToken,
          result.deviceCredential,
          typeof result.queueKey === "string" ? result.queueKey : undefined,
        );
        if (generation !== authGeneration.current) return;
        savedSessionRestoreEnabled.current = true;
        setCloudAuth({
          authenticated: true,
          expiresAt: result.expiresAt,
          user: result.user,
          workspace: result.workspace,
          legal: result.legal,
        });
        setSavedSessionPhase("manual-signin");
        setScheduledRefreshPending(false);
        setAuthPassword("");
        if (!persisted) setAuthNotice("本次运行已登录，但桌面凭据存储不可用。");
      }
    } catch (error) {
      if (generation === authGeneration.current) {
        setAuthErr(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (generation === authGeneration.current) setAuthBusy(false);
    }
  };

  const signOut = async () => {
    setAuthBusy(true);
    setAuthErr(null);
    try {
      await prepareRemoteMcpForAccountExit();
      await signOutCloud();
      await deleteDesktopRemoteMcpCredential().catch(() => undefined);
      setRemoteMcp({ state: "idle" });
      authGeneration.current++;
      setCloudAuth({ authenticated: false });
      setSavedSessionPhase("manual-signin");
      setScheduledRefreshPending(false);
      setProfiles([]);
      setHealthSources([]);
      setSelected(new Set());
      setTeam(null);
      setCloudEvents([]);
      setAuthPassword("");
      setAuthNotice(null);
      closeAccountSettings();
    } catch (error) {
      setAuthErr(error instanceof Error ? error.message : String(error));
    } finally {
      remoteMcpAccountExit.current = false;
      setAuthBusy(false);
    }
  };

  const resendConfirmation = async () => {
    setAuthBusy(true);
    setAuthErr(null);
    try {
      await resendCloudSignUp(confirmationEmail);
      setAuthNotice("确认邮件已重新发送。");
    } catch (error) {
      setAuthErr(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const acceptInvitation = async () => {
    setAuthBusy(true);
    setAuthErr(null);
    try {
      await acceptCloudInvitation(invitationCode);
      setInvitationCode("");
      setAuthNotice("邀请已接受。");
      setCloudAuth(await fetchCloudAuth());
      await Promise.all([load(), loadTeam()]);
    } catch (error) {
      setAuthErr(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const acceptCurrentLegal = async () => {
    setAuthBusy(true);
    setAuthErr(null);
    try {
      const result = await acceptCloudLegal();
      setCloudAuth((state) => state ? { ...state, legal: result.legal } : state);
    } catch (error) {
      setAuthErr(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthBusy(false);
    }
  };

  useEffect(() => {
    const invoke = desktopInvoke();
    if (!invoke) return;
    let active = true;
    void invoke("last_update_result")
      .then((value) => {
        if (!active) return;
        setDesktopUpdateResult(parseDesktopUpdateResult(value));
        setDesktopUpdateResultDismissed(false);
      })
      .catch((error) => {
        if (active) setDesktopUpdateErr(error instanceof Error ? error.message : String(error));
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    fetchAppMode().then((config) => {
      setAppMode(config);
      setRestartRequired(config.restartRequired === true);
    }).catch((error) => {
      setConnErr(String(error));
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (restartRequired) return;
    const readiness = appMode?.mode === "local"
      ? "local"
      : appMode?.mode === "cloud" && cloudAuth !== null
        ? cloudAuth.authenticated ? "cloud_authenticated" : "sign_in_required"
        : null;
    const invoke = desktopInvoke();
    if (!readiness || !invoke || publishedRuntimeReadiness.current === readiness) return;
    let active = true;
    let retry: number | undefined;
    publishedRuntimeReadiness.current = readiness;
    void invoke("agent_runtime_ready", { readiness }).catch(() => {
      if (!active || publishedRuntimeReadiness.current !== readiness) return;
      publishedRuntimeReadiness.current = null;
      retry = window.setTimeout(() => {
        if (active) setRuntimeReadinessAttempt((attempt) => attempt + 1);
      }, 500);
    });
    return () => {
      active = false;
      if (retry !== undefined) window.clearTimeout(retry);
    };
  }, [appMode?.mode, cloudAuth?.authenticated, restartRequired, runtimeReadinessAttempt]);

  useEffect(() => {
    if (!appMode || restartRequired || desktopUpdateCheckStarted.current) return;
    desktopUpdateCheckStarted.current = true;
    void checkDesktopUpdate(false);
  }, [appMode?.mode, restartRequired]);

  useEffect(() => {
    if (appMode?.mode !== "cloud" || restartRequired) return;
    let active = true;
    const generation = authGeneration.current;
    setSavedSessionPhase("restoring");
    const restore = async () => {
      try {
        const state = await fetchCloudAuth();
        if (cloudSessionContextReady(state)) {
          if (active && generation === authGeneration.current) {
            setCloudAuth(state);
            setSavedSessionPhase("manual-signin");
            setAuthErr(null);
          }
          return;
        }
      } catch {
        // A saved session can still recover when the first status probe fails.
      }
      if (active && generation === authGeneration.current) await restoreSavedSession(true);
    };
    void restore();
    return () => { active = false; };
  }, [appMode?.mode, restartRequired]);

  useEffect(() => {
    if (
      appMode?.mode !== "cloud" ||
      restartRequired ||
      !cloudAuth?.authenticated ||
      !cloudAuth.expiresAt
    ) return;
    const delay = Math.max(1_000, cloudAuth.expiresAt - Date.now() - 60_000);
    const timer = window.setTimeout(() => { void restoreSavedSession(false); }, delay);
    return () => window.clearTimeout(timer);
  }, [appMode?.mode, restartRequired, cloudAuth?.authenticated, cloudAuth?.expiresAt]);

  useEffect(() => {
    if (appMode?.mode !== "cloud" || restartRequired) return;
    const retryWhenOnline = () => {
      if (savedSessionPhase === "retryable-failure") void restoreSavedSession(true);
      else if (scheduledRefreshPending) void restoreSavedSession(false);
    };
    window.addEventListener("online", retryWhenOnline);
    return () => window.removeEventListener("online", retryWhenOnline);
  }, [appMode?.mode, restartRequired, savedSessionPhase, scheduledRefreshPending]);

  useEffect(() => {
    if (!isCloudMode || !workspaceReady || restartRequired) return;
    void loadTeam();
  }, [isCloudMode, restartRequired, workspaceReady]);

  useEffect(() => {
    if (view !== "settings" || !isCloudMode || !workspaceReady || restartRequired) return;
    void loadRemoteMcp();
  }, [view, isCloudMode, restartRequired, workspaceReady]);

  useEffect(() => {
    if (!appMode || !workspaceReady || restartRequired) return;
    load();
    fetchHealth().then((health) => { setAppVersion(health.version); setLogDir(health.logDir); }).catch(() => {});
    // The extension registry is local to this computer in both modes; Cloud
    // profiles carry assignments and load the matching uploads at launch.
    fetchExtensions().then(setExtensions).catch(() => {});
    if (appMode.mode === "local") {
      fetchDiagnose().then(setDiag).catch(() => {});
    }
  }, [appMode?.mode, restartRequired, workspaceReady]);

  useEffect(() => {
    if (view !== "extensions" || !appMode || !workspaceReady || restartRequired) return;
    void reloadGroupExtensionDefaults();
  }, [view, appMode?.mode, restartRequired, workspaceReady]);

  useEffect(() => {
    const editable = groupExtensionDefaults.filter((item) => item.permission === "edit");
    if (!editable.some((item) => item.name === groupDefaultName)) {
      setGroupDefaultName(editable[0]?.name ?? "");
    }
  }, [groupExtensionDefaults, groupDefaultName]);

  useEffect(() => {
    setGroupDefaultExts(
      groupExtensionDefaults.find((item) => item.name === groupDefaultName)?.extensions ?? [],
    );
  }, [groupExtensionDefaults, groupDefaultName]);

  useEffect(() => {
    if (!appMode || !workspaceReady || restartRequired) return;
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [appMode?.mode, restartRequired, workspaceReady]);

  // Live 2FA code in the Edit modal: fetch the current TOTP, count it down
  // locally, and refetch when the window rolls over.
  useEffect(() => {
    if (!editId || isCloudMode) { setEditTotp(null); return; }
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetchTotp(editId);
        if (alive) setEditTotp(r.code ? { code: r.code, secs: r.secondsRemaining ?? 30 } : null);
      } catch { if (alive) setEditTotp(null); }
    };
    tick();
    const timer = setInterval(() => {
      setEditTotp((t) => {
        if (!t) return t;
        if (t.secs <= 1) { tick(); return t; }
        return { ...t, secs: t.secs - 1 };
      });
    }, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [editId, isCloudMode]);

  const groups = useMemo(
    () => ["all", ...Array.from(new Set([
      ...profiles.map((profile) => profile.group).filter(Boolean),
      ...(isCloudMode
        ? (team?.folders.filter((folder) => !folder.archivedAt).map((folder) => folder.name) ?? [])
        : registeredGroups),
    ])).sort()],
    [profiles, isCloudMode, registeredGroups, team?.folders],
  );

  /**
   * Every profile's visible "No.", resolved once against the unsorted roster so
   * sorting or paging can never renumber a row underneath the operator.
   */
  const numbering = useMemo(() => {
    const map = new Map<string, { value: string; custom: boolean }>();
    profiles.forEach((profile, index) => map.set(profile.id, displayNo(profile, index)));
    return map;
  }, [profiles]);

  const sortField = (p: UiProfile, key: SortKey): string | number => {
    switch (key) {
      case "no": return Number(numbering.get(p.id)?.value ?? 0);
      case "name": return p.name.toLowerCase();
      case "group": return p.group.toLowerCase();
      case "platform": return p.platform.toLowerCase();
      case "proxy": return (p.proxy ?? "").toLowerCase();
      case "status": return p.running ? 0 : 1;
      default: return 0;
    }
  };

  const filtered = useMemo(() => {
    const matched = profiles.filter((p) => {
      if (group !== "all" && p.group !== group) return false;
      if (q) {
        const needle = q.toLowerCase();
        const no = numbering.get(p.id)?.value ?? "";
        if (
          !p.id.toLowerCase().includes(needle) &&
          !p.name.toLowerCase().includes(needle) &&
          !no.includes(needle)
        ) return false;
      }
      return true;
    });
    // Running profiles stay on top regardless of the chosen column: an open
    // browser is the row an operator acts on next.
    return matched.sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      const left = sortField(a, sort.key);
      const right = sortField(b, sort.key);
      if (left < right) return -sort.dir;
      if (left > right) return sort.dir;
      return a.id.localeCompare(b.id);
    });
  }, [profiles, group, q, sort, numbering]);

  const profilePageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visibleProfilePage = Math.min(profilePage, profilePageCount - 1);
  const visibleProfiles = filtered.slice(visibleProfilePage * pageSize, (visibleProfilePage + 1) * pageSize);
  useEffect(() => setProfilePage(0), [q, group, pageSize]);

  const editSerial = editId ? profiles.find((profile) => profile.id === editId)?.serial ?? null : null;
  const editRunning = editId ? profiles.find((profile) => profile.id === editId)?.running === true : false;
  const createHasProxy = !!(form.host.trim() || form.port.trim() || form.user.trim() || form.pass);
  const editHasProxy = !!(editForm.proxy ?? "").trim();

  const pastedRecordCount = bulkText.trim() ? countPastedRecords(bulkText) : null;

  const colsRef = useDismiss<HTMLDivElement>(colsOpen, () => setColsOpen(false));
  const nodesRef = useDismiss<HTMLDivElement>(nodesOpen, () => setNodesOpen(false));
  const exportRef = useDismiss<HTMLDivElement>(exportOpen, () => setExportOpen(false));

  const columnVisible = (key: ColumnKey) => !hiddenCols.has(key);
  const toggleColumn = (key: ColumnKey) =>
    setHiddenCols((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeSetting(HIDDEN_COLUMNS_KEY, JSON.stringify([...next]));
      return next;
    });
  const applyPageSize = (size: number) => { setPageSize(size); writeSetting(PAGE_SIZE_KEY, String(size)); };
  const chooseTheme = (choice: ThemeChoice) => {
    setTheme(choice);
    writeSetting(THEME_KEY, choice);
    try { document.cookie = themeCookie(choice); } catch {}
  };
  const toggleSidebar = () =>
    setSidebarCollapsed((collapsed) => {
      writeSetting(SIDEBAR_KEY, collapsed ? "0" : "1");
      return !collapsed;
    });
  const toggleSort = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const refreshRoster = async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  };
  useEffect(() => {
    if (profilePage !== visibleProfilePage) setProfilePage(visibleProfilePage);
  }, [profilePage, visibleProfilePage]);

  const runningCount = profiles.filter((p) => p.running).length;
  const selectedMobileCount = profiles.filter((p) => selected.has(p.id) && p.mobilePersona).length;
  const existingGroups = groups.slice(1); // drop the "all" pseudo-group
  const editableGroups = isCloudMode
    ? (team?.folders.filter((folder) => folder.permission === "edit" && !folder.archivedAt).map((folder) => folder.name) ??
      existingGroups.filter((name) => profiles.some((profile) => profile.group === name && profile.permission === "edit")))
    : existingGroups;
  const selectedEditable = [...selected].every((id) => profiles.find((profile) => profile.id === id)?.permission === "edit");
  const selectedProfilesSupportChromeExtensions = [...selected].every((id) =>
    profiles.find((profile) => profile.id === id)?.engine === "chromium");
  const countFor = (g: string) => profiles.filter((p) => p.group === g).length;
  const canEditGroup = (name: string) => !isCloudMode ||
    team?.folders.some((folder) => folder.name === name && folder.permission === "edit" && !folder.archivedAt) === true ||
    profiles.some((profile) => profile.group === name && profile.permission === "edit");
  const editableDefaultGroups = groupExtensionDefaults.filter((item) => item.permission === "edit");
  const installedExtensionIds = new Set(extensions.map((item) => item.id));
  const storedGroupDefaultExts = groupExtensionDefaults.find((item) => item.name === groupDefaultName)?.extensions ?? [];
  const editExtensionChoices = [
    ...extensions.map((item) => ({ ...item, missing: false })),
    ...[...new Set([...editInitialExts, ...editExts])]
      .filter((id) => !installedExtensionIds.has(id))
      .map((id) => ({ id, name: id, missing: true })),
  ];
  const groupDefaultExtensionChoices = [
    ...extensions.map((item) => ({ ...item, missing: false })),
    ...[...new Set([...storedGroupDefaultExts, ...groupDefaultExts])]
      .filter((id) => !installedExtensionIds.has(id))
      .map((id) => ({ id, name: id, missing: true })),
  ];
  const groupDefaultProfileCount = profiles.filter((profile) => profile.group === groupDefaultName).length;

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allVisibleSelected = visibleProfiles.length > 0 && visibleProfiles.every((p) => selected.has(p.id));
  const selectedFilteredCount = filtered.filter((p) => selected.has(p.id)).length;
  const selectedOutsideFilter = selected.size - selectedFilteredCount;
  const allFilteredSelected = filtered.length > 0 && selectedFilteredCount === filtered.length && selectedOutsideFilter === 0;
  const selectionScope = `${filtered.length.toLocaleString()} 个${q ? "匹配的资料" : "资料"}${group === "all" ? "" : `，位于“${group}”`}`;
  const selectAllFiltered = () => setSelected(new Set(filtered.map((p) => p.id)));
  const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s);
      if (allVisibleSelected) visibleProfiles.forEach((p) => n.delete(p.id));
      else visibleProfiles.forEach((p) => n.add(p.id));
      return n;
    });

  const moveSelected = async () => {
    const ids = [...selected];
    const group = newMode ? newGroup.trim() : moveTarget;
    if (ids.length === 0 || !group) return;
    setActionErr(null);
    try {
      if (isCloudMode && newMode) await cloudWorkspaceAction("create-folder", { name: group });
      const r = await moveProfiles(ids, group);
      if (r.ok === false) {
        setActionErr(r.error || "移动失败");
        return;
      }
      setSelected(new Set());
      setNewMode(false);
      setNewGroup("");
      setMoveTarget("");
      await load();
    } catch (e) {
      setActionErr(String(e));
    }
  };

  const deleteSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0 || deleteInFlight.current) return;
    if (!confirm(appMode?.legacyRemote
      ? `确定删除 ${ids.length} 个资料吗？资料及其已保存会话会从列表中移除，且无法撤销。`
      : `确定将选中的 ${ids.length.toLocaleString()} 个资料全部移至回收站吗？这包括所有已选择的页面，之后可连同已保存数据一起恢复。`)) return;
    deleteInFlight.current = true;
    setDeleting(true);
    setActionErr(null);
    const generation = authGeneration.current;
    try {
      const r = await deleteProfiles(ids);
      if (generation !== authGeneration.current) return;
      if (r.ok === false) {
        setActionErr(r.error || "删除失败");
        return;
      }
      const problems = [
        r.locked?.length && `${r.locked.length} 个正在使用，未删除`,
        r.failed?.length && `${r.failed.length} 个失败`,
      ].filter(Boolean);
      if (problems.length) setActionErr(`${problems.join("；")}。这些资料仍保持选中。`);
      setSelected(new Set([...(r.locked ?? []), ...(r.failed ?? [])]));
      flash(`${r.deleted.toLocaleString()} 个资料已${appMode?.legacyRemote ? "删除" : "移至回收站"}`);
      await load();
    } catch (e) {
      if (generation === authGeneration.current) setActionErr(String(e));
    } finally {
      deleteInFlight.current = false;
      setDeleting(false);
    }
  };

  const act = async (id: string, fn: (id: string) => Promise<any>) => {
    setActionErr(null);
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const r = await fn(id);
      await load(); // refresh first; load() no longer clears action errors
      if (r && r.ok === false) setActionErr(r.error || "操作失败");
      else if (r && r.warning) setActionErr(r.warning);
    } catch (e) {
      await load().catch(() => {});
      setActionErr(String(e));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  /**
   * A session Cloud refused is kept encrypted here. Restoring writes it back as
   * the profile's current session, replacing the logins Cloud holds now.
   */
  const restoreSession = (profile: UiProfile) => {
    const savedAt = profile.parkedSession
      ? new Date(profile.parkedSession.savedAt).toLocaleString()
      : "";
    if (!confirm(
      `确定恢复此设备上为 ${profile.name} 保存的会话吗？（${savedAt}）\n\n` +
      "该会话的 Cookie 和登录状态会替换此资料在 Cloud 中的对应数据，" +
      "其他内容仍保留当前 Cloud 值。",
    )) return;
    void act(profile.id, restoreParkedSession);
  };

  const openCookie = (profile: UiProfile) => {
    setCookieProfile(profile);
    setCookieForm({ ...BLANK_COOKIE_FORM, domain: profile.platform });
    setCookieErr(null);
  };
  const closeCookie = () => {
    setCookieProfile(null);
    setCookieForm(BLANK_COOKIE_FORM);
    setCookieErr(null);
  };
  const setCookieField = (key: keyof typeof BLANK_COOKIE_FORM, value: string) =>
    setCookieForm((current) => ({ ...current, [key]: value }));
  const submitCookie = async () => {
    if (!cookieProfile) return;
    setCookieSaving(true);
    setCookieErr(null);
    try {
      const result = await addProfileCookie(cookieProfile.id, cookieForm);
      if (result.ok !== true) {
        setCookieErr(result.error || "无法添加 Cookie。");
        return;
      }
      closeCookie();
      flash("Cookie 已添加到打开的浏览器。");
    } catch (error) {
      setCookieErr(error instanceof Error ? error.message : "无法添加 Cookie。");
    } finally {
      setCookieSaving(false);
    }
  };

  const doUpload = async (files: FileList | File[]) => {
    setActionErr(null);
    try {
      const list = Array.from(files);
      if (list.length === 0) return;
      const r = await uploadExports(list);
      await load();
      if (r.ok) {
        const issues = r.errors?.length ? ` 发现 ${r.errors.length} 条无效记录；无效代理已隔离，等待修复。` : "";
        alert(`已从 ${r.files} 个文件导入 ${r.profiles} 个资料。${issues}`);
      }
      else setActionErr(r.error || "导入失败");
    } catch (e) {
      setActionErr(String(e));
    }
  };

  // ---- Bulk add accounts from provider export files or AdsPower text ----
  const openBulk = () => {
    setBulkFiles([]);
    setBulkText("");
    setBulkGroup(group !== "all" && (!isCloudMode || editableGroups.includes(group)) ? group : "");
    setBulkPlatform("");
    setBulkErr(null);
    setBulkSource("file");
    setShowBulk(true);
  };
  const closeBulk = () => {
    setShowBulk(false);
    setBulkFiles([]);
    setBulkText("");
    setBulkErr(null);
  };
  const submitBulk = async () => {
    if ((!bulkFiles.length && !bulkText.trim()) || (isCloudMode && !bulkGroup.trim())) return;
    setBulkBusy(true);
    setBulkErr(null);
    try {
      const uploads = [...bulkFiles];
      if (bulkText.trim()) uploads.push(new File([bulkText], "pasted-adspower.txt", { type: "text/plain" }));
      if (!uploads.length) throw new Error("文件中没有找到记录");
      const r = await uploadExports(uploads, { group: bulkGroup.trim(), platform: bulkPlatform });
      if (r.ok) {
        closeBulk();
        await load();
        const issues = r.errors?.length ? ` 发现 ${r.errors.length} 条无效记录；无效代理已隔离，等待修复。` : "";
        alert(`已从 ${r.files} 个文件导入 ${r.profiles} 个资料。${issues}`);
      }
      else setBulkErr(r.error || "导入失败");
    } catch (e) {
      setBulkErr(String(e));
    } finally {
      setBulkBusy(false);
    }
  };

  const resetCreateProxyCheck = () => {
    createProxyCheckGeneration.current++;
    setCreateProxyCheck(EMPTY_PROXY_CHECK);
  };
  const setF = (k: keyof typeof BLANK_FORM, v: string) => {
    if (k === "proxyType" || k === "host" || k === "port" || k === "user" || k === "pass") {
      resetCreateProxyCheck();
    }
    setForm((f) => ({ ...f, [k]: v }));
  };
  // Open prefilled with the folder you're browsing; close always resets so a
  // cancelled draft never leaks into the next open.
  const openCreate = () => {
    resetCreateProxyCheck();
    setForm({ ...BLANK_FORM, group: group !== "all" && (!isCloudMode || editableGroups.includes(group)) ? group : "" });
    setProxyPaste("");
    setProxyPasteOk(null);
    setCreateErr(null);
    setShowCreate(true);
  };
  const closeCreate = () => {
    resetCreateProxyCheck();
    setShowCreate(false);
    setForm(BLANK_FORM);
    setProxyPaste("");
    setProxyPasteOk(null);
    setCreateErr(null);
  };
  const applyProxyPaste = (raw: string) => {
    try {
      const parsed = parsePastedProxy(raw, form.proxyType === "socks5" ? "socks5" : "http");
      resetCreateProxyCheck();
      setForm((current) => ({
        ...current,
        proxyType: parsed.type,
        host: parsed.host,
        port: parsed.port,
        user: parsed.user,
        pass: parsed.pass,
      }));
      setProxyPaste("");
      setProxyPasteOk(`✓ 已填入 ${parsed.type.toUpperCase()} 代理字段`);
      setCreateErr(null);
    } catch (error) {
      setProxyPasteOk(null);
      setCreateErr(error instanceof Error ? error.message : String(error));
    }
  };
  const checkCreateProxy = async () => {
    const generation = ++createProxyCheckGeneration.current;
    if (form.proxyType === "https") {
      setCreateProxyCheck({ checking: false, result: null, error: "unavailable" });
      return;
    }
    setCreateProxyCheck({ checking: true, result: null, error: null });
    const proxy: ProxyCheckInput = {
      type: form.proxyType,
      host: form.host,
      port: form.port,
      user: form.user,
      pass: form.pass,
    };
    try {
      const result = await checkProxy(proxy);
      if (generation === createProxyCheckGeneration.current) {
        setCreateProxyCheck({ checking: false, result, error: null });
      }
    } catch (error) {
      if (generation === createProxyCheckGeneration.current) {
        setCreateProxyCheck({
          checking: false,
          result: null,
          error: error instanceof ProxyCheckError ? error.kind : "unavailable",
        });
      }
    }
  };
  const submitCreate = async () => {
    setCreating(true);
    setCreateErr(null);
    try {
      const cookies = form.cookies.trim() ? JSON.parse(form.cookies) : [];
      if (!Array.isArray(cookies)) throw new Error("Cookie 必须是 JSON 数组");
      const r = await createProfile({
        name: form.name,
        engine: form.engine,
        group: form.group,
        platform: form.platform,
        startupUrl: form.startupUrl,
        note: form.note,
        tags: form.tags,
        cookies,
        screen: form.screen,
        ...(isCloudMode ? {} : { customNo: form.customNo }),
        username: form.username,
        password: form.password,
        email: form.email,
        emailPassword: form.emailPassword,
        twofa: form.twofa,
        timezone: form.timezone,
        locale: (form as Record<string, string>).fpLocale,
        languages: splitFingerprintList((form as Record<string, string>).fpLanguages ?? "") ?? [],
        fingerprint: form.engine === "chromium" ? fingerprintInput(form) : undefined,
        proxy: form.host.trim() ? { type: form.proxyType, host: form.host, port: form.port, user: form.user, pass: form.pass } : null,
      });
      if (r.ok) {
        closeCreate();
        await load();
      } else {
        setCreateErr(r.error || "创建失败"); // shown inside the modal
      }
    } catch (e) {
      setCreateErr(String(e));
    } finally {
      setCreating(false);
    }
  };

  // ---- Edit one profile (full detail) ----
  const resetEditProxyCheck = () => {
    editProxyCheckGeneration.current++;
    setEditProxyCheck(EMPTY_PROXY_CHECK);
  };
  const setEF = (k: string, v: string) => {
    if (k === "proxy" || k === "proxyType") resetEditProxyCheck();
    setEditForm((f) => ({ ...f, [k]: v }));
  };
  // The dialog opens on the click; the detail fetch fills it in when it lands.
  // The ref discards a stale response if the operator has moved on meanwhile.
  const openEdit = (id: string) => {
    resetEditProxyCheck();
    setActionErr(null);
    editFetchId.current = id;
    setEditId(id);
    setEditForm({});
    setEditExts([]);
    setEditInitialExts([]);
    setEditMobile(null);
    setEditExpectedVersion(null);
    setEditLive(false);
    setEditEngine("chromium");
    setTimezoneBusy(false);
    setEditErr(null);
    setEditLoading(true);
    void (async () => {
      try {
        const p: EditProfile = await fetchProfileEdit(id);
        if (editFetchId.current !== id) return;
        setEditForm({
          name: p.name, group: p.group, platform: p.platform,
          startupUrl: p.startupUrl, note: p.note,
          proxyType: p.proxyType || "http", proxy: p.proxy,
          proxyError: p.proxyError ?? "",
          username: p.username, password: p.password,
          email: p.email, emailPassword: p.emailPassword, twofa: p.twofa,
          resolution: p.resolution, tags: p.tags,
          customNo: p.customNo ?? "",
          timezone: p.timezone,
          ...fingerprintFormFields(p.fingerprint),
          fpLocale: p.locale,
          fpLanguages: p.languages.join(", "),
        });
        setEditEngine(p.engine === "firefox" ? "firefox" : "chromium");
        setEditExts(p.extensions ?? []);
        setEditInitialExts(p.extensions ?? []);
        setEditMobile(p.desktopConversion ?? null);
        setEditExpectedVersion(p.expectedVersion ?? null);
        setEditLive(p.liveEdit === true);
      } catch (e) {
        if (editFetchId.current === id) setEditErr(String(e));
      } finally {
        if (editFetchId.current === id) setEditLoading(false);
      }
    })();
  };
  const closeEdit = () => {
    resetEditProxyCheck();
    editFetchId.current = null;
    setEditId(null);
    setEditExpectedVersion(null);
    setEditLive(false);
    setEditEngine("chromium");
    setTimezoneBusy(false);
    setEditLoading(false);
    setEditForm({});
    setEditExts([]);
    setEditInitialExts([]);
    setEditErr(null);
    setEditMobile(null);
  };
  const checkEditedProxy = async () => {
    const generation = ++editProxyCheckGeneration.current;
    const value = editForm.proxy ?? "";
    if (editForm.proxyType === "https" || /^\s*https:\/\//i.test(value)) {
      setEditProxyCheck({ checking: false, result: null, error: "unavailable" });
      return;
    }
    setEditProxyCheck({ checking: true, result: null, error: null });
    let proxy: ProxyCheckInput;
    try {
      proxy = parsePastedProxy(value, editForm.proxyType === "socks5" ? "socks5" : "http");
    } catch {
      if (generation === editProxyCheckGeneration.current) {
        setEditProxyCheck({ checking: false, result: null, error: "invalid" });
      }
      return;
    }
    try {
      const result = await checkProxy(proxy);
      if (generation === editProxyCheckGeneration.current) {
        setEditProxyCheck({ checking: false, result, error: null });
      }
    } catch (error) {
      if (generation === editProxyCheckGeneration.current) {
        setEditProxyCheck({
          checking: false,
          result: null,
          error: error instanceof ProxyCheckError ? error.kind : "unavailable",
        });
      }
    }
  };
  const refreshEditedTimezone = async () => {
    if (!editId || !editHasProxy) return;
    setTimezoneBusy(true);
    setEditErr(null);
    try {
      const { timezone, locale, languages } = await refreshProfileTimezone(editId);
      setEditForm((form) => ({ ...form, timezone, fpLocale: locale, fpLanguages: languages.join(", ") }));
    } catch (error) {
      setEditErr(error instanceof Error ? error.message : String(error));
    } finally {
      setTimezoneBusy(false);
    }
  };
  const saveEdit = async () => {
    if (!editId) return;
    setEditSaving(true);
    setEditErr(null);
    try {
      if (isCloudMode && !editLive && editExpectedVersion === null) throw new Error("Cloud 资料版本缺失，请关闭并重新打开编辑窗口");
      const r = await updateProfile(editId, {
        name: editForm.name ?? "", group: editForm.group ?? "", platform: editForm.platform ?? "",
        startupUrl: editForm.startupUrl ?? "", note: editForm.note ?? "",
        proxy: editForm.proxy ?? "", proxyType: editForm.proxyType ?? "http",
        username: editForm.username ?? "", password: editForm.password ?? "",
        email: editForm.email ?? "", emailPassword: editForm.emailPassword ?? "", twofa: editForm.twofa ?? "",
        resolution: editForm.resolution ?? "", tags: editForm.tags ?? "",
        ...(!isCloudMode ? {
          customNo: editForm.customNo ?? "",
          timezone: editForm.timezone ?? "",
          locale: editForm.fpLocale ?? "",
          languages: splitFingerprintList(editForm.fpLanguages ?? "") ?? [],
        } : {}),
        ...(!isCloudMode && editEngine === "chromium" ? { fingerprint: fingerprintInput(editForm) } : {}),
        ...(!sameExtensionSelection(editExts, editInitialExts) && editEngine === "chromium" ? { extensions: editExts } : {}),
      }, isCloudMode && !editLive ? editExpectedVersion ?? undefined : undefined);
      if (r.ok) { closeEdit(); await load(); }
      else if (r.status === 409) {
        const message = r.error || "Cloud 资料已更改，请重新打开编辑窗口后再保存";
        closeEdit();
        setActionErr(message);
      } else setEditErr(r.error || "保存失败");
    } catch (e) {
      setEditErr(String(e));
    } finally {
      setEditSaving(false);
    }
  };
  const convertEditedMobile = async () => {
    if (!editId || !editMobile) return;
    const platform = editMobile.platform === "macos" ? "macOS" : "Windows";
    const screenNote = editMobile.screenChanged ? ` 移动端屏幕尺寸将改为 ${editMobile.resolution}。` : " 将保留现有的桌面屏幕尺寸。";
    if (!confirm(
      `确定将导入的移动端身份转换为稳定的 ${platform} 桌面身份吗？\n\n` +
      `Cookie、登录/会话、凭据、代理、时区、指纹种子、标签和扩展都会保留。${screenNote}\n\n` +
      "网站可能会将首次启动识别为新桌面设备并要求验证。此窗口中其他未保存的修改不会包含在内。",
    )) return;
    setEditSaving(true);
    setEditErr(null);
    try {
      const r = await convertMobileProfile(editId);
      if (!r.ok) { setEditErr(r.error || "转换失败"); return; }
      closeEdit();
      await load();
      flash(`资料已转换为稳定的 ${platform} 桌面身份`);
    } catch (e) {
      setEditErr(String(e));
    } finally {
      setEditSaving(false);
    }
  };

  // ---- Extensions manager (Store URL / upload / delete) ----
  const reloadExtensions = async () => { try { setExtensions(await fetchExtensions()); } catch {} };
  const toggleGroupDefaultExt = (id: string) =>
    setGroupDefaultExts((ids) => (ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]));
  const applyGroupExtensionDefault = async () => {
    if (!groupDefaultName) return;
    if (!confirm(
      `确定将此扩展默认值应用到“${groupDefaultName}”吗？\n\n` +
      `这会替换当前 ${groupDefaultProfileCount} 个资料的扩展分配。` +
      "新建和移入的资料会继承此选择，之后仍可单独修改资料。" +
      "请重新打开浏览器以应用更改。",
    )) return;
    setGroupDefaultBusy(true);
    setExtErr(null);
    try {
      const result = await setGroupExtensionDefaults(groupDefaultName, groupDefaultExts);
      if (result.ok === false) { setExtErr(result.error || "分组默认值更新失败"); return; }
      await Promise.all([reloadGroupExtensionDefaults(), load()]);
      flash(`已更新“${groupDefaultName}”中 ${result.updatedCount} 个资料的扩展默认值`);
    } catch (error) {
      setExtErr(error instanceof Error ? error.message : String(error));
    } finally {
      setGroupDefaultBusy(false);
    }
  };
  const doInstallWebStoreExtension = async () => {
    const source = extSource.trim();
    if (!source) { setExtErr("请粘贴 Chrome 应用商店 URL 或扩展 ID"); return; }
    setExtInstallBusy(true);
    setExtErr(null);
    try {
      const r = await installWebStoreExtension(source);
      if (!r.ok) { setExtErr(r.error || "安装失败"); return; }
      setExtSource("");
      await reloadExtensions();
      flash(r.alreadyInstalled ? `${r.installed.name} 已安装` : `已安装 ${r.installed.name}`);
    } catch (e) {
      setExtErr(String(e));
    } finally {
      setExtInstallBusy(false);
    }
  };
  const doUploadExtensions = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setExtBusy(true);
    setExtErr(null);
    try {
      const r = await uploadExtensions(list);
      if (!r.ok) setExtErr(r.error || "上传失败");
      await reloadExtensions();
    } catch (e) {
      setExtErr(String(e));
    } finally {
      setExtBusy(false);
    }
  };
  const doRemoveExtension = async (id: string, name: string) => {
    const message = isCloudMode
      ? `确定从此设备移除扩展“${name}”吗？Cloud 分配会保留，并在此处显示为未安装。`
      : `确定移除扩展“${name}”吗？它将从所有资料中取消分配。`;
    if (!confirm(message)) return;
    setExtErr(null);
    try {
      const r = await removeExtension(id);
      if (!r.ok) setExtErr(r.error || "移除失败");
      setEditExts((xs) => xs.filter((x) => x !== id));
      await Promise.all([reloadExtensions(), reloadGroupExtensionDefaults()]);
    } catch (e) {
      setExtErr(String(e));
    }
  };
  const toggleEditExt = (id: string) =>
    setEditExts((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const bulkAssignExt = async (op: "add" | "remove") => {
    const ids = [...selected];
    if (!ids.length || !bulkExt) return;
    setActionErr(null);
    try {
      const r = await assignExtensionBulk(ids, bulkExt, op);
      if (r.ok === false) { setActionErr(r.error || "扩展分配失败"); return; }
      await load();
      const name = extensions.find((x) => x.id === bulkExt)?.name ?? "扩展";
      flash(`已为 ${r.updated} 个资料${op === "add" ? "添加" : "移除"}“${name}”`);
    } catch (e) {
      setActionErr(String(e));
    }
  };

  // ---- 2FA quick-copy (row authenticator button) ----
  const copy2fa = async (id: string) => {
    setActionErr(null);
    try {
      const r = await fetchTotp(id);
      if (!r.code) { setActionErr("此资料没有 2FA 密钥"); return; }
      try { await navigator.clipboard.writeText(r.code); } catch {}
      setTwoFaFlash({ id, code: r.code });
      setTimeout(() => setTwoFaFlash((f) => (f && f.id === id ? null : f)), 4000);
    } catch (e) {
      setActionErr(String(e));
    }
  };

  // ---- Bulk open / close (bounded concurrency) ----
  const bulkRun = async (op: (id: string) => Promise<any>, pick: (p: UiProfile) => boolean) => {
    const ids = [...selected].filter((id) => { const p = profiles.find((x) => x.id === id); return p && pick(p); });
    if (!ids.length) return;
    setActionErr(null);
    setBusy((b) => { const n = { ...b }; ids.forEach((id) => (n[id] = true)); return n; });
    const issues: string[] = [];
    await runPool(ids, 4, async (id) => {
      try {
        const r = await op(id);
        if (r?.ok === false) issues.push(`${id}：${r.error || "操作失败"}`);
        else if (r?.warning) issues.push(`${id}: ${r.warning}`);
      } catch (error) {
        issues.push(`${id}: ${String(error)}`);
      }
    });
    await load();
    setBusy((b) => { const n = { ...b }; ids.forEach((id) => delete n[id]); return n; });
    if (issues.length > 0) setActionErr(issues.join("; "));
  };
  const openSelected = () => bulkRun(openProfile, (p) => !p.running && !p.mobilePersona);
  const closeSelected = () => bulkRun(closeProfile, (p) => p.running);
  const convertSelectedMobile = async () => {
    const ids = [...selected].filter((id) => profiles.find((p) => p.id === id)?.mobilePersona);
    if (!ids.length) return;
    if (!confirm(
      `确定将选中的 ${ids.length} 个移动端身份转换为稳定的桌面身份吗？\n\n` +
      "账号数据、会话、代理、时区和指纹种子都会保留。Android 会沿用旧版 IDFRI 使用的 Windows 桌面系列，iPhone/iPad 会沿用 macOS。网站可能在首次启动时要求设备验证。",
    )) return;
    setActionErr(null);
    setBusy((b) => { const n = { ...b }; ids.forEach((id) => (n[id] = true)); return n; });
    const failed: string[] = [];
    await runPool(ids, 4, async (id) => {
      try {
        const r = await convertMobileProfile(id);
        if (!r.ok) failed.push(`${id}：${r.error || "转换失败"}`);
      } catch (e) {
        failed.push(`${id}: ${String(e)}`);
      }
    });
    await load().catch(() => {});
    setBusy((b) => { const n = { ...b }; ids.forEach((id) => delete n[id]); return n; });
    if (failed.length) setActionErr(`${ids.length - failed.length} 个已转换，${failed.length} 个失败 · ${failed.join("；")}`);
    else flash(`已将 ${ids.length} 个移动端身份转换为稳定的桌面身份`);
  };

  // ---- Export selected → file ----
  const exportSelected = async (format: ExportFormat) => {
    setExportOpen(false);
    if (!selected.size || exportProgress) return;
    const ids = [...selected];
    setActionErr(null);
    setExportProgress({ completed: 0, total: ids.length });
    try {
      await exportProfiles(ids, format, (progress) => setExportProgress(progress));
      flash(`已将 ${ids.length.toLocaleString()} 个资料导出为 ${format.toUpperCase()}`);
    } catch (e) {
      setActionErr(String(e));
    } finally {
      setExportProgress(null);
    }
  };

  // ---- Transient success banner ----
  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice((cur) => (cur === m ? null : cur)), 3500); };

  // ---- File-based bulk update (export → edit → re-upload, matched by id) ----
  const openUpdate = () => { setShowUpdate(true); setUpdateFile(null); setUpdateErr(null); setUpdateResult(null); };
  const submitUpdate = async () => {
    if (!updateFile) return;
    setUpdateBusy(true); setUpdateErr(null); setUpdateResult(null);
    try {
      const r = await updateFromFile([updateFile]);
      if (!r.ok) {
        setUpdateErr(r.errors?.length
          ? r.errors.map((item: { id: string; error: string }) => `${item.id}: ${item.error}`).join(" · ")
          : r.error || "更新失败");
        if (typeof r.updated !== "number") return;
      }
      let m = `已更新 ${r.updated} 个资料`;
      if (r.notFound?.length) m += ` · 文件中有 ${r.notFound.length} 个 ID 未匹配到资料`;
      if (r.skipped) m += ` · 已跳过 ${r.skipped} 行（没有 ID）`;
      setUpdateResult(m);
      await load();
    } catch (e) {
      setUpdateErr(String(e));
    } finally {
      setUpdateBusy(false);
    }
  };

  // ---- Group create / rename / delete ----
  const createSidebarGroup = async () => {
    const name = sidebarGroupName.trim();
    if (!name) return;
    if (name === "all") {
      setActionErr("此名称为保留名称。");
      return;
    }
    setActionErr(null);
    try {
      const result = isCloudMode
        ? await cloudWorkspaceAction("create-folder", { name })
        : await createGroup(name);
      if (result.ok === false) {
        setActionErr(result.error || "创建失败");
        return;
      }
      await Promise.all([load(), isCloudMode ? loadTeam() : Promise.resolve()]);
      setGroup(name);
      setSidebarGroupName("");
      setAddingGroup(false);
    } catch (error) {
      setActionErr(error instanceof Error ? error.message : String(error));
    }
  };
  const startRename = (g: string) => { setRenaming(g); setRenameVal(g); };
  const commitRename = async () => {
    const from = renaming, to = renameVal.trim();
    setRenaming(null);
    if (!from || !to || to === from) return;
    setActionErr(null);
    try {
      const r = await renameGroup(from, to);
      if (r.ok === false) setActionErr(r.error || "重命名失败");
      else {
        if (group === from) setGroup(to);
        await Promise.all([load(), isCloudMode ? loadTeam() : Promise.resolve()]);
      }
    } catch (e) {
      setActionErr(String(e));
    }
  };
  const removeGroup = async (g: string) => {
    const n = countFor(g);
    const prompt = isCloudMode
      ? `确定永久删除文件夹“${g}”吗？只有空文件夹可以删除。`
      : `确定删除分组“${g}”吗？${n ? `其中 ${n} 个资料会移至“未分组”，不会被删除。` : ""}`;
    if (!confirm(prompt)) return;
    setActionErr(null);
    try {
      const r = isCloudMode
        ? await cloudWorkspaceAction("delete-folder", { name: g })
        : await deleteGroup(g);
      if (r.ok === false) setActionErr(r.error || "删除失败");
      else {
        if (group === g) setGroup("all");
        await Promise.all([load(), isCloudMode ? loadTeam() : Promise.resolve()]);
      }
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    }
  };

  const desktopUpdateResultSummary = desktopUpdateResult
    ? describeDesktopUpdateResult(desktopUpdateResult)
    : null;

  if (!appMode || !workspaceReady || restartRequired) {
    return (
      <>
        <main className="onboarding">
        <section className="onboarding-card" aria-labelledby="onboarding-title">
          <div className="onboarding-brand"><BrandMark />IDFRI</div>
          {restartRequired ? (
            <>
              <h1 id="onboarding-title">本地模式已就绪</h1>
              <p>请退出并重新打开 IDFRI。</p>
              {modeErr && <div className="mode-error" role="alert">{modeErr}</div>}
              <button className="mode-primary" type="button" onClick={() => window.close()}>退出 IDFRI</button>
            </>
          ) : appMode?.mode === "cloud" ? (
            cloudAuth?.authenticated ? (
              <>
                <h1 id="onboarding-title">查看 Cloud 条款</h1>
                <p>同步此工作区前，请接受当前政策。</p>
                <div className="auth-actions">
                  <a href="https://aliasmode.com/terms/" target="_blank" rel="noreferrer">服务条款</a>
                  <a href="https://aliasmode.com/privacy/" target="_blank" rel="noreferrer">隐私政策</a>
                  <a href="https://aliasmode.com/acceptable-use/" target="_blank" rel="noreferrer">可接受使用政策</a>
                </div>
                {authErr && <div className="mode-error" role="alert">{authErr}</div>}
                <button
                  className="mode-primary"
                  type="button"
                  disabled={authBusy || !cloudAuth.legal}
                  onClick={() => void acceptCurrentLegal()}
                >
                  {authBusy ? "正在处理…" : cloudAuth.legal ? "接受并进入 Cloud" : "正在检查工作区…"}
                </button>
                {modeErr && <div className="mode-error" role="alert">{modeErr}</div>}
              </>
            ) : savedSessionPhase === "restoring" ? (
              <>
                <h1 id="onboarding-title">正在恢复已保存的会话</h1>
                <p role="status">正在检查此设备上保存的 Cloud 会话…</p>
              </>
            ) : savedSessionPhase === "retryable-failure" ? (
              <>
                <h1 id="onboarding-title">正在恢复已保存的会话</h1>
                <p>已保存的会话仍在此设备上，请恢复网络后重试。</p>
                {authErr && <div className="mode-error" role="alert">{authErr}</div>}
                <div className="auth-actions">
                  <button className="mode-primary" type="button" disabled={authBusy} onClick={() => void restoreSavedSession(true)}>重试</button>
                  <button className="mode-secondary" type="button" disabled={authBusy} onClick={() => void signInInstead()}>改为登录</button>
                </div>
              </>
            ) : (
              <>
                <h1 id="onboarding-title">{authView === "signin" ? "登录 IDFRI Cloud" : "创建 Cloud 账号"}</h1>
                <p>已验证的账号可在授权设备间同步可移植资料。</p>
                <form className="auth-form" onSubmit={(event) => { event.preventDefault(); void submitCloudAuth(); }}>
                  <label>邮箱<input type="email" autoComplete="email" required value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} /></label>
                  <label>密码<input type="password" autoComplete={authView === "signin" ? "current-password" : "new-password"} required value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} /></label>
                  {authErr && <div className="mode-error" role="alert">{authErr}</div>}
                  {authNotice && <div className="auth-notice" role="status">{authNotice}</div>}
                  {confirmationEmail && (
                    <button type="button" className="mode-secondary" disabled={authBusy} onClick={() => void resendConfirmation()}>
                      Resend confirmation
                    </button>
                  )}
                  <button className="mode-primary" type="submit" disabled={authBusy}>{authBusy ? "正在处理…" : authView === "signin" ? "登录" : "创建账号"}</button>
                </form>
                <div className="auth-actions">
                  <button type="button" onClick={() => { setAuthErr(null); setAuthNotice(null); setAuthView(authView === "signin" ? "signup" : "signin"); }}>
                    {authView === "signin" ? "创建账号" : "返回登录"}
                  </button>
                </div>
                {modeErr && <div className="mode-error" role="alert">{modeErr}</div>}
              </>
            )
          ) : appMode ? (
            <>
              <h1 id="onboarding-title">开始使用 IDFRI</h1>
              <p>本版本仅在本机保存浏览器资料，不使用云端服务。</p>
              <div className="mode-options">
                <button className="mode-option primary" type="button" disabled={modeBusy} onClick={() => chooseMode("local")}>
                  <span className="badge"><Icon name="laptop" className="lg" /></span>
                  <strong>IDFRI 本地版</strong>
                  <span>无需账号，资料仅保存在这台电脑上，默认关闭分析统计。</span>
                </button>
              </div>
              {modeErr && <div className="mode-error" role="alert">{modeErr}</div>}
            </>
          ) : (
            <>
              <h1 id="onboarding-title">正在启动 IDFRI</h1>
              <p>{connErr ?? "正在加载本地配置…"}</p>
              {connErr && <button className="mode-primary" type="button" onClick={() => window.location.reload()}>重试</button>}
            </>
          )}
          </section>
        </main>
      </>
    );
  }

  const diagWhen = diag ? new Date(diag.generatedAt).toLocaleTimeString() : null;
  const shownColumns = COLUMNS.filter((column) => columnVisible(column.key));
  const visibleColumnCount = 1 + shownColumns.length;
  // Sum of what is actually on screen: below this the wrapper scrolls rather
  // than letting the browser crush Name down to "mia.h…".
  const tableMinWidth = CHECKBOX_COLUMN_WIDTH + shownColumns.reduce((total, column) => total + column.width, 0);
  const columnHead = (column: (typeof COLUMNS)[number]) => {
    // The Action column carries no header text: its buttons explain themselves,
    // and a floating "ACTION" label over a right-aligned cluster read as an
    // empty column. The column chooser still lists it by its registry label.
    const label = column.key === "action" ? "" : column.key === "group" && isCloudMode ? "文件夹" : column.label;
    // Every column declares its width, so a wide window's extra space spreads
    // proportionally across all of them — an even layout, no dead gap.
    const style = { width: column.width } as CSSProperties;
    if (!column.sort) return <th key={column.key} className={`col-${column.key}`} style={style}>{label}</th>;
    const key = column.key as SortKey;
    return (
      <th
        key={column.key}
        className={`col-${column.key} sortable${sort.key === key ? " sorted" : ""}`}
        style={style}
        aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
        onClick={() => toggleSort(key)}
      >
        <span className="th-inner">
          {label}
          <Icon className="sortglyph sm" name={sort.key === key ? (sort.dir === 1 ? "sortUp" : "sortDown") : "sort"} />
        </span>
      </th>
    );
  };

  return (
    <div
      className="app"
      onDragOver={(e) => { e.preventDefault(); if (isCloudMode) return; if (!dragging) setDragging(true); }}
      onDragLeave={(e) => { e.preventDefault(); if (isCloudMode) return; if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => {
        e.preventDefault();
        if (isCloudMode) return;
        setDragging(false);
        if (e.dataTransfer.files?.length) doUpload(e.dataTransfer.files);
      }}
    >
      {!isCloudMode && dragging && (
        <div className="dropzone">
          <Icon name="fileImport" />
          <span>拖放 TXT、CSV、JSON 或 XLSX 文件以导入资料</span>
        </div>
      )}

      <aside className={`sidebar${sidebarCollapsed || railForced ? " collapsed" : ""}`}>
        {/* A too-narrow window forces the rail; the toggle would be a no-op. */}
        {!railForced && (
          <button
            type="button"
            className="rail-toggle tip"
            data-tip={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            aria-expanded={!sidebarCollapsed}
            onClick={toggleSidebar}
          >
            <Icon name={sidebarCollapsed ? "chevronRight" : "chevronLeft"} className="sm" />
          </button>
        )}
        <div className="brandrow">
          <div className="brand"><BrandMark />IDFRI</div>
          {appVersion && <span className="appversion" title={appVersion}>{appVersion}</span>}
        </div>
        <div className="newrow">
          <button className="btn primary newbtn" data-tip="新建资料" title="新建资料" disabled={!canEditCloud} onClick={openCreate}>
            <Icon name="plus" /><span className="navlabel">新建资料</span>
          </button>
          <button
            className="btn importbtn tip"
            data-tip="从文件导入"
            disabled={!canEditCloud}
            title="从 TXT、CSV、JSON 或 XLSX 导入资料"
            onClick={openBulk}
          ><Icon name="fileImport" /></button>
        </div>

        <nav className="sidenav" aria-label="功能导航">
          <button
            type="button"
            className={`navitem${view === "profiles" && group === "all" ? " active" : ""}`}
            data-tip="全部资料"
            title="全部资料"
            onClick={() => { setView("profiles"); setGroup("all"); }}
          >
            <Icon name="profiles" /><span className="navlabel">全部资料</span>
            <span className="cnt">{profiles.length}</span>
          </button>
          {!appMode?.legacyRemote && <>
            <button type="button" className={`navitem${view === "proxies" ? " active" : ""}`} data-tip="代理" title="代理" onClick={() => setView("proxies")}>
              <Icon name="activity" /><span className="navlabel">代理</span>
            </button>
            <button type="button" className={`navitem${view === "trash" ? " active" : ""}`} data-tip="回收站" title="回收站" onClick={() => setView("trash")}>
              <Icon name="trash" /><span className="navlabel">回收站</span>
            </button>
          </>}
          <button
            type="button"
            className={`navitem${view === "scripts" ? " active" : ""}`}
            data-tip="脚本"
            title="脚本"
            onClick={() => setView("scripts")}
          >
            <Icon name="file" /><span className="navlabel">脚本</span>
          </button>
          <button
            type="button"
            className={`navitem${view === "extensions" ? " active" : ""}`}
            data-tip="扩展管理"
            title="扩展管理"
            onClick={() => { setExtErr(null); setView("extensions"); }}
          >
            <Icon name="puzzle" /><span className="navlabel">扩展管理</span>
            {extensions.length > 0 && <span className="cnt">{extensions.length}</span>}
          </button>
          <button
            type="button"
            className="navitem"
            title="查看详细日志"
            onClick={() => {
              setLogErr(null);
              setLogView(null);
              fetchLogs().then(setLogView).catch((e) => setLogErr(e instanceof Error ? e.message : String(e)));
            }}
          ><Icon name="logs" /><span className="navlabel">日志</span></button>
        </nav>

        <div className="sidesection">
          <button className="sidehead" onClick={() => setGroupsOpen((o) => !o)}>
            <span className={`chev${groupsOpen ? " open" : ""}`}><Icon name="chevronRight" className="sm" /></span>
            <span>{isCloudMode ? "文件夹" : "分组"}</span>
            <span className="grow" />
            <span className="cnt">{existingGroups.length}</span>
          </button>
          {groupsOpen && <>
            <div className="folders">
            {existingGroups.length === 0 && <div className="folders-empty">暂无{isCloudMode ? "文件夹" : "分组"}</div>}
            {existingGroups.map((g) => (
              <div
                key={g}
                className={`folder${view === "profiles" && group === g ? " active" : ""}`}
                onClick={() => { if (renaming !== g) { setView("profiles"); setGroup(g); } }}
              >
                {renaming === g ? (
                  <input
                    className="renameinput"
                    autoFocus
                    value={renameVal}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") commitRename(); else if (e.key === "Escape") setRenaming(null); }}
                    onBlur={commitRename}
                  />
                ) : (
                  <>
                    <Icon name="folder" className="sm" />
                    <span className="fname" title={g}>{g}</span>
                    {(canEditGroup(g) || (isCloudMode && canManageCloudFolders)) && (
                      <span className="gactions">
                        {canEditGroup(g) && (
                          <button title={isCloudMode ? "重命名文件夹" : "重命名分组"} onClick={(e) => { e.stopPropagation(); startRename(g); }}>
                            <Icon name="edit" className="sm" />
                          </button>
                        )}
                        {(!isCloudMode || canManageCloudFolders) && (
                          <button className="danger" title={isCloudMode ? "删除文件夹" : "删除分组"} onClick={(e) => { e.stopPropagation(); removeGroup(g); }}>
                            <Icon name="trash" className="sm" />
                          </button>
                        )}
                      </span>
                    )}
                    <span className="cnt">{countFor(g)}</span>
                  </>
                )}
              </div>
            ))}
            </div>
            {addingGroup ? (
              <div className="newgroup">
                <input
                  autoFocus
                  aria-label={isCloudMode ? "新文件夹名称" : "新分组名称"}
                  value={sidebarGroupName}
                  onChange={(event) => setSidebarGroupName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void createSidebarGroup();
                    else if (event.key === "Escape") { setAddingGroup(false); setSidebarGroupName(""); }
                  }}
                />
                <button type="button" title="创建" onClick={() => void createSidebarGroup()}><Icon name="check" className="sm" /></button>
                <button type="button" title="取消" onClick={() => { setAddingGroup(false); setSidebarGroupName(""); }}><Icon name="close" className="sm" /></button>
              </div>
            ) : (
              <button className="newgroup" type="button" disabled={!canEditCloud} onClick={() => setAddingGroup(true)}>
                <Icon name="plus" className="sm" />{isCloudMode ? "新建文件夹" : "新建分组"}
              </button>
            )}
          </>}
        </div>

        <div className="sidefoot">
          <a className="navitem" href="https://github.com/16188/idfri/issues" target="_blank" rel="noreferrer" data-tip="支持" title="IDFRI GitHub Issues">
            <Icon name="help" /><span className="navlabel">支持</span>
          </a>
          <button type="button" className={`navitem${view === "settings" ? " active" : ""}`} data-tip="设置" title="设置" onClick={openAccountSettings}>
            <Icon name="settings" /><span className="navlabel">设置</span>
          </button>
          <div className="sidecredit">
            <span className="watermark">
              开发者
              <a href="https://github.com/16188/idfri" target="_blank" rel="noreferrer" title="IDFRI GitHub">IDFRI</a>
            </span>
            <div className="projectlinks">
              {PROJECT_LINKS.map((link) => (
                <a
                  key={link.label}
                  className="projectlink tip"
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  data-tip={link.label}
                  aria-label={`IDFRI 的 ${link.label}`}
                >
                  <svg className="brandmark" viewBox="0 0 24 24" aria-hidden="true"><path d={link.path} /></svg>
                </a>
              ))}
            </div>
            <p className="footer-mark" aria-hidden="true">IDFRI</p>
          </div>
        </div>
        {modeErr && <div className="mode-error" role="alert">{modeErr}</div>}
      </aside>

      <div className="main">
      <header className="pagehead">
        <h1>{PAGE_TITLES[view]}</h1>
        {view === "profiles" && (
          <span className="pagesub">
            {filtered.length === profiles.length ? `${profiles.length} total` : `${filtered.length} of ${profiles.length}`}
          </span>
        )}
        <span className="spacer" />
        <div className="headactions">
          {view === "profiles" && <>
          {/* Health snapshots are pushed by automation workers through the hub, so
              in Local mode this list is always empty (see ui.ts: the local roster
              returns healthSources: []). Show the control only when something
              actually reports, instead of a button that can only say "none". */}
          {healthSources.length > 0 && (
          <div className="menuwrap" ref={nodesRef}>
            <button
              type="button"
              className={`iconbtn tip${nodesOpen ? " on" : ""}`}
              data-tip="自动化节点"
              aria-label="自动化节点状态"
              onClick={() => setNodesOpen((o) => !o)}
            ><Icon name="activity" /></button>
            {nodesOpen && (
              <div className="popover below-right">
                <div className="pop-head">自动化节点</div>
                <HealthSources sources={healthSources} />
              </div>
            )}
          </div>
          )}
          <button
            type="button"
            className="iconbtn tip"
            data-tip="刷新"
            aria-label="刷新资料"
            disabled={refreshing}
            onClick={() => void refreshRoster()}
          ><Icon name="refresh" /></button>
          <div className="menuwrap" ref={colsRef}>
            <button
              type="button"
              className={`iconbtn tip${colsOpen ? " on" : ""}`}
              data-tip="列"
              aria-label="选择显示列"
              onClick={() => setColsOpen((o) => !o)}
            ><Icon name="columns" /></button>
            {colsOpen && (
              <div className="popover below-right">
                <div className="pop-head">显示列</div>
                {COLUMNS.map((column) => (
                  <label className="pop-item" key={column.key}>
                    <input type="checkbox" checked={columnVisible(column.key)} onChange={() => toggleColumn(column.key)} />
                    {column.label}
                  </label>
                ))}
              </div>
            )}
          </div>
          </>}
          <button
            className="account-button"
            type="button"
            aria-label="打开账号与设置"
            title="账号与设置"
            onClick={openAccountSettings}
          >
            <span className="avatar"><Icon name="user" /></span>
            <span className="who">
              <b>{isCloudMode ? cloudAuth?.user?.email ?? "Cloud 账号" : "本地工作区"}</b>
              <span>{isCloudMode ? cloudAuth?.workspace?.role === "owner" ? "所有者" : cloudAuth?.workspace?.role === "admin" ? "管理员" : "成员" : "无需账号"}</span>
            </span>
            <Icon name="chevronRight" className="sm" />
          </button>
        </div>
      </header>

      {(actionErr ?? connErr) && (
        <div className="error">
          <Icon name="alert" />
          <span>{actionErr ?? connErr}</span>
          <button className="dismiss" aria-label="关闭错误提示" onClick={() => { setActionErr(null); setConnErr(null); }}>
            <Icon name="close" className="sm" />
          </button>
        </div>
      )}
      {notice && (
        <div className="notice" role="status" onClick={() => setNotice(null)}>
          <Icon name="check" className="sm" />{notice}
        </div>
      )}
      {exportProgress && (
        <div className="notice" role="status">
          <Icon name="export" className="sm" />
          {exportProgress.completed >= exportProgress.total
            ? "正在生成导出文件…"
            : `正在准备导出：${exportProgress.completed.toLocaleString()} / ${exportProgress.total.toLocaleString()} 个资料`}
        </div>
      )}
      {desktopUpdateResultSummary && !desktopUpdateResultDismissed && (
        <div
          className={`update-banner update-result ${desktopUpdateResultSummary.tone}`}
          role={desktopUpdateResultSummary.tone === "success" ? "status" : "alert"}
        >
          <Icon name={desktopUpdateResultSummary.tone === "success" ? "check" : desktopUpdateResultSummary.tone === "warning" ? "warning" : "alert"} />
          <div className="update-copy">
            <strong>{desktopUpdateResultSummary.title}</strong>
            <span>{desktopUpdateResultSummary.detail}</span>
          </div>
          <button
            className="update-result-dismiss"
            type="button"
            aria-label="关闭更新结果"
            onClick={() => setDesktopUpdateResultDismissed(true)}
          >
            <Icon name="close" className="sm" />
          </button>
        </div>
      )}
      {desktopUpdate?.state === "available" && (
        <div className="update-banner">
          <Icon name="import" />
          <div className="update-copy">
            <span role="status"><strong>IDFRI {desktopUpdate.version} 可用。</strong>更新会保存并关闭活动浏览器，然后重启应用。</span>
            <UpdateHighlights version={desktopUpdate.version} highlights={desktopUpdate.highlights} />
            {desktopUpdateProgress && <DesktopUpdateProgressView progress={desktopUpdateProgress} />}
            {desktopUpdateErr && <span className="modal-err" role="alert">{desktopUpdateErr}</span>}
          </div>
          <button className="btn primary" type="button" disabled={desktopUpdateChecking || desktopUpdateInstalling} onClick={() => void installDesktopUpdate()}>
            {desktopUpdateInstalling ? "正在更新…" : "立即更新"}
          </button>
        </div>
      )}

      {!appMode?.legacyRemote && <>
        <ProxiesPage key={`proxies:${appMode?.mode}:${cloudAuth?.user?.id ?? ""}:${cloudAuth?.workspace?.id ?? ""}`}
          active={view === "proxies"} groups={[...(isCloudMode ? [] : [""]), ...groups.slice(1)]} onChanged={load} />
        <TrashPage key={`trash:${appMode?.mode}:${cloudAuth?.user?.id ?? ""}:${cloudAuth?.workspace?.id ?? ""}`}
          active={view === "trash"} onChanged={load} />
      </>}
      {view === "profiles" ? (
      <div className="workspace">
        <div className="filterbar">
          <select
            className="select group-filter"
            aria-label={isCloudMode ? "文件夹筛选" : "分组筛选"}
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          >
            <option value="all">全部{isCloudMode ? "文件夹" : "分组"}</option>
            {existingGroups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <div className="searchfield">
            <Icon name="search" className="sm" />
            <input
              className="input search"
              placeholder="按编号、ID 或名称搜索…"
              aria-label="搜索资料"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {q && <button type="button" className="clear" aria-label="清除搜索" onClick={() => setQ("")}><Icon name="close" className="sm" /></button>}
          </div>
        </div>

        {filtered.length > 0 && (
          <div className="toolbar" role="status">
            <button type="button" className="btn" disabled={deleting || allFilteredSelected} onClick={selectAllFiltered}>
              {allFilteredSelected ? `已选择全部${selectionScope}` : `选择全部${selectionScope}`}
            </button>
            <span className="muted">{deleting ? "正在移动所选资料…" : "跨全部页面"}</span>
            {!allFilteredSelected && selectedOutsideFilter > 0 && <span className="muted">这会替换当前选择，并排除此视图外的 {selectedOutsideFilter} 项。</span>}
          </div>
        )}

        {/* Bulk actions only exist once there is a selection to act on — an
            always-present strip of disabled buttons read as clutter. */}
        {selected.size > 0 && (
        <div className="toolbar active">
          <span className="selcount">
            <Icon name="check" className="sm" />
            已选择 {selected.size} 项
          </span>
          <button type="button" className="btn ghost" aria-label="清除选择" onClick={() => setSelected(new Set())}>清除选择</button>
          <button className="btn primary tip" data-tip="打开所选浏览器" disabled={!selected.size} onClick={openSelected}>
            <Icon name="play" className="sm" />打开
          </button>
          <button className="btn solid-danger tip" data-tip="关闭所选浏览器" disabled={!selected.size} onClick={closeSelected}>
            <Icon name="power" className="sm" />关闭
          </button>
          {(!isCloudMode || selectedEditable) && <>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setScriptRunProfiles(profiles.filter((profile) => selected.has(profile.id)));
              setScriptRunOpen(true);
            }}
          ><Icon name="play" className="sm" />运行脚本</button>
          <span className="vsep" />
          {!isCloudMode && selectedMobileCount > 0 && (
            <button className="btn warn" onClick={convertSelectedMobile}>
              <Icon name="laptop" className="sm" />转换移动端资料（{selectedMobileCount}）
            </button>
          )}
          {/* Export and file edits work in Cloud; mobile conversion remains Local-only. */}
          <div className="menuwrap" ref={exportRef}>
            <button className="btn tip" data-tip="导出所选资料" disabled={!selected.size || !!exportProgress} onClick={() => setExportOpen((o) => !o)}>
              <Icon name="export" className="sm" />导出<Icon name="chevronDown" className="sm" />
            </button>
            {exportOpen && selected.size > 0 && !exportProgress && (
              <div className="exportmenu popover below-left" onMouseLeave={() => setExportOpen(false)}>
                <button className="pop-item" onClick={() => exportSelected("csv")}><Icon name="file" className="sm" />导出为 CSV（账号凭据）</button>
                <button className="pop-item" onClick={() => exportSelected("txt")}><Icon name="file" className="sm" />导出为 TXT（完整资料）</button>
                <button className="pop-item" onClick={() => exportSelected("xlsx")}><Icon name="file" className="sm" />导出为 Excel（完整资料）</button>
              </div>
            )}
          </div>
          <button className="btn tip" data-tip="导出 → 编辑 → 重新上传" disabled={!selected.size || !!exportProgress} onClick={openUpdate} title="通过导出、编辑和重新上传批量修改资料">
            <Icon name="edit" className="sm" />从文件编辑
          </button>
          <span className="vsep" />
          <div className="movewrap">
            {newMode ? (
              <input className="input" autoFocus placeholder="新分组名称" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
            ) : (
              <select
                className="select move-group"
                aria-label="移动到分组"
                title={moveTarget || "选择分组"}
                disabled={!selected.size}
                value={moveTarget}
                onChange={(e) => (e.target.value === "__new__" ? setNewMode(true) : setMoveTarget(e.target.value))}
              >
                <option value="">移动到…</option>
                {editableGroups.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
                <option value="__new__">+ 新建分组…</option>
              </select>
            )}
            {newMode && (
              <button className="btn ghost" onClick={() => { setNewMode(false); setNewGroup(""); }}>取消</button>
            )}
            <button className="btn accent" disabled={!selected.size || (newMode ? !newGroup.trim() : !moveTarget)} onClick={moveSelected}>
              <Icon name="move" className="sm" />移动
            </button>
          </div>
          {!isCloudMode && extensions.length > 0 && selectedProfilesSupportChromeExtensions && (
            <>
              <span className="vsep" />
              <div className="extctl">
                <span className="extctl-lbl"><Icon name="puzzle" className="sm" />扩展</span>
                <select className="select extctl-sel" aria-label="批量分配扩展" disabled={!selected.size} value={bulkExt} onChange={(e) => setBulkExt(e.target.value)}>
                  <option value="">选择…</option>
                  {extensions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <button className="btn xs" disabled={!selected.size || !bulkExt} onClick={() => bulkAssignExt("add")}>添加</button>
                <button className="btn xs" disabled={!selected.size || !bulkExt} onClick={() => bulkAssignExt("remove")}>移除</button>
              </div>
            </>
          )}
          <span className="spacer" />
          {(!isCloudMode || selectedEditable) && (
            <button className="btn danger tip" data-tip={appMode?.legacyRemote ? "删除所选资料" : "将所选资料移到回收站"} disabled={!selected.size || deleting} onClick={deleteSelected}>
              <Icon name="trash" className="sm" />{deleting ? "正在处理…" : appMode?.legacyRemote ? "删除" : `将 ${selected.size.toLocaleString()} 项移到回收站`}
            </button>
          )}
          </>}
        </div>
        )}

        <div
          className={`tablewrap${tableScrolled ? " scrolled" : ""}`}
          onScroll={(event) => setTableScrolled(event.currentTarget.scrollLeft > 0)}
        >
          <table className="profile-table" style={{ minWidth: tableMinWidth }}>
            <thead>
              <tr>
                <th className="chk" style={{ width: CHECKBOX_COLUMN_WIDTH }}>
                  <input type="checkbox" aria-label="选择当前页全部资料" checked={allVisibleSelected} onChange={toggleAll} />
                </th>
                {shownColumns.map(columnHead)}
              </tr>
            </thead>
            <tbody>
              {visibleProfiles.map((p) => {
                // The numbering memo covers every roster profile, so this
                // lookup cannot miss; a silent fallback here would renumber
                // rows wrongly if that invariant ever broke.
                const no = numbering.get(p.id)!;
                // Running rows are editable too: an open Cloud profile is edited
                // live through the local cache. Only rows locked by ANOTHER
                // session stay read-only — that writer owns the profile.
                const canEditRow = !isCloudMode || (p.permission === "edit" && !p.lockedBy);
                return (
                <tr key={p.id} className={`${p.running ? "running" : ""}${selected.has(p.id) ? " selected" : ""}`}>
                  <td className="chk">
                    <input type="checkbox" aria-label={`选择 ${p.name}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                  </td>
                  {columnVisible("no") && (
                    <td className="col-no">
                      <span className={`no-text${no.custom ? " custom" : ""}`} title={`${no.custom ? "自定义编号" : "序号"} ${no.value}`}>{no.value}</span>
                    </td>
                  )}
                  {columnVisible("name") && (
                    <td className="col-name" title={`${p.name}\n${p.id}`}>
                      <span className="name-cell">
                        <span className="n">{p.name}<FingerprintBadge p={p} /></span>
                        <span className="sub">
                          {p.id}
                          <span title={p.engine === "firefox" ? "原生 Firefox 资料 · 不支持 CDP、PDF 或 Chrome 扩展" : "IDFRI Chromium 内核 · 支持 CDP、PDF 和 Chrome 扩展"}>
                            {p.engine === "firefox" ? "AliasMode Firefox" : "IDFRI Browser"}
                          </span>
                          {p.running && <span className="live"><StatusDot running />运行中</span>}
                          {p.lockedBy && (
                            <span className="lockedby" title={`in use by ${p.lockedBy}`}>
                              <Icon name="lock" className="sm" />{p.lockedBy}
                            </span>
                          )}
                        </span>
                      </span>
                    </td>
                  )}
                  {columnVisible("group") && (
                    <td className="col-group" title={p.group}>
                      {p.group ? <span className="chip">{p.group}</span> : <span className="muted">—</span>}
                    </td>
                  )}
                  {columnVisible("platform") && <td className="col-platform"><PlatformPill platform={p.platform} /></td>}
                  {columnVisible("tags") && (
                    <td className="col-tags" title={p.tags?.length ? p.tags.join(", ") : "无标签"}>
                      {p.tags?.length ? p.tags.map((t) => <span key={t} className="chip">{t}</span>) : <span className="muted">—</span>}
                    </td>
                  )}
                  {columnVisible("proxy") && (
                    <td className="col-proxy" title={p.proxyError || p.proxy || "no proxy"}>
                      {p.proxyError
                        ? <span className="proxy-cell bad"><Icon name="warning" className="sm" />无效 — 请编辑</span>
                        : p.proxy
                          ? <span className="proxy-cell">{p.proxy}</span>
                          : <span className="muted">—</span>}
                    </td>
                  )}
                  {columnVisible("action") && (
                    <td className="col-action">
                      <span className="rowactions">
                        {!isCloudMode && p.has2fa && (
                          <button
                            className={`iconbtn twofa tip${twoFaFlash?.id === p.id ? " flash" : ""}`}
                            data-tip={twoFaFlash?.id === p.id ? `已复制 ${twoFaFlash.code}` : "复制当前 2FA 验证码"}
                            aria-label="复制当前 2FA 验证码"
                            onClick={() => copy2fa(p.id)}
                          >
                            <Icon name={twoFaFlash?.id === p.id ? "check" : "key"} className="sm" />
                          </button>
                        )}
                        {canEditRow && (
                          <button className="iconbtn tip" data-tip="编辑资料" aria-label={`编辑 ${p.name}`} onClick={() => openEdit(p.id)}>
                            <Icon name="edit" className="sm" />
                          </button>
                        )}
                        {p.running ? (
                          <>
                            {p.engine === "chromium" && <>
                              <button
                                className="iconbtn tip"
                                data-tip="添加 Cookie"
                                aria-label={`向 ${p.name} 添加 Cookie`}
                                onClick={() => openCookie(p)}
                              ><Icon name="cookie" className="sm" /></button>
                              <button
                                className="iconbtn tip"
                                data-tip="置于前台"
                                aria-label="将浏览器窗口置于前台"
                                disabled={busy[p.id]}
                                onClick={() => act(p.id, raiseProfile)}
                              ><Icon name="raise" className="sm" /></button>
                            </>}
                            <button className="btn sm solid-danger" aria-label={`关闭 ${p.name}`} disabled={busy[p.id]} onClick={() => act(p.id, closeProfile)}>
                              <Icon name="power" className="sm" />关闭
                            </button>
                          </>
                        ) : p.mobilePersona ? (
                          !p.lockedBy && (!isCloudMode || p.permission === "edit") ? (
                            <button className="btn sm warn" disabled={busy[p.id]} title="将此移动端身份转换为桌面设备" onClick={() => openEdit(p.id)}>
                              <Icon name="laptop" className="sm" />转换
                            </button>
                          ) : null
                        ) : p.parkedSession && p.permission === "edit" ? (
                          <>
                            <button
                              className="btn sm warn tip"
                              data-tip={`已保存于本机：${new Date(p.parkedSession.savedAt).toLocaleString()}`}
                              aria-label={`恢复 ${p.name} 的已保存会话`}
                              disabled={busy[p.id]}
                              onClick={() => restoreSession(p)}
                            >
                              <Icon name="refresh" className="sm" />Restore session
                            </button>
                            <button
                              className="btn sm primary"
                              aria-label={`打开 ${p.name}`}
                              disabled={busy[p.id]}
                              onClick={() => act(p.id, openProfile)}
                            >
                              <Icon name="play" className="sm" />打开
                            </button>
                          </>
                        ) : (
                          <button
                            className="btn sm primary"
                            aria-label={`打开 ${p.name}`}
                            title={p.lockedBy ? `Open — session writer: ${p.lockedBy}; this browser will not save its session back` : undefined}
                            disabled={busy[p.id]}
                            onClick={() => act(p.id, openProfile)}
                          >
                            <Icon name="play" className="sm" />打开
                          </button>
                        )}
                      </span>
                    </td>
                  )}
                </tr>
                );
              })}
              {loaded && filtered.length === 0 && (
                <tr>
                  <td colSpan={visibleColumnCount} className="empty">
                    <div className="emptystate">
                      <span className="glyph"><Icon name="profiles" /></span>
                      {profiles.length === 0 ? (
                        <>
                          <b>暂无资料</b>
                          <p>
                            {isCloudMode
                              ? "No Cloud profiles yet — click New Profile to create one."
                              : "暂无资料。点击“新建资料”，或将 TXT、CSV、JSON、XLSX 导出文件拖到此窗口。"}
                          </p>
                          <button className="btn primary" disabled={!canEditCloud} onClick={openCreate}><Icon name="plus" className="sm" />新建资料</button>
                        </>
                      ) : (
                        <>
                          <b>没有匹配项</b>
                          <p>没有资料符合当前筛选条件。</p>
                          <button className="btn" onClick={() => { setQ(""); setGroup("all"); }}>清除筛选</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {showDiag && diag && (
          <div className="diagpanel">
            <div className="when">Last diagnose: {diagWhen}</div>
            {diag.analysis.verdicts.map((v, i) => (
              <div className="v" key={i}>{v}</div>
            ))}
          </div>
        )}

        <footer className="statusbar">
          <span className="stat"><b>{profiles.length}</b> 个资料</span>
          <span className="stat"><StatusDot running={runningCount > 0} /><b>{runningCount}</b> 个运行中</span>
          {diag && (
            <span className="diag" onClick={() => setShowDiag((s) => !s)}>
              Diagnose · last {diagWhen}
              <Icon name={showDiag ? "chevronDown" : "chevronRight"} className="sm" />
            </span>
          )}
          <span className="pager">
            <button
              type="button"
              className="iconbtn"
              aria-label="上一页"
              disabled={visibleProfilePage === 0}
              onClick={() => setProfilePage(visibleProfilePage - 1)}
            ><Icon name="chevronLeft" className="sm" /></button>
            <span className="page-of">第 <b>{visibleProfilePage + 1}</b> / {profilePageCount} 页</span>
            <button
              type="button"
              className="iconbtn"
              aria-label="下一页"
              disabled={visibleProfilePage + 1 >= profilePageCount}
              onClick={() => setProfilePage(visibleProfilePage + 1)}
            ><Icon name="chevronRight" className="sm" /></button>
            <select className="select" aria-label="每页行数" value={pageSize} onChange={(e) => applyPageSize(Number(e.target.value))}>
              {PAGE_SIZES.map((size) => <option key={size} value={size}>{size} / page</option>)}
            </select>
          </span>
        </footer>
      </div>
      ) : view === "scripts" ? (
      <ScriptsPage onViewRun={() => setScriptRunOpen(true)} />
      ) : view === "extensions" ? (
      <div className="workspace">
        <div className="settingspage">
          <h2 className="sect-title">扩展</h2>
          {extErr && <div className="modal-err"><Icon name="alert" className="sm" />{extErr}</div>}
          <section className="settings-card">
            <header><Icon name="puzzle" className="sm" /><h2>从 Chrome 应用商店安装</h2></header>
            <div className="card-body">
              <p>粘贴 Chrome 应用商店扩展链接或 32 位扩展 ID。</p>
              <form className="fld-row" onSubmit={(event) => { event.preventDefault(); void doInstallWebStoreExtension(); }}>
                <input
                  className="input"
                  style={{ flex: 1 }}
                  aria-label="Chrome 应用商店链接或扩展 ID"
                  placeholder="https://chromewebstore.google.com/detail/…"
                  value={extSource}
                  onChange={(event) => setExtSource(event.target.value)}
                />
                <button className="btn primary" type="submit" disabled={extInstallBusy || extBusy}>
                  <Icon name="plus" className="sm" />{extInstallBusy ? "安装中…" : "安装"}
                </button>
              </form>
            </div>
          </section>
          <p className="formnote">IDFRI Browser 中的应用商店按钮不可用。请在上方粘贴商店链接，或上传 ZIP/CRX 文件。Chrome 扩展仅适用于 IDFRI Browser 资料。</p>
          <ol className="steps">
            <li>先在此安装扩展；新安装的扩展默认不分配。</li>
            <li>在<b>编辑 → 扩展</b>中分配给资料{!isCloudMode && "，也可在资料工具栏中批量分配"}。</li>
            <li>重新打开资料后，IDFRI 会在浏览器启动时加载扩展。</li>
          </ol>
          <section className="settings-card">
            <header><Icon name="folder" className="sm" /><h2>分组默认扩展</h2></header>
            <div className="card-body">
              <p>选择该分组默认分配的扩展。</p>
              {editableDefaultGroups.length === 0 ? (
                <p className="formnote">请先创建分组，再设置默认扩展。</p>
              ) : (
                <>
                  <label className="fld">
                    <span>分组</span>
                    <select
                      aria-label="默认扩展分组"
                      value={groupDefaultName}
                      onChange={(event) => {
                        const name = event.target.value;
                        setGroupDefaultName(name);
                        setGroupDefaultExts(groupExtensionDefaults.find((item) => item.name === name)?.extensions ?? []);
                      }}
                    >
                      {editableDefaultGroups.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                    </select>
                  </label>
                  {groupDefaultExtensionChoices.length > 0 ? (
                    <div className="extassign">
                      {groupDefaultExtensionChoices.map((item) => (
                        <label key={item.id} className="extchk">
                          <input
                            type="checkbox"
                            checked={groupDefaultExts.includes(item.id)}
                            onChange={() => toggleGroupDefaultExt(item.id)}
                          />
                          <span>{item.name}{item.missing && <span className="muted"> · 本机未安装</span>}</span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="formnote">尚未安装扩展。应用空选择可清除此默认设置。</p>
                  )}
                  <p className="formnote">
                    Applying replaces assignments on {groupDefaultProfileCount} current profile(s). New and moved profiles inherit it.
                    Individual profiles can differ later. Reopen browsers to apply changes.
                  </p>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={groupDefaultBusy || !groupDefaultName}
                    onClick={applyGroupExtensionDefault}
                  >
                    {groupDefaultBusy ? "正在应用…" : "应用分组默认值"}
                  </button>
                </>
              )}
            </div>
          </section>
          {extensions.length === 0 ? (
            <div className="emptystate">
              <span className="glyph"><Icon name="puzzle" /></span>
              <b>尚无扩展</b>
              <p>上传的扩展会显示在这里，可分配给任意 Chromium 资料。</p>
              <button className="btn primary" disabled={extBusy || extInstallBusy} onClick={() => extFileRef.current?.click()}>
                <Icon name="plus" className="sm" />{extBusy ? "正在上传…" : "上传 ZIP/CRX"}
              </button>
            </div>
          ) : (
            <div className="extlist">
              {extensions.map((x) => (
                <div key={x.id} className="extrow">
                  <Icon name="puzzle" className="sm" />
                  <span className="extname">{x.name}</span>
                  <span className="spacer" />
                  <button className="btn xs danger" onClick={() => doRemoveExtension(x.id, x.name)}>移除</button>
                </div>
              ))}
            </div>
          )}
          <input
            ref={extFileRef}
            type="file"
            multiple
            accept=".zip,.crx,application/zip,application/x-chrome-extension"
            style={{ display: "none" }}
            onChange={(e) => { if (e.target.files) doUploadExtensions(e.target.files); e.target.value = ""; }}
          />
        </div>
        <footer className="pagefoot">
          <span className="spacer" />
          {extensions.length > 0 && (
            <button className="btn primary" type="button" disabled={extBusy || extInstallBusy} onClick={() => extFileRef.current?.click()}>
              <Icon name="plus" className="sm" />{extBusy ? "正在上传…" : "上传 ZIP/CRX"}
            </button>
          )}
        </footer>
      </div>
      ) : view === "settings" ? (
      <div className="workspace">
        <div className="tabs" role="tablist" aria-label="设置分类">
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={settingsTab === tab.key}
              className={`tab${settingsTab === tab.key ? " active" : ""}`}
              onClick={() => setSettingsTab(tab.key)}
            >
              {tab.key === "team" && isCloudMode ? "团队" : tab.label}
            </button>
          ))}
        </div>
        <div className="settingspage">
          {settingsTab === "account" && (
            <>
              <h2 className="sect-title">账号信息</h2>
              <div className="identity-card">
                <span className="identity-avatar"><Icon name="user" className="lg" /></span>
                <span className="identity-lines">
                  <b>{isCloudMode ? cloudAuth?.user?.email ?? "Cloud 账号" : "本地工作区"}</b>
                  <span>
                    {isCloudMode
                      ? `${cloudAuth?.workspace?.role ?? "成员"} · ${cloudAuth?.workspace?.name ?? "Cloud 工作区"}`
                      : "无需账号 · 资料仅保存在本机"}
                  </span>
                </span>
                <span className="chip">{isCloudMode ? "云端" : "本地"}</span>
              </div>
<section className="settings-card">
            <header><Icon name="user" className="sm" /><h2>账号</h2></header>
            <div className="card-body">
            <div className="settings-row"><span>当前身份</span><strong>{isCloudMode ? cloudAuth?.user?.email ?? "Cloud 账号" : "本地 · 无需账号"}</strong></div>
            <div className="settings-row"><span>已保存资料</span><strong>{profiles.length}</strong></div>
            {isCloudMode && cloudAuth?.authenticated && (
              <button className="btn danger" type="button" disabled={authBusy} onClick={() => void signOut()}>
                <Icon name="power" className="sm" />{authBusy ? "正在退出…" : "退出 / 切换账号"}
              </button>
            )}
            {authErr && <p className="modal-err" role="alert">{authErr}</p>}
            </div>
          </section>

          {isCloudMode && cloudAuth?.authenticated && (
            <section className="settings-card remote-mcp-settings">
              <header>
                <Icon name="cloud" className="sm" /><h2>远程 MCP</h2>
                <span className={`remote-mcp-status ${remoteMcp.state}`}>
                  {remoteMcp.state === "active" ? "就绪" : remoteMcp.state === "disabled" ? "已禁用" : remoteMcp.state === "loading" ? "正在准备" : remoteMcp.state === "error" ? "不可用" : "未就绪"}
                </span>
              </header>
              <div className="card-body">
                <p>连接另一台电脑上的 AI 客户端。浏览器窗口会在这台 Windows 电脑上打开，因此请保持 IDFRI 运行。</p>
                {remoteMcp.state === "loading" && <p className="hint" role="status">正在准备安全连接…</p>}
                {remoteMcp.state === "active" && remoteMcp.url && remoteMcp.token && (
                  <>
                    <label className="fld remote-mcp-field">
                      <span>MCP 服务器 URL</span>
                      <span className="remote-mcp-value">
                        <input className="mono" value={remoteMcp.url} readOnly />
                        <button className="btn" type="button" disabled={authBusy} onClick={() => void copyRemoteMcp("url", remoteMcp.url!)}>{remoteMcpCopied === "url" ? "已复制" : "复制"}</button>
                      </span>
                    </label>
                    <label className="fld remote-mcp-field">
                      <span>访问密钥</span>
                      <span className="remote-mcp-value">
                        <input className="mono" value={remoteMcpTokenVisible ? remoteMcp.token : "••••••••••••••••••••••••"} readOnly aria-label="Remote MCP 访问密钥" />
                        <button className="btn" type="button" disabled={authBusy} onClick={() => setRemoteMcpTokenVisible((visible) => !visible)}>{remoteMcpTokenVisible ? "隐藏" : "显示"}</button>
                        <button className="btn" type="button" disabled={authBusy} onClick={() => void copyRemoteMcp("token", remoteMcp.token!)}>{remoteMcpCopied === "token" ? "已复制" : "复制"}</button>
                      </span>
                    </label>
                    <div className="hint remote-mcp-guide">
                      <strong>连接 Claude.ai 或 ChatGPT</strong>
                      <ol>
                        <li>添加自定义 MCP 连接器或应用。</li>
                        <li>粘贴 MCP 服务器 URL，然后选择“连接”。</li>
                        <li>登录 IDFRI，然后选择“允许”。</li>
                      </ol>
                      <details>
                        <summary>Claude Code 和其他客户端</summary>
                        <p>Claude Code 使用 <code>.mcp.json</code> 中的 HTTP 配置。请将访问密钥保存在环境变量中。其他支持 Bearer 身份验证的 MCP 客户端可使用相同的 URL 和密钥请求头。</p>
                        <p>Claude.ai 和 ChatGPT 使用 OAuth，不需要访问密钥。</p>
                      </details>
                    </div>
                    <div className="update-actions">
                      <button className="btn" type="button" disabled={authBusy} onClick={() => void regenerateRemoteMcp()}>重新生成密钥</button>
                      <button className="btn danger" type="button" disabled={authBusy} onClick={() => void disableRemoteMcp()}>禁用</button>
                    </div>
                  </>
                )}
                {remoteMcp.state === "disabled" && (
                  <>
                    <p>此 Windows 设备已禁用远程连接。</p>
                    <button className="btn" type="button" disabled={authBusy} onClick={() => void enableRemoteMcp()}>启用远程 MCP</button>
                  </>
                )}
                {remoteMcp.error && <div className="modal-err" role="alert">{remoteMcp.error}</div>}
                {remoteMcp.state === "error" && <button className="btn" type="button" disabled={authBusy} onClick={() => void loadRemoteMcp()}>重试</button>}
              </div>
            </section>
          )}

<section className="settings-card">
            <header><Icon name="sun" className="sm" /><h2>外观</h2></header>
            <div className="card-body">
              <p>选择 IDFRI 的外观；“跟随系统”会使用操作系统设置。</p>
              <div className="segmented" role="radiogroup" aria-label="主题">
                {THEMES.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    role="radio"
                    aria-checked={theme === option.key}
                    className={theme === option.key ? "active" : ""}
                    onClick={() => chooseTheme(option.key)}
                  >
                    <Icon name={option.icon} className="sm" />{option.label}
                  </button>
                ))}
              </div>
            </div>
          </section>
          
            </>
          )}
          {settingsTab === "team" && (
            <>
              <h2 className="sect-title">{isCloudMode ? "团队与分组权限" : "工作区"}</h2>
<section className="settings-card">
            <header><Icon name="folders" className="sm" /><h2>{isCloudMode ? "团队" : "工作区"}</h2></header>
            <div className="card-body">
            {isCloudMode ? (
              <>
                <div className="settings-row"><span>工作区</span><strong>{cloudAuth?.workspace?.name ?? "Cloud 工作区"}</strong></div>
                <div className="settings-row"><span>角色</span><strong>{cloudAuth?.workspace?.role === "owner" ? "所有者" : cloudAuth?.workspace?.role === "admin" ? "管理员" : "成员"}</strong></div>
                {teamBusy && !team && <p className="hint" role="status">正在加载团队…</p>}
                <h3 className="settings-subhead">成员</h3>
                {team?.members.map((member) => (
                  <div className="team-member" key={member.accountId}>
                    <div className="settings-row">
                      <span>{member.email}<small> · {member.grants.map((grant) => `${grant.folderName}：${grant.permission === "edit" ? "编辑" : "查看"}`).join("，") || "无分组权限"}</small></span>
                      {member.role === "owner" || cloudAuth?.workspace?.role !== "owner" ? <strong>{member.role === "owner" ? "所有者" : member.role === "admin" ? "管理员" : "成员"}</strong> : (
                        <select className="select" aria-label={`${member.email} 的角色`} value={member.role} disabled={teamBusy} onChange={(event) => void runTeamAction("role", { accountId: member.accountId, role: event.target.value })}>
                          <option value="member">成员</option><option value="admin">管理员</option>
                        </select>
                      )}
                    </div>
                    {member.role === "member" && (cloudAuth?.workspace?.role === "owner" || cloudAuth?.workspace?.role === "admin") && (
                      <div className="team-grants">
                        {team.folders.filter((folder) => !folder.archivedAt).map((folder) => {
                          const permission = member.grants.find((grant) => grant.folderName === folder.name)?.permission ?? "";
                          return <label key={folder.name}>{folder.name}<select className="select" aria-label={`${member.email} 对 ${folder.name} 的权限`} value={permission} disabled={teamBusy} onChange={(event) => void runTeamAction(event.target.value ? "grant" : "remove-grant", { folderName: folder.name, accountId: member.accountId, permission: event.target.value })}><option value="">无权限</option><option value="view">查看</option><option value="edit">编辑</option></select></label>;
                        })}
                        <button className="btn xs danger" type="button" aria-label={`移除 ${member.email}`} disabled={teamBusy} onClick={() => void runTeamAction("remove-member", { accountId: member.accountId }, `已移除 ${member.email}`)}>移除</button>
                      </div>
                    )}
                  </div>
                ))}
                {(cloudAuth?.workspace?.role === "owner" || cloudAuth?.workspace?.role === "admin") && (
                  <>
                    <h3 className="settings-subhead">邀请</h3>
                    <form className="team-code" onSubmit={(event) => { event.preventDefault(); void inviteTeamMember(); }}>
                      <input className="input" type="email" aria-label="邀请邮箱" aria-describedby="invite-team-help" placeholder="成员邮箱地址" value={teamEmail} disabled={teamBusy} onChange={(event) => setTeamEmail(event.target.value)} />
                      {cloudAuth?.workspace?.role === "owner" && <select className="select" aria-label="邀请角色" value={teamRole} disabled={teamBusy} onChange={(event) => setTeamRole(event.target.value as "admin" | "member")}><option value="member">成员</option><option value="admin">管理员</option></select>}
                      <button className="btn primary" type="submit" disabled={teamBusy || !teamEmail.trim()}>发送邀请</button>
                    </form>
                    <p className="hint" id="invite-team-help">邀请会发送到该已验证邮箱。新成员在这里获得权限前看不到任何分组。</p>
                    {team?.invitations.filter((invite) => !invite.acceptedAt && !invite.revokedAt).map((invite) => {
                      const expired = invite.expiresAt <= Date.now();
                      const status = expired ? "已过期" : "待接受";
                      return <div className="settings-row" key={invite.id}>
                        <span>{invite.email}<small>{invite.role}</small></span>
                        <span>
                          <span className={`team-tag ${expired ? "expired" : "pending"}`}>{status}</span>
                          {(cloudAuth?.workspace?.role === "owner" || invite.role === "member") && <> <button className="btn xs" type="button" aria-label={`重新发送给 ${invite.email}`} disabled={teamBusy} onClick={() => void runTeamAction("resend", { id: invite.id }, "邀请已重新发送")}>重新发送</button> <button className="btn xs danger" type="button" aria-label={`撤销对 ${invite.email} 的邀请`} disabled={teamBusy} onClick={() => void runTeamAction("revoke", { id: invite.id }, "邀请已撤销")}>撤销</button></>}
                        </span>
                      </div>;
                    })}
                  </>
                )}
                {teamErr && <p className="modal-err" role="alert">{teamErr}</p>}
                <h3 className="settings-subhead">加入其他工作区</h3>
                <form className="team-code" onSubmit={(event) => { event.preventDefault(); void acceptInvitation(); }}>
                  <input className="input" aria-label="邀请码" placeholder="粘贴邀请码" value={invitationCode} onChange={(event) => setInvitationCode(event.target.value)} />
                  <button className="btn primary" type="submit" disabled={authBusy || !invitationCode.trim()}>接受</button>
                </form>
                <p className="hint">粘贴邀请邮件中的代码。该代码仅适用于当前登录邮箱。</p>
                {authNotice && <p className="hint" role="status">{authNotice}</p>}
                {authErr && <p className="modal-err" role="alert">{authErr}</p>}
              </>
            ) : <p>所有资料仅保存在这台电脑上，不会同步到远端。</p>}
            </div>
          </section>
          
            </>
          )}
          {settingsTab === "advanced" && (
            <>
              <h2 className="sect-title">更新与诊断</h2>
<section className="settings-card update-settings">
            <header><Icon name="import" className="sm" /><h2>更新</h2></header>
            <div className="card-body">
            <div className="settings-row"><span>已安装版本</span><strong className="mono">{appVersion || desktopUpdate?.currentVersion || "—"}</strong></div>
            {desktopUpdateResultSummary && (
              <div
                className={`update-last-result ${desktopUpdateResultSummary.tone}`}
                role={desktopUpdateResultSummary.tone === "success" ? "status" : "alert"}
              >
                <strong>{desktopUpdateResultSummary.title}</strong>
                <span>{desktopUpdateResultSummary.detail}</span>
              </div>
            )}
            {desktopUpdate?.state === "upToDate" && <p role="status">IDFRI 已是最新版本。</p>}
            {desktopUpdate?.state === "available" && (
              <>
                <p role="status">版本 {desktopUpdate.version} 已就绪。正在运行的浏览器将保存并关闭。</p>
                <UpdateHighlights version={desktopUpdate.version} highlights={desktopUpdate.highlights} />
              </>
            )}
            {!desktopUpdate && !desktopUpdateChecking && <p>IDFRI 会在启动时检查更新。</p>}
            {desktopUpdateProgress && <DesktopUpdateProgressView progress={desktopUpdateProgress} />}
            {desktopUpdateErr && <div className="modal-err" role="alert">{desktopUpdateErr}</div>}
            <div className="update-actions">
              <button className="btn" type="button" disabled={desktopUpdateChecking || desktopUpdateInstalling} onClick={() => void checkDesktopUpdate(true)}>
                <Icon name="refresh" className="sm" />{desktopUpdateChecking ? "正在检查…" : "检查更新"}
              </button>
              {desktopUpdate?.state === "available" && (
                <button className="btn primary" type="button" disabled={desktopUpdateChecking || desktopUpdateInstalling} onClick={() => void installDesktopUpdate()}>
                  {desktopUpdateInstalling ? "正在更新…" : "立即更新"}
                </button>
              )}
            </div>
            </div>
          </section>
          
{isCloudMode && (
            <section className="settings-card diagnostics-section">
              <header>
                <Icon name="activity" className="sm" /><h2>最近的诊断记录</h2>
                <button className="btn xs" type="button" disabled={cloudEventsBusy} onClick={() => void loadCloudEvents()}>
                  {cloudEventsBusy ? "正在加载…" : "刷新"}
                </button>
              </header>
              <div className="card-body">
              {cloudEventsErr && <div className="diagnostics-error" role="alert">{cloudEventsErr}</div>}
              {!cloudEventsErr && cloudEvents.length === 0 && (
                <p>{cloudEventsBusy ? "正在加载最近的 Cloud 事件…" : "本次运行没有 Cloud 生命周期事件。"}</p>
              )}
              {cloudEvents.length > 0 && (
                <div className="diagnostics-list" role="log" aria-label="最近的 Cloud 诊断记录">
                  {cloudEvents.map((event, index) => (
                    <div className={`diagnostics-row${cloudDiagnosticFailed(event.type) ? " failed" : ""}`} key={`${event.timestamp}-${index}`}>
                      <time dateTime={new Date(event.timestamp).toISOString()}>{new Date(event.timestamp).toLocaleTimeString()}</time>
                      <span>{CLOUD_DIAGNOSTIC_LABELS[event.type]}</span>
                    </div>
                  ))}
                </div>
              )}
              <p>诊断记录仅包含固定的生命周期标签，不含资料数据和账号凭据。</p>
              </div>
            </section>
          )}
          {/* Logs are not a Cloud feature — a Local install needs them just as
              much, so this card is the one part of Advanced that always shows. */}
          <section className="settings-card">
            <header><Icon name="logs" className="sm" /><h2>日志</h2></header>
            <div className="card-body">
              <p>详细日志会记录本机的浏览器启动、代理设置和生命周期事件。</p>
              <button type="button" className="btn" onClick={() => {
                setLogErr(null);
                fetchLogs().then(setLogView).catch((e) => setLogErr(e instanceof Error ? e.message : String(e)));
              }}><Icon name="logs" className="sm" />查看详细日志</button>
              {logErr && <p className="cardnote">日志：{logErr}</p>}
              {logDir && <p className="cardnote">文件：{logDir}</p>}
            </div>
          </section>
          
            </>
          )}
          {modeErr && <div className="modal-err" role="alert"><Icon name="alert" className="sm" />{modeErr}</div>}
        </div>
        <footer className="pagefoot">
          <span className="spacer" />
          <button className="btn primary" type="button" onClick={() => setView("profiles")}>完成</button>
        </footer>
      </div>
      ) : null}
      </div>

      {(logView || logErr) && (
        <div className="modal-backdrop" onClick={() => { setLogView(null); setLogErr(null); }}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">详细日志<button type="button" className="modal-close" aria-label="关闭" onClick={() => { setLogView(null); setLogErr(null); }}><Icon name="close" className="sm" /></button></div>
            <div className="modal-body">
              {logErr && <p className="hint">{logErr}</p>}
              {logView && (
                <pre className="logpre">
                  {logView.file + "\n" + logView.content}
                </pre>
              )}
            </div>
            <div className="modal-foot"><button className="btn ghost" type="button" onClick={() => { setLogView(null); setLogErr(null); }}>关闭</button></div>
          </div>
        </div>
      )}

      {cookieProfile && (
        <div className="modal-backdrop">
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-cookie-title"
            onSubmit={(event) => { event.preventDefault(); void submitCookie(); }}
          >
            <div className="modal-head" id="add-cookie-title">
              <Icon name="cookie" />添加 Cookie<span className="mono muted">{cookieProfile.name}</span>
              <button type="button" className="modal-close" aria-label="关闭" disabled={cookieSaving} onClick={closeCookie}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {cookieErr && <div className="modal-err"><Icon name="alert" className="sm" />{cookieErr}</div>}
              <p className="hint">直接向当前打开的浏览器添加一条 Cookie。</p>
              <div className="fld-row">
                <label className="fld grow">
                  <span>名称</span>
                  <input autoFocus value={cookieForm.name} onChange={(event) => setCookieField("name", event.target.value)} />
                </label>
                <label className="fld grow">
                  <span>值</span>
                  <input type="password" autoComplete="off" value={cookieForm.value} onChange={(event) => setCookieField("value", event.target.value)} />
                </label>
              </div>
              <div className="fld-row">
                <label className="fld grow">
                  <span>域名</span>
                  <input value={cookieForm.domain} placeholder="example.com" onChange={(event) => setCookieField("domain", event.target.value)} />
                </label>
                <label className="fld port">
                  <span>路径</span>
                  <input value={cookieForm.path} onChange={(event) => setCookieField("path", event.target.value)} />
                </label>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" type="button" disabled={cookieSaving} onClick={closeCookie}>取消</button>
              <button className="btn primary" type="submit" disabled={cookieSaving || !cookieForm.name || !cookieForm.domain.trim() || !cookieForm.path.startsWith("/")}>
                {cookieSaving ? "正在添加…" : "添加 Cookie"}
              </button>
            </div>
          </form>
        </div>
      )}

      {showCreate && (
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="create-profile-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head" id="create-profile-title">
              <Icon name="plus" />新建资料
              <button type="button" className="modal-close" aria-label="关闭" onClick={closeCreate}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {createErr && <div className="modal-err"><Icon name="alert" className="sm" />{createErr}</div>}
              <div className="fld-row">
                <label className="fld grow">
                  <span>名称</span>
                  <input value={form.name} placeholder="留空时自动生成" onChange={(e) => setF("name", e.target.value)} />
                </label>
                {!isCloudMode && (
                  <label className="fld no">
                    <span>自定义编号</span>
                    <input
                      value={form.customNo}
                      inputMode="numeric"
                      maxLength={MAX_CUSTOM_NO}
                      placeholder="自动"
                      onChange={(e) => setF("customNo", e.target.value.replace(/\D/g, "").slice(0, MAX_CUSTOM_NO))}
                    />
                  </label>
                )}
              </div>
              <div className="fld-row">
                <label className="fld grow">
                  <span>分组</span>
                  <GroupPicker value={form.group} onChange={(v) => setF("group", v)} groups={editableGroups} allowCreate={!isCloudMode} />
                </label>
                <label className="fld grow">
                  <span>平台</span>
                  <PlatformPicker value={form.platform} onChange={(v) => setF("platform", v)} />
                </label>
              </div>
              <label className="fld">
                <span>标签 <span className="muted">（逗号分隔）</span></span>
                <input value={form.tags} placeholder="预热, 美国, 优先" onChange={(e) => setF("tags", e.target.value)} />
              </label>
              <label className="fld">
                <span>启动页</span>
                <input value={form.startupUrl} placeholder="https://example.com/（留空时按账号平台打开）" onChange={(e) => setF("startupUrl", e.target.value)} />
              </label>
              <label className="fld">
                <span>备注</span>
                <textarea value={form.note} placeholder="仅保存在本机" onChange={(e) => setF("note", e.target.value)} />
              </label>
              <label className="fld">
                <span>Cookie JSON</span>
                <textarea value={form.cookies} placeholder='[{"name":"session","value":"...","domain":".example.com","path":"/"}]' onChange={(e) => setF("cookies", e.target.value)} />
                <small>留空表示不导入；必须是浏览器 Cookie JSON 数组。</small>
              </label>
              <div className="proxy-paste-row">
                <label className="fld grow">
                  <span>粘贴代理并自动填充 <span className="muted">（先选择类型 · 主机:端口:用户名:密码）</span></span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={proxyPaste}
                    placeholder="粘贴到这里，凭据不会显示"
                    onChange={(e) => { setProxyPaste(e.target.value); setProxyPasteOk(null); }}
                    onPaste={(e) => {
                      const pasted = e.clipboardData.getData("text");
                      if (pasted) { e.preventDefault(); applyProxyPaste(pasted); }
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyProxyPaste(proxyPaste); } }}
                  />
                </label>
                <button type="button" className="btn accent" disabled={!proxyPaste.trim()} onClick={() => applyProxyPaste(proxyPaste)}>自动填充</button>
              </div>
              {proxyPasteOk && <div className="proxy-paste-ok"><Icon name="check" className="sm" />{proxyPasteOk}</div>}
              <div className="fld-row">
                <label className="fld type">
                  <span>代理类型</span>
                  <select value={form.proxyType} onChange={(e) => setF("proxyType", e.target.value)}>
                    <option value="http">http</option>
                    <option value="https">https</option>
                    <option value="socks5">socks5</option>
                  </select>
                </label>
                <label className="fld grow">
                  <span>主机</span>
                  <input value={form.host} placeholder="留空表示不使用代理" onChange={(e) => setF("host", e.target.value)} />
                </label>
                <label className="fld port">
                  <span>端口</span>
                  <input value={form.port} inputMode="numeric" placeholder="8080" onChange={(e) => setF("port", e.target.value)} />
                </label>
              </div>
              <div className="fld-row">
                <label className="fld grow"><span>代理用户名</span><input value={form.user} onChange={(e) => setF("user", e.target.value)} /></label>
                <label className="fld grow"><span>代理密码</span><input type="password" value={form.pass} onChange={(e) => setF("pass", e.target.value)} /></label>
              </div>
              <div className="proxy-check-actions">
                <button
                  type="button"
                  className="btn proxy-check-btn"
                  disabled={createProxyCheck.checking || !createHasProxy}
                  aria-busy={createProxyCheck.checking}
                  onClick={checkCreateProxy}
                >
                  <Icon name="activity" className="sm" />
                  {createProxyCheck.checking ? "正在检测…" : "检测代理"}
                </button>
              </div>
              <ProxyCheckFeedback hasProxy={createHasProxy} state={createProxyCheck} />
              {!isCloudMode && (
                <label className="fld">
                  <span>时区</span>
                  <input value={form.timezone} placeholder="自动 · 例如 Asia/Tokyo" onChange={(e) => setF("timezone", e.target.value)} />
                  <small>留空时根据代理真实出口自动同步；浏览器时间会按该时区自然计算。</small>
                </label>
              )}
              <FingerprintSettings
                engine={form.engine}
                screen={form.screen}
                values={form}
                onScreenChange={(value) => setF("screen", value)}
                onChange={(key, value) => setF(key as keyof typeof BLANK_FORM, value)}
              />
              <div className="browser-options" role="radiogroup" aria-label="浏览器">
                {([
                  {
                    engine: "chromium", label: "IDFRI Browser", runtime: "IDFRI Chromium 内核",
                    path: "M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 16.364a4.364 4.364 0 1 1 0-8.728 4.364 4.364 0 0 1 0 8.728Z",
                  },
                  {
                    engine: "firefox", label: "Firefox", runtime: "AliasMode Firefox",
                    path: "M8.824 7.287c.008 0 .004 0 0 0zm-2.8-1.4c.006 0 .003 0 0 0zm16.754 2.161c-.505-1.215-1.53-2.528-2.333-2.943.654 1.283 1.033 2.57 1.177 3.53l.002.02c-1.314-3.278-3.544-4.6-5.366-7.477-.091-.147-.184-.292-.273-.446a3.545 3.545 0 01-.13-.24 2.118 2.118 0 01-.172-.46.03.03 0 00-.027-.03.038.038 0 00-.021 0l-.006.001a.037.037 0 00-.01.005L15.624 0c-2.585 1.515-3.657 4.168-3.932 5.856a6.197 6.197 0 00-2.305.587.297.297 0 00-.147.37c.057.162.24.24.396.17a5.622 5.622 0 012.008-.523l.067-.005a5.847 5.847 0 011.957.222l.095.03a5.816 5.816 0 01.616.228c.08.036.16.073.238.112l.107.055a5.835 5.835 0 01.368.211 5.953 5.953 0 012.034 2.104c-.62-.437-1.733-.868-2.803-.681 4.183 2.09 3.06 9.292-2.737 9.02a5.164 5.164 0 01-1.513-.292 4.42 4.42 0 01-.538-.232c-1.42-.735-2.593-2.121-2.74-3.806 0 0 .537-2 3.845-2 .357 0 1.38-.998 1.398-1.287-.005-.095-2.029-.9-2.817-1.677-.422-.416-.622-.616-.8-.767a3.47 3.47 0 00-.301-.227 5.388 5.388 0 01-.032-2.842c-1.195.544-2.124 1.403-2.8 2.163h-.006c-.46-.584-.428-2.51-.402-2.913-.006-.025-.343.176-.389.206-.406.29-.787.616-1.136.974-.397.403-.76.839-1.085 1.303a9.816 9.816 0 00-1.562 3.52c-.003.013-.11.487-.19 1.073-.013.09-.026.181-.037.272a7.8 7.8 0 00-.069.667l-.002.034-.023.387-.001.06C.386 18.795 5.593 24 12.016 24c5.752 0 10.527-4.176 11.463-9.661.02-.149.035-.298.052-.448.232-1.994-.025-4.09-.753-5.844z",
                  },
                ] as const).map(({ engine, label, runtime, path }) => (
                  <div className="browser-option" key={engine}>
                    <label className="browser-card">
                      <input type="radio" name="browser-engine" value={engine} checked={form.engine === engine} onChange={() => setF("engine", engine)} />
                      <svg className="browser-logo" viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>
                      <span>{label}</span>
                    </label>
                    <button type="button" className="browser-info tip" data-tip={runtime} aria-label={`${label}: ${runtime}`}><Icon name="help" className="sm" /></button>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={closeCreate}>取消</button>
              <button className="btn primary" disabled={creating} onClick={submitCreate}>{creating ? "正在创建…" : "创建资料"}</button>
            </div>
          </div>
        </div>
      )}

      {editId && (
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-profile-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head" id="edit-profile-title">
              <Icon name="edit" />编辑资料<span className="mono muted">{editId}</span>
              <button type="button" className="modal-close" aria-label="关闭" onClick={closeEdit}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {editErr && <div className="modal-err"><Icon name="alert" className="sm" />{editErr}</div>}
              {editLoading ? (
                <p className="hint" role="status">正在加载资料…</p>
              ) : (
                <>
                  {editForm.proxyError && <div className="modal-err"><Icon name="alert" className="sm" />已保存的代理已隔离：{editForm.proxyError}。请在下方更换代理或清空此字段。</div>}
                  {(editLive || (!isCloudMode && editRunning)) && (
                    <p className="hint" role="status">
                      {editLive
                        ? "此浏览器已打开。更改会立即保存到此设备，并在浏览器关闭时同步到 Cloud。"
                        : "此浏览器已打开。更改会立即保存，并在下次启动时应用。"}
                    </p>
                  )}
                  {!isCloudMode && editMobile && (
                    <div className="persona-warning">
                      <strong><Icon name="warning" className="sm" />导入的移动端身份无法安全打开</strong>
                      <span>
                        旧版 IDFRI 会将其作为桌面浏览器打开：Android 转为 Windows，iPhone/iPad 转为 macOS。虽然看似可用，但并非一致的移动端模拟。
                      </span>
                      <span>
                        请将其一次性转换为 {editMobile.platform === "macos" ? "macOS" : "Windows"} 桌面身份。Cookie、登录/会话、代理、时区、凭据和指纹种子都会保留
                        {editMobile.screenChanged ? `；移动端屏幕尺寸将改为 ${editMobile.resolution}` : "；现有桌面屏幕尺寸会保留"}。
                      </span>
                      <button className="btn persona-convert" disabled={editSaving} onClick={convertEditedMobile}>
                        {editSaving ? "正在转换…" : `转换为 ${editMobile.platform === "macos" ? "macOS" : "Windows"} 桌面身份`}
                      </button>
                    </div>
                  )}
                  <div className="fld-row">
                    <label className="fld grow">
                      <span>名称</span>
                      <input value={editForm.name ?? ""} onChange={(e) => setEF("name", e.target.value)} />
                    </label>
                    {!isCloudMode && (
                      <label className="fld no">
                        <span>自定义编号</span>
                        <input
                          value={editForm.customNo ?? ""}
                          inputMode="numeric"
                          maxLength={MAX_CUSTOM_NO}
                          placeholder={editSerial != null ? String(editSerial) : "自动"}
                          onChange={(e) => setEF("customNo", e.target.value.replace(/\D/g, "").slice(0, MAX_CUSTOM_NO))}
                        />
                        <small>仅限数字；留空时使用序号</small>
                      </label>
                    )}
                  </div>
                  <div className="fld-row">
                    <label className="fld grow">
                      <span>分组</span>
                      <GroupPicker value={editForm.group ?? ""} onChange={(v) => setEF("group", v)} groups={editableGroups} allowCreate={!isCloudMode} />
                    </label>
                    <label className="fld grow">
                      <span>平台</span>
                      <PlatformPicker value={editForm.platform ?? ""} onChange={(v) => setEF("platform", v)} />
                    </label>
                  </div>
                  <label className="fld">
                    <span>浏览器</span>
                    <input value={editEngine === "firefox" ? "AliasMode Firefox" : "IDFRI Browser"} readOnly className="ro" />
                    <small>{editEngine === "firefox"
                      ? "原生 Firefox 资料 · 不支持 CDP、PDF 或 Chrome 扩展."
                      : "支持 CDP、PDF 和 Chrome 扩展。"}</small>
                  </label>
                  <label className="fld">
                    <span>标签 <span className="muted">（逗号分隔）</span></span>
                    <input value={editForm.tags ?? ""} placeholder="预热, 美国, 优先" onChange={(e) => setEF("tags", e.target.value)} />
                  </label>
                  <label className="fld">
                    <span>启动页</span>
                    <input value={editForm.startupUrl ?? ""} placeholder="https://example.com/（留空时按账号平台打开）" onChange={(e) => setEF("startupUrl", e.target.value)} />
                  </label>
                  <label className="fld">
                    <span>备注</span>
                    <textarea value={editForm.note ?? ""} placeholder="仅保存在本机" onChange={(e) => setEF("note", e.target.value)} />
                  </label>
                  <div className="fld-row">
                    <label className="fld type">
                      <span>代理类型</span>
                      <select value={editForm.proxyType ?? "http"} onChange={(e) => setEF("proxyType", e.target.value)}>
                        <option value="http">http</option>
                        <option value="https">https</option>
                        <option value="socks5">socks5</option>
                      </select>
                    </label>
                    <label className="fld grow">
                      <span>代理</span>
                      <input value={editForm.proxy ?? ""} placeholder="host:port:username:password" onChange={(e) => setEF("proxy", e.target.value)} />
                      <small>留空时使用直连。</small>
                    </label>
                  </div>
                  <div className="proxy-check-actions">
                    <button
                      type="button"
                      className="btn proxy-check-btn"
                      disabled={editProxyCheck.checking || !editHasProxy}
                      aria-busy={editProxyCheck.checking}
                      onClick={checkEditedProxy}
                    >
                      <Icon name="activity" className="sm" />
                      {editProxyCheck.checking ? "正在检测…" : "检测代理"}
                    </button>
                  </div>
                  <ProxyCheckFeedback hasProxy={editHasProxy} state={editProxyCheck} />
                  {!isCloudMode && (
                    <>
                      <label className="fld">
                        <span>时区</span>
                        <input
                          value={editForm.timezone ?? ""}
                          placeholder="Asia/Kolkata"
                          onChange={(e) => setEF("timezone", e.target.value)}
                        />
                        <small>填写 IANA 时区名称；浏览器时间会按该时区自然计算。</small>
                      </label>
                      <div className="proxy-check-actions">
                        <button
                          type="button"
                          className="btn proxy-check-btn"
                          disabled={timezoneBusy || !editHasProxy}
                          onClick={refreshEditedTimezone}
                        >
                          <Icon name="activity" className="sm" />
                          {timezoneBusy ? "正在同步时区和语言…" : "按代理同步时区和语言"}
                        </button>
                      </div>
                    </>
                  )}
                  <div className="fld-row">
                    <CopyField label="用户名" value={editForm.username ?? ""} onChange={(value) => setEF("username", value)} />
                    <CopyField label="密码" value={editForm.password ?? ""} onChange={(value) => setEF("password", value)} />
                  </div>
                  <div className="fld-row">
                    <CopyField label="邮箱" value={editForm.email ?? ""} onChange={(value) => setEF("email", value)} />
                    <CopyField label="邮箱密码" value={editForm.emailPassword ?? ""} onChange={(value) => setEF("emailPassword", value)} />
                  </div>
                  <CopyField label="2FA 密钥" value={editForm.twofa ?? ""} onChange={(value) => setEF("twofa", value)} />
                  {!isCloudMode && editTotp && (
                    <div className="authrow">
                      <span className="authlabel">动态验证码</span>
                      <span className="authcode">{editTotp.code.slice(0, 3)} {editTotp.code.slice(3)}</span>
                      <span className="authsecs" title="距离刷新剩余秒数">{editTotp.secs}s</span>
                      <button className="btn xs" onClick={() => navigator.clipboard?.writeText(editTotp.code)}>
                        <Icon name="copy" className="sm" />复制
                      </button>
                    </div>
                  )}
                  <FingerprintSettings
                    engine={editEngine}
                    screen={editForm.resolution ?? ""}
                    values={editForm}
                    onScreenChange={(value) => setEF("resolution", value)}
                    onChange={setEF}
                  />
                  {editEngine === "chromium" && editExtensionChoices.length > 0 && (
                    <div className="fld">
                      <span>扩展</span>
                      <div className="extassign">
                        {editExtensionChoices.map((x) => (
                          <label key={x.id} className="extchk">
                            <input type="checkbox" checked={editExts.includes(x.id)} onChange={() => toggleEditExt(x.id)} />
                            <span>{x.name}{x.missing && <span className="muted"> · 本机未安装</span>}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  <p className="formnote">
                    Cookie 和锁定的指纹值会保留，只修改可编辑字段。
                    {editEngine === "chromium" && " 扩展会在浏览器打开时加载。"}
                  </p>
                </>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={closeEdit}>取消</button>
              <button className="btn primary" disabled={editSaving || editLoading} onClick={saveEdit}>{editSaving ? "正在保存…" : "保存更改"}</button>
            </div>
          </div>
        </div>
      )}

      {showBulk && (
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <Icon name="fileImport" />导入资料
              <button type="button" className="modal-close" aria-label="关闭" onClick={closeBulk}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {bulkErr && <div className="modal-err"><Icon name="alert" className="sm" />{bulkErr}</div>}

              <div className="segmented" role="tablist" aria-label="导入来源">
                <button
                  type="button"
                  role="tab"
                  aria-selected={bulkSource === "file"}
                  className={bulkSource === "file" ? "active" : ""}
                  onClick={() => { setBulkSource("file"); setBulkText(""); }}
                >
                  <Icon name="fileImport" className="sm" />从文件导入
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={bulkSource === "paste"}
                  className={bulkSource === "paste" ? "active" : ""}
                  onClick={() => { setBulkSource("paste"); setBulkFiles([]); }}
                >
                  <Icon name="copy" className="sm" />粘贴文本
                </button>
              </div>

              {bulkSource === "file" ? (
                <>
                  <div
                    className={`bulkdrop${bulkOver ? " over" : ""}`}
                    onClick={() => bulkFileRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); if (!bulkOver) setBulkOver(true); }}
                    onDragLeave={(e) => { e.preventDefault(); setBulkOver(false); }}
                    onDrop={(e) => { e.preventDefault(); setBulkOver(false); if (e.dataTransfer.files?.length) setBulkFiles(Array.from(e.dataTransfer.files)); }}
                  >
                    <Icon name="fileImport" />
                    <b>拖放文件，或点击选择</b>
                    <div className="sub">支持 AdsPower、GoLogin、Multilogin、Dolphin Anty、HideMyAcc、Incogniton、Donut 等浏览器导出的 TXT、CSV、JSON 或 XLSX 文件</div>
                  </div>
                  {bulkFiles.length > 0 && (
                    <div className="filelist">
                      {bulkFiles.map((file) => (
                        <span className="filechip" key={file.name}>
                          <Icon name="file" className="sm" />
                          <span className="fname">{file.name}</span>
                          <button
                            type="button"
                            aria-label={`移除 ${file.name}`}
                            onClick={() => setBulkFiles((files) => files.filter((candidate) => candidate !== file))}
                          ><Icon name="close" className="sm" /></button>
                        </span>
                      ))}
                      <button type="button" className="btn xs ghost" onClick={() => setBulkFiles([])}>全部清除</button>
                    </div>
                  )}
                </>
              ) : (
                <label className="fld">
                  <span>AdsPower TXT 记录</span>
                  <textarea
                    rows={9}
                    value={bulkText}
                    placeholder={"id=k1example01\ngroup=Warmup\nname=alice\n…"}
                    onChange={(event) => setBulkText(event.target.value)}
                  />
                  <small>{pastedRecordCount === null
                    ? "粘贴一条或多条 key=value 记录，并用星号行分隔。"
                    : `检测到 ${pastedRecordCount} 条记录，每条记录都以自己的 id= 行开始。`}</small>
                </label>
              )}

              <input
                ref={bulkFileRef}
                type="file"
                multiple
                accept=".csv,.txt,.json,.xlsx,text/plain,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                style={{ display: "none" }}
                onChange={(e) => { if (e.target.files) setBulkFiles(Array.from(e.target.files)); e.target.value = ""; }}
              />

              <div className="fld-row">
                <label className="fld grow">
                  <span>{isCloudMode ? "目标文件夹" : "分配到分组"}</span>
                  <GroupPicker value={bulkGroup} onChange={setBulkGroup} groups={isCloudMode ? editableGroups : existingGroups} allowCreate={!isCloudMode} />
                </label>
                <label className="fld grow">
                  <span>平台</span>
                  <select value={bulkPlatform} onChange={(e) => setBulkPlatform(e.target.value)}>
                    {KNOWN_PLATFORMS.map((platform) => <option key={platform.value} value={platform.value}>{platform.label}</option>)}
                  </select>
                </label>
              </div>
              <p className="formnote">
                上方选择会覆盖每条导入记录中的对应字段，包括导出文件中已有的分组。
              </p>
              <p className="formnote">
                IDFRI 导出还包含 <code>seed</code>、<code>timezone</code> 和 <code>platform_os</code>，用于重建相同的浏览器指纹。
                <code>fp_*</code> 列只是已测量指纹的<b>记录</b>，会在浏览器打开后核对，不会作为设置应用。
              </p>
            </div>
            <div className="modal-foot">
              <button className="tlink" onClick={() => downloadText("idfri-template.csv", CSV_TEMPLATE, "text/csv")}>
                <Icon name="export" className="sm" />CSV 模板
              </button>
              <button className="tlink" onClick={() => downloadText("idfri-example.txt", TXT_EXAMPLE, "text/plain")}>
                <Icon name="export" className="sm" />TXT 示例
              </button>
              <span className="spacer" />
              <button className="btn ghost" onClick={closeBulk}>取消</button>
              <button className="btn primary" disabled={bulkBusy || (!bulkFiles.length && !bulkText.trim()) || (isCloudMode && !bulkGroup)} onClick={submitBulk}>
                <Icon name="fileImport" className="sm" />{bulkBusy ? "正在导入…" : "导入"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showUpdate && (
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">从文件更新资料<button type="button" className="modal-close" aria-label="关闭" onClick={() => setShowUpdate(false)}><Icon name="close" className="sm" /></button></div>
            <div className="modal-body">
              {updateErr && <div className="modal-err"><Icon name="alert" className="sm" />{updateErr}</div>}
              {updateResult && <div className="modal-ok"><Icon name="check" className="sm" />{updateResult}</div>}
              <ol className="steps">
                <li><b>导出</b>要修改的资料，文件中的 <code>id</code> 用于匹配资料。</li>
                <li><b>编辑</b>需要修改的列（名称、用户名、密码、2FA、代理等）。保留 <code>id</code> 列，删除不想修改的列。</li>
                {!isCloudMode && <li>添加 <code>custom_no</code> 列可批量修改编号；该编号会显示在资料列表和浏览器窗口标题中。</li>}
                <li>在下方<b>重新上传</b>编辑后的文件。Cookie 和指纹会保留；修改 <code>cookie</code> 或 <code>ua</code> 列不会生效。</li>
                {isCloudMode && <li>更新前请关闭资料。每个 Cloud 资料会单独保存；即使其他资料失败，成功的更新仍会保留。</li>}
              </ol>
              <div className="updexport">
                {selected.size > 0 ? (
                  <span>
                    导出所选 {selected.size} 项：&nbsp;
                    <button className="tlink" onClick={() => exportSelected("csv")}><Icon name="export" className="sm" />CSV</button>
                    &nbsp;·&nbsp;
                    <button className="tlink" onClick={() => exportSelected("txt")}><Icon name="export" className="sm" />.txt</button>
                    &nbsp;·&nbsp;
                    <button className="tlink" onClick={() => exportSelected("xlsx")}><Icon name="export" className="sm" />Excel</button>
                  </span>
                ) : (
                  <span className="hint">提示：先选择资料，再从这里导出可编辑文件。</span>
                )}
                <span className="grow" />
                <button className="tlink" onClick={() => downloadText("idfri-update-template.csv", UPDATE_TEMPLATE_CSV, "text/csv")}><Icon name="export" className="sm" />示例表格</button>
              </div>
              <div
                className={`bulkdrop${updateOver ? " over" : ""}`}
                onClick={() => updateFileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); if (!updateOver) setUpdateOver(true); }}
                onDragLeave={(e) => { e.preventDefault(); setUpdateOver(false); }}
                onDrop={(e) => { e.preventDefault(); setUpdateOver(false); if (e.dataTransfer.files?.[0]) setUpdateFile(e.dataTransfer.files[0]); }}
              >
                <Icon name="export" />
                <b>拖放编辑后的文件，或点击选择</b>
                <div className="sub">包含 <code>id</code> 列的 CSV、TXT 或 Excel XLSX 文件</div>
              </div>
              <input
                ref={updateFileRef}
                type="file"
                accept=".csv,.txt,.xlsx,text/plain,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                style={{ display: "none" }}
                onChange={(e) => { if (e.target.files?.[0]) setUpdateFile(e.target.files[0]); e.target.value = ""; }}
              />
              {updateFile && <div className="bulkfiles"><Icon name="file" className="sm" />已选择：<b>{updateFile.name}</b></div>}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setShowUpdate(false)}>关闭</button>
              <button className="btn primary" disabled={updateBusy || !updateFile} onClick={submitUpdate}>{updateBusy ? "正在更新…" : "更新资料"}</button>
            </div>
          </div>
        </div>
      )}
      <ScriptRunPanel
        open={scriptRunOpen}
        selectedProfiles={scriptRunProfiles}
        onClose={() => setScriptRunOpen(false)}
      />
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);

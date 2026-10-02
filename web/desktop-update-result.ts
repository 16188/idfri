export type DesktopUpdateFailureReason =
  | "browserCleanup"
  | "installerLaunch"
  | "installationUnconfirmed"
  | "startupMismatch";

export type DesktopUpdateResult =
  | { state: "succeeded"; fromVersion: string; version: string }
  | { state: "installedRelaunchUnconfirmed"; version: string }
  | {
      state: "failedOrInterrupted";
      fromVersion: string;
      expectedVersion: string;
      reason: DesktopUpdateFailureReason;
    };

export interface DesktopUpdateResultSummary {
  tone: "success" | "warning" | "error";
  title: string;
  detail: string;
}

const FAILURE_REASONS = new Set<DesktopUpdateFailureReason>([
  "browserCleanup",
  "installerLaunch",
  "installationUnconfirmed",
  "startupMismatch",
]);

function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

export function parseDesktopUpdateResult(value: unknown): DesktopUpdateResult | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") {
    throw new Error("IDFRI 返回了无效的更新结果。");
  }
  const result = value as Record<string, unknown>;
  if (
    result.state === "succeeded" &&
    isVersion(result.fromVersion) &&
    isVersion(result.version)
  ) {
    return {
      state: "succeeded",
      fromVersion: result.fromVersion,
      version: result.version,
    };
  }
  if (result.state === "installedRelaunchUnconfirmed" && isVersion(result.version)) {
    return { state: "installedRelaunchUnconfirmed", version: result.version };
  }
  if (
    result.state === "failedOrInterrupted" &&
    isVersion(result.fromVersion) &&
    isVersion(result.expectedVersion) &&
    typeof result.reason === "string" &&
    FAILURE_REASONS.has(result.reason as DesktopUpdateFailureReason)
  ) {
    return {
      state: "failedOrInterrupted",
      fromVersion: result.fromVersion,
      expectedVersion: result.expectedVersion,
      reason: result.reason as DesktopUpdateFailureReason,
    };
  }
  throw new Error("IDFRI 返回了无效的更新结果。");
}

export function describeDesktopUpdateResult(result: DesktopUpdateResult): DesktopUpdateResultSummary {
  if (result.state === "succeeded") {
    return {
      tone: "success",
      title: `IDFRI ${result.version} 已安装。`,
      detail: `已从 ${result.fromVersion} 更新，并在重启后验证安装。`,
    };
  }
  if (result.state === "installedRelaunchUnconfirmed") {
    return {
      tone: "warning",
      title: `IDFRI ${result.version} 已安装。`,
      detail: "无法确认自动重启。请关闭 IDFRI，然后从 Windows“开始”菜单重新启动。",
    };
  }

  const detail = result.reason === "browserCleanup"
    ? `浏览器服务无法安全关闭，IDFRI ${result.fromVersion} 仍保持安装。`
    : result.reason === "installerLaunch"
      ? `IDFRI ${result.expectedVersion} 无法启动，当前仍为 ${result.fromVersion}。`
      : result.reason === "startupMismatch"
        ? `无法在预期安装位置验证 IDFRI ${result.expectedVersion}。请关闭 IDFRI，然后从 Windows“开始”菜单重新启动。`
        : `无法确认 IDFRI ${result.expectedVersion}。如果版本没有变化，请直接运行完整离线安装包，无需卸载。`;
  return {
    tone: "error",
    title: "上次更新未完成。",
    detail,
  };
}

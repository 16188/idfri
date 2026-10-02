export interface ParsedProxyInput {
  type: "http" | "socks5";
  host: string;
  port: string;
  user: string;
  pass: string;
}

function proxyType(value: string, fallback: "http" | "socks5"): "http" | "socks5" {
  const normalized = value.trim().toLowerCase().replace(/:$/, "");
  if (!normalized) return fallback;
  if (normalized === "socks" || normalized === "socks5") return "socks5";
  if (normalized === "http") return "http";
  throw new Error(`不支持的代理类型“${normalized}”（请使用 http 或 socks5）`);
}

function decoded(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`代理${label}包含无效的百分号编码`);
  }
}

function validate(result: ParsedProxyInput): ParsedProxyInput {
  if (!result.host.trim()) throw new Error("代理主机不能为空");
  const port = Number(result.port);
  if (!/^\d+$/.test(result.port) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`代理端口无效：${result.port || "（空）"}`);
  }
  if (!result.user && result.pass) throw new Error("填写代理密码时必须同时填写用户名");
  return { ...result, host: result.host.trim(), port: String(port) };
}

/** Browser-side convenience parser; the API performs authoritative validation again. */
export function parsePastedProxy(
  value: string,
  fallbackType: "http" | "socks5" = "http",
): ParsedProxyInput {
  const raw = value.trim();
  if (!raw) throw new Error("请先粘贴代理");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("代理 URL 无效");
    }
    if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
      throw new Error("代理 URL 不能包含路径、查询参数或片段");
    }
    return validate({
      type: proxyType(url.protocol, fallbackType),
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port,
      user: decoded(url.username, "用户名"),
      pass: decoded(url.password, "密码"),
    });
  }

  const ipv6 = raw.match(/^\[([^\]]+)]:(\d+)(?::([^:]*)(?::(.*))?)?$/);
  if (ipv6) {
    return validate({
      type: fallbackType,
      host: ipv6[1]!,
      port: ipv6[2]!,
      user: ipv6[3] ?? "",
      pass: ipv6[4] ?? "",
    });
  }

  const parts = raw.split(":");
  if (parts.length < 2) throw new Error("代理必须是 主机:端口:用户名:密码 格式或代理 URL");
  return validate({
    type: fallbackType,
    host: parts[0]!,
    port: parts[1]!,
    user: parts[2] ?? "",
    // Passwords can contain colons; everything after the username belongs to it.
    pass: parts.slice(3).join(":"),
  });
}

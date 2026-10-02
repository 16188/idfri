import { randomBytes } from "node:crypto";

const TOKEN_RE = /^[a-f0-9]{64}$/;

export function createLocalApiToken(): string {
  return randomBytes(32).toString("hex");
}

function loopbackHost(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(`http://${value}`);
    return !parsed.username && !parsed.password
      && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  } catch {
    return false;
  }
}

function sameLoopbackOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.origin === new URL(request.url).origin
      && parsed.protocol === "http:"
      && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  } catch {
    return false;
  }
}

export function authorizeLocalApiRequest(request: Request, token: string): Response | null {
  if (!loopbackHost(request.headers.get("host")) || !sameLoopbackOrigin(request)) {
    return Response.json(
      { code: -1, msg: "Local API request origin is not allowed", data: {} },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  if (!TOKEN_RE.test(token) || request.headers.get("authorization") !== `Bearer ${token}`) {
    return Response.json(
      { code: -1, msg: "Local API token is missing or invalid", data: {} },
      {
        status: 401,
        headers: {
          "cache-control": "no-store",
          "www-authenticate": "Bearer",
        },
      },
    );
  }
  return null;
}

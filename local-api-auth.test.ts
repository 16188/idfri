import { expect, test } from "bun:test";
import {
  authorizeLocalApiRequest,
  createLocalApiToken,
} from "./local-api-auth.ts";

const TOKEN = "a".repeat(64);

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:50400/api/v1/status", {
    headers: { host: "127.0.0.1:50400", authorization: `Bearer ${TOKEN}`, ...headers },
  });
}

test("local API tokens are random 256-bit lowercase hex values", () => {
  const first = createLocalApiToken();
  const second = createLocalApiToken();
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(second).toMatch(/^[a-f0-9]{64}$/);
  expect(first).not.toBe(second);
});

test("local API accepts only its bearer token and loopback Host/Origin", () => {
  expect(authorizeLocalApiRequest(request(), TOKEN)).toBeNull();
  expect(authorizeLocalApiRequest(request({ origin: "http://127.0.0.1:50400" }), TOKEN)).toBeNull();
  expect(authorizeLocalApiRequest(request({ authorization: "Bearer wrong" }), TOKEN)?.status).toBe(401);
  expect(authorizeLocalApiRequest(request({ host: "attacker.example" }), TOKEN)?.status).toBe(403);
  expect(authorizeLocalApiRequest(request({ origin: "https://attacker.example" }), TOKEN)?.status).toBe(403);
  expect(authorizeLocalApiRequest(request({ origin: "http://127.0.0.1:50401" }), TOKEN)?.status).toBe(403);
});

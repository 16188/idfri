import { expect, test } from "bun:test";
import { ProfileFieldCipher } from "./profile-crypto.ts";

const KEY = "42".repeat(32);

test("profile fields use randomized authenticated encryption bound to their row and column", () => {
  const cipher = new ProfileFieldCipher(KEY);
  const first = cipher.encrypt("private-value", "profile-1", "password");
  const second = cipher.encrypt("private-value", "profile-1", "password");
  expect(first).toStartWith("idfri:v1:");
  expect(second).not.toBe(first);
  expect(cipher.decrypt(first, "profile-1", "password")).toBe("private-value");
  expect(() => cipher.decrypt(first, "profile-2", "password")).toThrow("invalid encrypted password");
  expect(() => cipher.decrypt(first, "profile-1", "twofa")).toThrow("invalid encrypted twofa");
  cipher.destroy();
});

test("legacy plaintext remains readable but encrypted values require the stored key", () => {
  expect(new ProfileFieldCipher().decrypt("legacy", "profile-1", "password")).toBe("legacy");
  const encrypted = new ProfileFieldCipher(KEY).encrypt("secret", "profile-1", "password");
  expect(() => new ProfileFieldCipher().decrypt(encrypted, "profile-1", "password"))
    .toThrow("requires its Windows Credential Manager key");
});

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const PREFIX = "idfri:v1:";
const KEY_RE = /^[a-f0-9]{64}$/;

export class ProfileFieldCipher {
  private readonly key: Buffer | null;

  constructor(keyHex?: string) {
    if (keyHex === undefined) {
      this.key = null;
      return;
    }
    if (!KEY_RE.test(keyHex)) {
      throw new Error("IDFRI_PROFILE_KEY must be 64 lowercase hexadecimal characters");
    }
    this.key = Buffer.from(keyHex, "hex");
  }

  encrypt(value: string, profileId: string, column: string): string {
    if (!this.key || value === "") return value;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(this.aad(profileId, column));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `${PREFIX}${nonce.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
  }

  decrypt(value: unknown, profileId: string, column: string): string {
    if (typeof value !== "string" || !value.startsWith(PREFIX)) return typeof value === "string" ? value : "";
    if (!this.key) throw new Error("encrypted profile data requires its Windows Credential Manager key");
    const parts = value.slice(PREFIX.length).split(":");
    if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("invalid encrypted profile field");
    try {
      const [nonce, tag, ciphertext] = parts.map((part) => Buffer.from(part!, "base64url"));
      if (nonce!.byteLength !== 12 || tag!.byteLength !== 16) throw new Error("invalid envelope");
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce!);
      decipher.setAAD(this.aad(profileId, column));
      decipher.setAuthTag(tag!);
      return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString("utf8");
    } catch {
      throw new Error(`profile ${profileId} has invalid encrypted ${column}`);
    }
  }

  destroy(): void {
    this.key?.fill(0);
  }

  private aad(profileId: string, column: string): Buffer {
    return Buffer.from(`idfri-profile:v1:${profileId}:${column}`, "utf8");
  }
}

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derivedKey = scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
}

export function verifyPassword(password: string, encodedHash: string): boolean {
  const [algorithm, saltEncoded, keyEncoded, extra] = encodedHash.split("$");
  if (algorithm !== "scrypt" || !saltEncoded || !keyEncoded || extra !== undefined) {
    return false;
  }

  try {
    const salt = Buffer.from(saltEncoded, "base64url");
    const expectedKey = Buffer.from(keyEncoded, "base64url");
    if (salt.length !== 16 || expectedKey.length !== KEY_LENGTH) {
      return false;
    }

    const derivedKey = scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
    return timingSafeEqual(derivedKey, expectedKey);
  } catch {
    return false;
  }
}

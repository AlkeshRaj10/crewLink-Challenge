import "dotenv/config";
import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_SECONDS = 60 * 60;
const TOKEN_HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("JWT_SECRET must be set to at least 32 bytes");
  }
  return secret;
}

export function validateAuthConfig(): void {
  getSecret();
}

function sign(input: string): Buffer {
  return createHmac("sha256", getSecret()).update(input).digest();
}

export interface AccessTokenClaims {
  sub: string;
  exp: number;
}

export function createAccessToken(userId: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
  })).toString("base64url");
  const unsignedToken = `${TOKEN_HEADER}.${payload}`;
  return `${unsignedToken}.${sign(unsignedToken).toString("base64url")}`;
}

export function verifyAccessToken(token: string, nowSeconds = Math.floor(Date.now() / 1000)): AccessTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_HEADER) {
    return null;
  }

  const [header, payload, signature] = parts;
  try {
    const receivedSignature = Buffer.from(signature, "base64url");
    const expectedSignature = sign(`${header}.${payload}`);
    if (receivedSignature.length !== expectedSignature.length ||
        !timingSafeEqual(receivedSignature, expectedSignature)) {
      return null;
    }

    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      typeof claims !== "object" ||
      claims === null ||
      !("sub" in claims) ||
      typeof claims.sub !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claims.sub) ||
      !("exp" in claims) ||
      typeof claims.exp !== "number" ||
      !Number.isInteger(claims.exp) ||
      claims.exp <= nowSeconds
    ) {
      return null;
    }

    return { sub: claims.sub, exp: claims.exp };
  } catch {
    return null;
  }
}

export const accessTokenTtlSeconds = TOKEN_TTL_SECONDS;

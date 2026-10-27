import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { hashPassword, verifyPassword } from "./password.js";
import { createAccessToken, verifyAccessToken } from "./token.js";

process.env.JWT_SECRET = "test-only-secret-with-at-least-thirty-two-bytes";

test("password hashes verify without storing plaintext", () => {
  const hash = hashPassword("test-password");
  assert.notEqual(hash, "test-password");
  assert.equal(verifyPassword("test-password", hash), true);
  assert.equal(verifyPassword("wrong-password", hash), false);
  assert.equal(verifyPassword("test-password", "not-a-valid-hash"), false);
});

test("access tokens reject tampering and expired claims", () => {
  const userId = "123e4567-e89b-42d3-a456-426614174000";
  const token = createAccessToken(userId, 1_800_000_000);
  assert.deepEqual(verifyAccessToken(token, 1_800_000_001), {
    sub: userId,
    exp: 1_800_003_600,
  });
  assert.equal(verifyAccessToken(token, 1_800_003_600), null);

  const [header, payload, signature] = token.split(".");
  const tampered = `${header}.${payload}.${signature.slice(0, -1)}x`;
  assert.equal(verifyAccessToken(tampered, 1_800_000_001), null);
  const tamperedPayload = Buffer.from(JSON.stringify({
    sub: "123e4567-e89b-42d3-a456-426614174001",
    iat: 1_800_000_000,
    exp: 1_800_003_600,
  })).toString("base64url");
  assert.equal(verifyAccessToken(`${header}.${tamperedPayload}.${signature}`, 1_800_000_001), null);
  assert.equal(verifyAccessToken(createAccessToken(userId, 1_800_000_000), 1_800_003_600), null);

  const rolePayload = Buffer.from(JSON.stringify({
    sub: userId,
    iat: 1_800_000_000,
    exp: 1_800_003_600,
    role: "leader",
    localId: "123e4567-e89b-42d3-a456-426614174001",
  })).toString("base64url");
  const roleTokenInput = `${header}.${rolePayload}`;
  const jwtSecret = process.env.JWT_SECRET;
  assert.ok(jwtSecret);
  const roleSignature = createHmac("sha256", jwtSecret)
    .update(roleTokenInput)
    .digest("base64url");
  assert.deepEqual(verifyAccessToken(`${roleTokenInput}.${roleSignature}`, 1_800_000_001), {
    sub: userId,
    exp: 1_800_003_600,
  });
});

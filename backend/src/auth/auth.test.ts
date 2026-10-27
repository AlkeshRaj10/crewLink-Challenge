import assert from "node:assert/strict";
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

test("access tokens require a valid signature and an unexpired user claim", () => {
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
});

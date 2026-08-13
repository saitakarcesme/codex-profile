import assert from "node:assert/strict";
import test from "node:test";
import { inspectAuth } from "../src/auth.js";
import { fakeAuth } from "./helpers.js";

test("inspectAuth extracts display metadata without returning tokens", () => {
  const identity = inspectAuth(fakeAuth("account-1", "first@example.test"));
  assert.equal(identity.email, "first@example.test");
  assert.equal(identity.name, "User account-1");
  assert.equal(identity.planType, "plus");
  assert.equal(identity.status, "ready");
  assert.equal(Object.hasOwn(identity, "access_token"), false);
  assert.equal(JSON.stringify(identity).includes("refresh-account-1"), false);
});

test("inspectAuth rejects malformed credentials", () => {
  assert.throws(() => inspectAuth({ auth_mode: "chatgpt", tokens: {} }), /recognizable/);
});

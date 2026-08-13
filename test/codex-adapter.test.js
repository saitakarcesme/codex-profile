import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loginInto } from "../src/codex-adapter.js";
import { tempEnvironment } from "./helpers.js";

const fixtureCodex = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex.js");

test("an abandoned Codex login times out without changing the shared auth slot", async (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  const staging = path.join(fixture.root, "staging-login");
  const beforeSharedAuth = path.join(fixture.codexHome, "auth.json");
  const env = {
    ...fixture.env,
    CODEX_PROFILE_CODEX_BIN: process.execPath,
    CODEX_PROFILE_CODEX_PREFIX: JSON.stringify([fixtureCodex]),
    FAKE_CODEX_LOGIN_HANG: "1",
  };

  await assert.rejects(loginInto(staging, { env, timeoutMs: 50 }), /login timed out/);
  assert.equal(fs.existsSync(beforeSharedAuth), false);
});

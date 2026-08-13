import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readAvailableModels } from "../src/app-server.js";
import { tempEnvironment } from "./helpers.js";

const fakeCodex = path.join(import.meta.dirname, "fixtures", "fake-codex.js");

test("model catalog adapter returns a credential-free projection", async (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  const env = {
    ...fixture.env,
    CODEX_PROFILE_CODEX_BIN: process.execPath,
    CODEX_PROFILE_CODEX_PREFIX: JSON.stringify([fakeCodex]),
  };

  const models = await readAvailableModels(fixture.codexHome, env);
  assert.deepEqual(models, [{
    id: "model-1",
    model: "gpt-test",
    displayName: "GPT Test",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low"],
  }]);
  assert.equal(Object.hasOwn(models[0], "description"), false);
});

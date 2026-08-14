import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fetchAccountAvatar, _test } from "../src/avatar.js";
import { fakeAuth, tempEnvironment, writeJson } from "./helpers.js";

function response(body, { status = 200, type = "application/json", url = "https://chatgpt.com/backend-api/me" } = {}) {
  return new Response(body, { status, headers: { "content-type": type } });
}

test("account avatar is discovered dynamically and downloaded without exposing credentials", async (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  const authFile = path.join(fixture.root, "auth.json");
  writeJson(authFile, fakeAuth("account-1", "first@example.test"));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === _test.PROFILE_ENDPOINT) {
      return response(JSON.stringify({ picture: "https://images.example.test/avatar" }));
    }
    const image = response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { type: "image/png", url: String(url) });
    Object.defineProperty(image, "url", { value: String(url) });
    return image;
  };

  const avatar = await fetchAccountAvatar(authFile, { fetchImpl, platform: "darwin" });
  assert.equal(avatar.extension, "png");
  assert.deepEqual(avatar.bytes, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.equal(calls.length, 2);
  assert.match(calls[0].options.headers.authorization, /^Bearer /);
  assert.equal(JSON.stringify(avatar).includes("refresh-account-1"), false);
  assert.match(calls[0].options.headers["user-agent"], /^ChatGPTBrowser\/26\.810\.41047 /);
});

test("avatar discovery rejects insecure URLs and oversized images", async (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  const authFile = path.join(fixture.root, "auth.json");
  writeJson(authFile, fakeAuth("account-1", "first@example.test"));

  const insecure = await fetchAccountAvatar(authFile, {
    fetchImpl: async () => response(JSON.stringify({ picture: "http://images.example.test/avatar" })),
  });
  assert.equal(insecure, null);

  let call = 0;
  const oversized = await fetchAccountAvatar(authFile, {
    fetchImpl: async (url) => {
      call += 1;
      if (call === 1) return response(JSON.stringify({ picture: "https://images.example.test/avatar" }));
      const image = response(new Uint8Array(0), { type: "image/jpeg", url: String(url) });
      image.headers.set("content-length", String(_test.MAX_AVATAR_BYTES + 1));
      Object.defineProperty(image, "url", { value: String(url) });
      return image;
    },
  });
  assert.equal(oversized, null);
  assert.equal(fs.existsSync(path.join(fixture.profileHome, "profiles")), false);
});

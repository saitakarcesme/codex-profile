import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const uiRoot = path.join(import.meta.dirname, "..", "ui", "src");
const tauriConfig = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "src-tauri", "tauri.conf.json"), "utf8"));

test("Tauri selector keeps the requested visual and interaction invariants", () => {
  const css = fs.readFileSync(path.join(uiRoot, "styles.css"), "utf8");
  const source = fs.readFileSync(path.join(uiRoot, "main.ts"), "utf8");
  const launcher = fs.readFileSync(path.join(uiRoot, "launcher.ts"), "utf8");
  const launcherCss = fs.readFileSync(path.join(uiRoot, "launcher.css"), "utf8");

  assert.match(css, /radial-gradient/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /justify-content:\s*center/);
  assert.match(css, /profile:hover \.avatar-wrap/);
  assert.match(css, /profile--selected \.avatar/);
  assert.match(css, /#202123|#202124/);
  assert.match(css, /data-platform="windows"[^}]*--window-radius:\s*8px/);
  assert.match(css, /data-platform="macos"[^}]*--window-radius:\s*12px/);
  assert.match(source, /document\.documentElement\.dataset\.platform\s*=\s*hostPlatform/);
  assert.doesNotMatch(css, /border:\s*1px solid rgba\(255,\s*255,\s*255,\s*0\.11\)/);
  assert.equal(tauriConfig.app.windows.find((window) => window.label === "main")?.transparent, true);
  assert.doesNotMatch(css, /#435fa2|#334f97|#252f72|#171e52/i);
  assert.doesNotMatch(css, /border[^;]*:\s*[^;]*(?:dashed|dotted)/i);
  assert.doesNotMatch(source, /email/i);
  assert.doesNotMatch(source, /brand-mark|<svg[^>]*brand/i);
  assert.match(source, /invoke<string>\("brand_icon"\)/);
  assert.match(launcher, /invoke\("open_selector"\)/);
  assert.match(launcher, /invoke<string>\("brand_icon"\)/);
  assert.match(launcherCss, /border-radius:\s*50%/);
  assert.match(source, /class="titlebar" data-tauri-drag-region/);
  assert.doesNotMatch(source, /startDragging/);
  assert.match(source, /invoke\("switch_profile"/);
  assert.match(source, /#minimize[\s\S]*invoke\("hide_selector"\)/);
  assert.match(source, /#close[\s\S]*invoke\("hide_selector"\)/);
  assert.doesNotMatch(source, /appWindow\.(?:minimize|hide)/);
});

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

let windowsUserSid;

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on Windows */ }
}

export function protectPrivateTree(dir, platform = process.platform) {
  if (platform !== "win32") return;
  if (!windowsUserSid) {
    const identity = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
    windowsUserSid = identity.stdout?.match(/S-\d(?:-\d+)+/)?.[0];
    if (identity.status !== 0 || !windowsUserSid) throw new Error("could not determine the current Windows user SID for credential ACL protection");
  }
  const result = spawnSync("icacls.exe", [
    dir,
    "/inheritance:r",
    "/grant:r",
    `*${windowsUserSid}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
  ], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`could not protect the Codex Profile credential directory: ${dir}`);
}

export function atomicWrite(file, data, mode = 0o600) {
  ensurePrivateDir(path.dirname(file));
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  const handle = fs.openSync(temp, "wx", mode);
  try {
    fs.writeFileSync(handle, data, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try { fs.chmodSync(temp, mode); } catch { /* best effort on Windows */ }
  fs.renameSync(temp, file);
}

export function atomicCopy(source, destination) {
  const data = fs.readFileSync(source, "utf8");
  JSON.parse(data);
  atomicWrite(destination, data, 0o600);
}

export function withOperationLock(paths, action) {
  ensurePrivateDir(paths.root);
  protectPrivateTree(paths.root);
  let handle;
  try {
    handle = fs.openSync(paths.lock, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      let stale = false;
      try {
        const metadata = JSON.parse(fs.readFileSync(paths.lock, "utf8"));
        const age = Date.now() - new Date(metadata.startedAt).getTime();
        let alive = true;
        try { process.kill(Number(metadata.pid), 0); }
        catch (probeError) { alive = probeError?.code === "EPERM"; }
        stale = Number.isFinite(age) && age > 120_000 && !alive;
      } catch {
        const age = Date.now() - fs.statSync(paths.lock).mtimeMs;
        stale = age > 120_000;
      }
      if (stale) {
        fs.unlinkSync(paths.lock);
        handle = fs.openSync(paths.lock, "wx", 0o600);
      } else {
        throw new Error(`another Codex Profile operation is in progress (${paths.lock})`);
      }
    }
    if (!handle) throw error;
  }
  try {
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return action();
  } finally {
    fs.closeSync(handle);
    try { fs.unlinkSync(paths.lock); } catch { /* a failed cleanup is diagnosed next run */ }
  }
}

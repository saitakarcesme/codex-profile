import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCodex } from "./codex-adapter.js";
import { readActiveAccountAndUsage } from "./app-server.js";
import { atomicCopy, atomicWrite, ensurePrivateDir } from "./fs-safe.js";
import { captureSharedState, compareSharedState } from "./shared-state.js";
import { storePaths } from "./paths.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeDesktopAudit(store, audit) {
  const serialized = JSON.stringify(audit);
  atomicWrite(store.paths.desktopAudit, `${JSON.stringify(audit, null, 2)}\n`, 0o600);
  const handle = fs.openSync(store.paths.desktopAuditHistory, "a", 0o600);
  try {
    fs.writeFileSync(handle, `${serialized}\n`, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function parseJsonOutput(result, description) {
  if (result.status !== 0) throw new Error(`${description} failed`);
  const text = result.stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function windowsCodexProcesses(env = process.env) {
  const script = "$items = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(ChatGPT|codex|codex-code-mode-host)\\.exe$' } | ForEach-Object { $window = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; path = $_.ExecutablePath; commandLine = $_.CommandLine; mainWindowHandle = if ($window) { [long]$window.MainWindowHandle } else { 0 }; mainWindowTitle = if ($window) { $window.MainWindowTitle } else { '' } } }; $items | ConvertTo-Json -Compress";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", env });
  return parseJsonOutput(result, "Codex Desktop process discovery");
}

export function classifyWindowsDesktopProcesses(processes) {
  const roots = processes.filter((item) => {
    const desktopMain = item.name?.toLowerCase() === "chatgpt.exe"
      && /[\\/]WindowsApps[\\/]OpenAI\.Codex_/i.test(item.path || "")
      && !/--type=/i.test(item.commandLine || "");
    const desktopRuntime = item.name?.toLowerCase() === "codex.exe"
      && /[\\/]AppData[\\/]Local[\\/]OpenAI[\\/]Codex[\\/]bin[\\/]/i.test(item.path || "")
      && /\bapp-server\b.*\bstdio:\/\//i.test(item.commandLine || "");
    return desktopMain || desktopRuntime;
  });
  const ids = new Set(roots.map((item) => item.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes) {
      if (!ids.has(item.pid) && ids.has(item.ppid)) {
        ids.add(item.pid);
        changed = true;
      }
    }
  }
  return {
    roots,
    desktop: processes.filter((item) => ids.has(item.pid)),
    otherCodex: processes.filter((item) => !ids.has(item.pid) && /^codex/i.test(item.name || "")),
  };
}

export function desktopProcessState(env = process.env, platform = process.platform) {
  if (platform === "win32") return classifyWindowsDesktopProcesses(windowsCodexProcesses(env));
  if (platform === "darwin") {
    const result = spawnSync("pgrep", ["-fl", "/(ChatGPT|Codex)\\.app/"], { encoding: "utf8", env });
    const desktop = result.status === 0
      ? result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => ({ pid: Number(line.trim().split(/\s+/)[0]), name: line }))
      : [];
    return { roots: desktop, desktop, otherCodex: [] };
  }
  return { roots: [], desktop: [], otherCodex: [] };
}

async function waitForWindowsDesktopExit(env, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!desktopProcessState(env, "win32").desktop.length) return true;
    await sleep(250);
  }
  return false;
}

function windowsTaskkillArguments(processIds) {
  const ids = [...new Set(processIds)]
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  return ["/F", "/T", ...ids.flatMap((pid) => ["/PID", String(pid)])];
}

function desktopReady(state, platform) {
  return platform !== "win32" || (
    state.roots.some((item) => item.name?.toLowerCase() === "chatgpt.exe" && Number(item.mainWindowHandle) > 0)
    && state.desktop.some((item) => item.name?.toLowerCase() === "codex.exe" && /\bapp-server\b/i.test(item.commandLine || ""))
  );
}

async function waitForDesktopStart(env, platform, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = desktopProcessState(env, platform);
    if (desktopReady(state, platform)) return state;
    await sleep(250);
  }
  return null;
}

function safeUsage(live, target) {
  const account = live.account?.account || null;
  if (account?.email && target.email && account.email.toLowerCase() !== target.email.toLowerCase()) {
    throw new Error(`Codex reported ${account.email}, expected ${target.email}`);
  }
  const limits = live.usage?.rateLimits || {};
  const safeWindow = (window) => window ? { usedPercent: window.usedPercent, resetsAt: window.resetsAt } : null;
  return {
    email: account?.email || target.email || null,
    accountType: account?.type || null,
    planType: account?.planType || target.planType || null,
    primary: safeWindow(limits.primary),
    secondary: safeWindow(limits.secondary),
  };
}

export async function validateStoredProfile(store, selector, readUsage = readActiveAccountAndUsage) {
  const state = store.load();
  const target = store.resolve(selector, state);
  const shared = store.inspectShared();
  const source = shared?.fingerprint === target.fingerprint ? store.sharedAuthPath() : store.authPath(target.id);
  const staging = path.join(store.paths.staging, `validate-${crypto.randomUUID()}`);
  ensurePrivateDir(staging);
  atomicWrite(path.join(staging, "config.toml"), 'cli_auth_credentials_store = "file"\n', 0o600);
  atomicCopy(source, path.join(staging, "auth.json"));
  try {
    const usage = safeUsage(await readUsage(staging, store.env), target);
    const refreshed = path.join(staging, "auth.json");
    if (fs.existsSync(refreshed)) store.replaceProfileAuth(target.id, refreshed);
    else store.updateAuthHealth(target.id, "ready");
    return { target: store.resolve(target.id), usage };
  } catch (error) {
    const authHealth = /token_revoked|invalidated oauth token|401 Unauthorized/i.test(error.message)
      ? "reauth-required"
      : "temporarily-unavailable";
    store.updateAuthHealth(target.id, authHealth);
    throw new Error(`profile "${target.label}" is not currently authenticated: ${error.message}`);
  } finally {
    if (path.dirname(staging) === store.paths.staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function windowsDesktopAppId(env = process.env) {
  const script = "Get-StartApps | Where-Object AppID -Like 'OpenAI.Codex_*!App' | Select-Object -First 1 -ExpandProperty AppID";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", env, windowsHide: true });
  const appId = result.stdout?.trim();
  if (result.status !== 0 || !appId || !/^OpenAI\.Codex_[A-Za-z0-9]+!App$/.test(appId)) {
    throw new Error("installed Codex Desktop AppID could not be resolved from Windows Start Apps");
  }
  return appId;
}

function bundledBrandAssets() {
  const png = fileURLToPath(new URL("../assets/brand/codex-profile-logo.png", import.meta.url));
  const ico = fileURLToPath(new URL("../assets/brand/codex-profile-icon.ico", import.meta.url));
  if (!fs.existsSync(png) || !fs.existsSync(ico)) throw new Error("bundled Codex Profile brand assets could not be resolved");
  return { png, ico };
}

function windowsAutomationAssembly(env = process.env) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", "[System.Management.Automation.PSObject].Assembly.Location"], { encoding: "utf8", env, windowsHide: true });
  const automation = result.stdout?.trim();
  if (result.status !== 0 || !automation || !fs.existsSync(automation)) {
    throw new Error("the Windows PowerShell automation assembly required for the GUI host was not found");
  }
  return automation;
}

export function ensureWindowsMenuHost(env = process.env) {
  if (process.platform !== "win32") throw new Error("the Codex Profile GUI host is currently implemented for Windows");
  const root = storePaths(env).root;
  ensurePrivateDir(root);
  const source = fileURLToPath(new URL("../legacy/windows/CodexProfileHost.cs", import.meta.url));
  const brand = bundledBrandAssets();
  const digest = crypto.createHash("sha256")
    .update(fs.readFileSync(source))
    .update(fs.readFileSync(brand.png))
    .update(fs.readFileSync(brand.ico))
    .digest("hex")
    .slice(0, 12);
  const output = path.join(root, `CodexProfileHost-${digest}.exe`);
  if (fs.existsSync(output)) return { host: output, icon: brand.ico, brand: brand.png, automation: windowsAutomationAssembly(env) };

  const windows = env.WINDIR || env.SystemRoot || "C:\\Windows";
  const compiler = path.join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  if (!fs.existsSync(compiler)) throw new Error("the Windows C# compiler required for the GUI host was not found");
  const automationAssembly = windowsAutomationAssembly(env);
  const temporary = path.join(root, `.CodexProfileHost-${digest}-${process.pid}.exe`);
  const compiled = spawnSync(compiler, [
    "/nologo", "/target:winexe", "/platform:anycpu", "/optimize+",
    `/out:${temporary}`, `/win32icon:${brand.ico}`, source,
  ], { encoding: "utf8", env, windowsHide: true });
  if (compiled.status !== 0 || !fs.existsSync(temporary)) {
    try { fs.unlinkSync(temporary); } catch { /* compilation produced no artifact */ }
    throw new Error(`failed to build the Codex Profile GUI host${compiled.stderr?.trim() ? `: ${compiled.stderr.trim()}` : ""}`);
  }
  fs.renameSync(temporary, output);
  return { host: output, icon: brand.ico, brand: brand.png, automation: automationAssembly };
}

function windowsMenuHostArguments({ script, cliPath, cwd, automation, brand, startHidden = false }) {
  const values = ["--script", script, "--node", process.execPath, "--cli", path.resolve(cliPath), "--cwd", path.resolve(cwd), "--automation", automation, "--brand", brand];
  if (startHidden) values.push("--start-hidden");
  return values.map((value) => `"${String(value).replaceAll('"', '\\"')}"`).join(" ");
}

function startWindowsDesktopPackage(appId, env) {
  const child = spawn("explorer.exe", [`shell:AppsFolder\\${appId}`], { env, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function focusWindowsDesktop(state, env) {
  const main = state.roots.find((item) => item.name?.toLowerCase() === "chatgpt.exe" && Number(item.mainWindowHandle) > 0);
  if (!main) return false;
  const script = `$shell = New-Object -ComObject WScript.Shell; [bool]$shell.AppActivate(${Number(main.pid)})`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", env, windowsHide: true });
  return result.status === 0 && /true/i.test(result.stdout || "");
}

export async function closeDesktop(env = process.env, platform = process.platform) {
  const before = desktopProcessState(env, platform);
  if (!before.desktop.length) return { wasRunning: false, forced: false, closed: 0 };
  if (before.otherCodex.length) {
    const details = before.otherCodex.map((item) => `${item.name} (${item.pid})`).join(", ");
    throw new Error(`another Codex CLI process is running outside Desktop: ${details}`);
  }

  if (platform === "win32") {
    const rootIds = before.roots.map((item) => Number(item.pid)).filter(Number.isInteger);
    const closeScript = rootIds
      .map((pid) => `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($process) { [void]$process.CloseMainWindow() }`)
      .join("; ");
    if (closeScript) spawnSync("powershell.exe", ["-NoProfile", "-Command", closeScript], { stdio: "ignore", env, windowsHide: true });
    // Codex Desktop currently ignores CloseMainWindow on Windows. Keep a short
    // grace period for auth/database flushes, then terminate the isolated Desktop
    // tree in one command instead of paying the former 10s + 4s fixed waits.
    if (await waitForWindowsDesktopExit(env, 1_500)) {
      return { wasRunning: true, forced: false, closed: before.desktop.length };
    }
    const remainingIds = desktopProcessState(env, "win32").desktop
      .map((item) => Number(item.pid))
      .filter((pid) => Number.isInteger(pid));
    if (remainingIds.length) {
      spawnSync("taskkill.exe", windowsTaskkillArguments(remainingIds), { stdio: "ignore", env, windowsHide: true });
    }
    if (!(await waitForWindowsDesktopExit(env, 3_000))) {
      throw new Error("Codex Desktop did not exit; profile was not switched");
    }
    return { wasRunning: true, forced: true, closed: before.desktop.length };
  }

  if (platform === "darwin") {
    spawnSync("osascript", ["-e", 'tell application "ChatGPT" to quit'], { stdio: "ignore", env });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (!desktopProcessState(env, platform).desktop.length) return { wasRunning: true, forced: false, closed: before.desktop.length };
      await sleep(250);
    }
    throw new Error("Codex Desktop did not exit; profile was not switched");
  }

  throw new Error(`one-action Desktop switching is not implemented on ${platform}`);
}

export function resolveDesktopWorkspace(codexHome, requested, cwd = process.cwd()) {
  if (requested) return path.resolve(requested);
  const globalState = path.join(codexHome, ".codex-global-state.json");
  try {
    const state = JSON.parse(fs.readFileSync(globalState, "utf8"));
    const selectedId = state["selected-project"]?.projectId;
    const projects = state["local-projects"] && typeof state["local-projects"] === "object"
      ? Object.values(state["local-projects"])
      : [];
    const current = path.resolve(cwd);
    const containing = projects
      .flatMap((project) => Array.isArray(project?.rootPaths) ? project.rootPaths : [])
      .filter((root) => typeof root === "string" && fs.existsSync(root))
      .map((root) => path.resolve(root))
      .filter((root) => current === root || current.startsWith(`${root}${path.sep}`))
      .sort((a, b) => b.length - a.length)[0];
    if (containing) return containing;
    const selected = projects.find((project) => project?.id === selectedId);
    const selectedRoot = selected?.rootPaths?.find((root) => typeof root === "string" && fs.existsSync(root));
    if (selectedRoot) return path.resolve(selectedRoot);
    const activeRoot = state["active-workspace-roots"]?.find((root) => typeof root === "string" && fs.existsSync(root));
    if (activeRoot) return path.resolve(activeRoot);
  } catch { /* fall through to current directory */ }
  return path.resolve(cwd);
}

export async function launchDesktop(workspace, codexHome, env = process.env, platform = process.platform, operations = {}) {
  let lastError = null;
  if (platform === "win32") {
    const resolveAppId = operations.resolveAppId || windowsDesktopAppId;
    const startPackage = operations.startPackage || startWindowsDesktopPackage;
    const waitForStart = operations.waitForStart || waitForDesktopStart;
    const focus = operations.focus || focusWindowsDesktop;
    const appId = resolveAppId(env);
    let attempt = 0;
    while (true) {
      attempt += 1;
      startPackage(appId, env);
      const started = await waitForStart(env, platform, 30_000);
      if (started) {
        const focused = focus(started, env);
        try { fs.unlinkSync(path.join(storePaths(env).root, "relaunch-pending.json")); } catch { /* absent or already cleared */ }
        return {
          workspace,
          attempt,
          processCount: started.desktop.length,
          mechanism: "windows-app-id",
          appId,
          visibleWindow: true,
          focused,
          workspaceNavigation: "preserved-desktop-state",
        };
      }
      lastError = `Windows accepted the packaged-app launch for ${appId}, but no Codex Desktop process appeared`;
      if (attempt >= 3) {
        // Keep the independent watchdog alive until Codex is verifiably ready. A bounded
        // command can strand the user with Desktop closed after transient Windows activation failures.
        atomicWrite(path.join(storePaths(env).root, "relaunch-pending.json"), `${JSON.stringify({
          version: 1,
          workspace,
          appId,
          attempt,
          lastError,
          updatedAt: new Date().toISOString(),
        }, null, 2)}\n`, 0o600);
      }
      await sleep(Math.min(10_000, 2_000 + attempt * 1_000));
    }
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await sleep(attempt === 1 ? 2_000 : 3_000);
    const code = await runCodex(["app", workspace], codexHome, env);
    if (code !== 0) lastError = `official Codex Desktop launcher exited with code ${code}`;
    else {
      const started = await waitForDesktopStart(env, platform, 12_000);
      if (started) return { workspace, attempt, processCount: started.desktop.length };
      lastError = "Codex Desktop launcher returned successfully but no Desktop process appeared";
    }
  }
  throw new Error(`${lastError}; tried the official launcher 3 times`);
}

export async function switchDesktopProfile({
  store,
  selector,
  requestedWorkspace = null,
  close = closeDesktop,
  launch = launchDesktop,
  readUsage = readActiveAccountAndUsage,
  capture = captureSharedState,
  validate = validateStoredProfile,
  repairLogin = null,
}) {
  const workspace = resolveDesktopWorkspace(store.codexHome, requestedWorkspace);
  const stateBefore = store.load();
  const requestedTarget = store.resolve(selector, stateBefore);
  const driftBefore = store.activeDrift(stateBefore);
  const registeredOutgoing = stateBefore.profiles.find((profile) => profile.id === stateBefore.activeProfileId) || null;
  const outgoing = driftBefore.shared
    ? stateBefore.profiles.find((profile) => profile.fingerprint === driftBefore.shared.fingerprint) || registeredOutgoing
    : registeredOutgoing;
  const manualDriftDetected = Boolean(outgoing && registeredOutgoing && outgoing.id !== registeredOutgoing.id);
  let preflight;
  try {
    preflight = await validate(store, requestedTarget.id, readUsage);
  } catch (firstError) {
    let error = firstError;
    if (repairLogin) {
      try {
        await repairLogin(store, requestedTarget.id);
        preflight = await validate(store, requestedTarget.id, readUsage);
      } catch (repairError) {
        error = new Error(`${firstError.message}; automatic sign-in repair failed: ${repairError.message}`);
      }
    }
    if (!preflight) {
      const audit = {
        version: 1,
        switchedAt: new Date().toISOString(),
        workspace,
        from: outgoing ? { label: outgoing.label, email: outgoing.email } : null,
        to: { label: requestedTarget.label, email: requestedTarget.email },
        manualDriftDetected,
        outcome: "preflight-failed",
        error: error.message,
        desktop: { untouched: true },
        identity: null,
        sharedState: null,
        relaunch: { notRequired: true },
      };
      writeDesktopAudit(store, audit);
      throw error;
    }
  }
  const before = capture(store.codexHome, workspace);
  let closed;
  try {
    closed = await close(store.env);
  } catch (closeError) {
    const audit = {
      version: 1,
      switchedAt: new Date().toISOString(),
      workspace,
      from: outgoing ? { label: outgoing.label, email: outgoing.email } : null,
      to: { label: requestedTarget.label, email: requestedTarget.email },
      manualDriftDetected,
      outcome: "close-failed",
      error: closeError.message,
      rollback: null,
      desktop: { closeFailed: true },
      identity: null,
      sharedState: null,
      relaunch: null,
    };
    try {
      const recovered = await launch(workspace, store.codexHome, store.env);
      audit.relaunch = { ok: true, recovery: true, ...(recovered || {}) };
    } catch (relaunchError) {
      audit.relaunch = { ok: false, recovery: true, error: relaunchError.message };
      audit.sharedState = compareSharedState(before, capture(store.codexHome, workspace));
      writeDesktopAudit(store, audit);
      throw new Error(`Codex Desktop close failed and recovery launch also failed: ${closeError.message}; ${relaunchError.message}`);
    }
    audit.sharedState = compareSharedState(before, capture(store.codexHome, workspace));
    writeDesktopAudit(store, audit);
    throw new Error(`Codex Desktop close failed; the existing account was kept and Desktop was restored: ${closeError.message}`);
  }
  let switched = null;
  let usage = preflight.usage;
  let operationError = null;
  let rollback = null;
  try {
    switched = store.activate(requestedTarget.id);
    const installed = store.inspectShared();
    if (!installed || installed.fingerprint !== switched.target.fingerprint) {
      throw new Error("activated Codex credentials do not match the selected profile");
    }
  } catch (error) {
    operationError = error;
    if (outgoing) {
      try {
        rollback = store.activate(outgoing.id);
      } catch (rollbackError) {
        operationError = new Error(`${error.message}; rollback also failed: ${rollbackError.message}`);
      }
    }
  }
  const audit = {
    version: 1,
    switchedAt: new Date().toISOString(),
    workspace,
    from: outgoing ? { label: outgoing.label, email: outgoing.email } : null,
    to: { label: requestedTarget.label, email: requestedTarget.email },
    manualDriftDetected,
    outcome: operationError ? "rolled-back" : "switched",
    error: operationError?.message || null,
    rollback: rollback ? { label: rollback.target.label, email: rollback.target.email } : null,
    desktop: closed,
    identity: operationError ? null : usage,
    sharedState: null,
    relaunch: null,
  };
  let relaunched;
  try {
    relaunched = await launch(workspace, store.codexHome, store.env);
    audit.relaunch = { ok: true, ...(relaunched || {}) };
  } catch (error) {
    audit.relaunch = { ok: false, error: error.message };
    audit.sharedState = compareSharedState(before, capture(store.codexHome, workspace));
    writeDesktopAudit(store, audit);
    throw error;
  }
  const integrity = compareSharedState(before, capture(store.codexHome, workspace));
  audit.sharedState = integrity;
  writeDesktopAudit(store, audit);
  if (operationError) {
    throw new Error(`profile switch failed, but Codex Desktop was relaunched${rollback ? ` as "${rollback.target.label}"` : ""}: ${operationError.message}`);
  }
  return { workspace, closed, switched, usage, usageError: null, integrity, audit, relaunched };
}

export function launchWindowsMenu({ env = process.env, cliPath = process.argv[1], cwd = process.cwd(), startHidden = false } = {}) {
  if (process.platform !== "win32") throw new Error("the compact companion launcher is currently implemented for Windows");
  ensurePrivateDir(storePaths(env).root);
  const script = fileURLToPath(new URL("../legacy/windows/CodexProfileLauncher.ps1", import.meta.url));
  const gui = ensureWindowsMenuHost(env);
  const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const hostArguments = windowsMenuHostArguments({ script, cliPath, cwd, automation: gui.automation, brand: gui.brand, startHidden });
  const link = path.join(storePaths(env).root, "Codex Profile Menu.lnk");
  const createCommand = [
    "$shell = New-Object -ComObject WScript.Shell",
    `$shortcut = $shell.CreateShortcut(${literal(link)})`,
    `$shortcut.TargetPath = ${literal(gui.host)}`,
    `$shortcut.Arguments = ${literal(hostArguments)}`,
    `$shortcut.WorkingDirectory = ${literal(path.resolve(cwd))}`,
    `$shortcut.IconLocation = ${literal(`${gui.icon},0`)}`,
    "$shortcut.Description = 'Open the Codex Profile selector'",
    "$shortcut.Save()",
  ].join("; ");
  const created = spawnSync("powershell.exe", ["-NoProfile", "-Command", createCommand], { encoding: "utf8", env, windowsHide: true });
  if (created.status !== 0) throw new Error(`failed to prepare the independent companion launcher${created.stderr.trim() ? `: ${created.stderr.trim()}` : ""}`);
  // Explorer owns the shortcut launch, so the companion is outside both the
  // calling CLI's job object and Codex Desktop's process tree.
  const child = spawn("explorer.exe", [link], { env, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return { processId: child.pid, completion: Promise.resolve(0), link };
}

export function resolveDesktopShellBinary(env = process.env, platform = process.platform) {
  const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const configured = env.CODEX_PROFILE_UI_BIN ? path.resolve(env.CODEX_PROFILE_UI_BIN) : null;
  const candidates = platform === "win32"
    ? [
        configured,
        path.join(repositoryRoot, "src-tauri", "target", "release", "codex-profile-ui.exe"),
        path.join(repositoryRoot, "src-tauri", "target", "debug", "codex-profile-ui.exe"),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Codex Profile", "codex-profile-ui.exe"),
        env.ProgramFiles && path.join(env.ProgramFiles, "Codex Profile", "codex-profile-ui.exe"),
      ]
    : platform === "darwin"
      ? [
          configured,
          path.join(repositoryRoot, "src-tauri", "target", "release", "bundle", "macos", "Codex Profile.app", "Contents", "MacOS", "codex-profile-ui"),
          "/Applications/Codex Profile.app/Contents/MacOS/codex-profile-ui",
          env.HOME && path.join(env.HOME, "Applications", "Codex Profile.app", "Contents", "MacOS", "codex-profile-ui"),
        ]
      : [configured];
  return candidates.filter(Boolean).find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

export function launchDesktopMenu({ env = process.env, cliPath = process.argv[1], cwd = process.cwd(), startHidden = false, platform = process.platform } = {}) {
  const shell = resolveDesktopShellBinary(env, platform);
  if (!shell) {
    if (platform === "win32") return launchWindowsMenu({ env, cliPath, cwd, startHidden });
    throw new Error("Codex Profile Desktop UI is not installed; build or install the Tauri application first");
  }
  const child = spawn(shell, startHidden ? ["--hidden"] : [], {
    cwd: path.dirname(shell),
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return { processId: child.pid, completion: Promise.resolve(0), executable: shell };
}

function shortcutSafeName(label) {
  const clean = String(label).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return clean || "Profile";
}

export function installWindowsShortcuts(profiles, { env = process.env, cliPath = process.argv[1], cwd = process.cwd(), desktopPath = null, startupPath = null } = {}) {
  if (process.platform !== "win32") throw new Error("profile shortcuts are currently implemented for Windows");
  const payload = Buffer.from(JSON.stringify(profiles.map((profile) => ({ id: profile.id, label: profile.label })))).toString("base64");
  const encodedUtf8 = (value) => Buffer.from(String(value), "utf8").toString("base64");
  const shell = resolveDesktopShellBinary(env, "win32");
  const launcherScript = fileURLToPath(new URL("../legacy/windows/CodexProfileLauncher.ps1", import.meta.url));
  const legacy = shell ? null : ensureWindowsMenuHost(env);
  const hostPath = shell || legacy.host;
  const hostIcon = shell ? `${shell},0` : `${legacy.icon},0`;
  const menuArguments = shell ? "" : windowsMenuHostArguments({ script: launcherScript, cliPath, cwd, automation: legacy.automation, brand: legacy.brand, startHidden: false });
  const startupArguments = shell ? "--hidden" : windowsMenuHostArguments({ script: launcherScript, cliPath, cwd, automation: legacy.automation, brand: legacy.brand, startHidden: true });
  const script = [
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    `$NodePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUtf8(process.execPath)}'))`,
    `$CliPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUtf8(path.resolve(cliPath))}'))`,
    `$WorkingDirectory = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUtf8(path.resolve(cwd))}'))`,
    `$DesktopPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUtf8(desktopPath ? path.resolve(desktopPath) : "")}'))`,
    `$StartupPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUtf8(startupPath ? path.resolve(startupPath) : "")}'))`,
    `$HostPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUtf8(hostPath)}'))`,
    `$HostIcon = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUtf8(hostIcon)}'))`,
    `$MenuArguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUtf8(menuArguments)}'))`,
    `$StartupArguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUtf8(startupArguments)}'))`,
    `$Payload = '${payload}'`,
    "$profiles = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json",
    "$desktop = if ($DesktopPath) { $DesktopPath } else { [Environment]::GetFolderPath('Desktop') }",
    "$startup = if ($StartupPath) { $StartupPath } else { [Environment]::GetFolderPath('Startup') }",
    "$shell = New-Object -ComObject WScript.Shell",
    "$created = @()",
    "foreach ($profile in $profiles) {",
    "$name = ($profile.label -replace '[<>:\"/\\\\|?*]', '_').Trim()",
    "$command = \"& '$($NodePath.Replace(\"'\",\"''\"))' '$($CliPath.Replace(\"'\",\"''\"))' desktop use '$($profile.id)'\"",
    "$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))",
    "$shortcutPath = Join-Path $desktop \"Codex $name.lnk\"",
    "$shortcut = $shell.CreateShortcut($shortcutPath)",
    "$shortcut.TargetPath = (Get-Command powershell.exe).Source",
    "$shortcut.Arguments = \"-NoProfile -WindowStyle Hidden -EncodedCommand $encoded\"",
    "$shortcut.WorkingDirectory = $WorkingDirectory",
    "$shortcut.Description = \"Switch to Codex profile $name and relaunch Codex Desktop\"",
    "$shortcut.Save()",
    "$created += $shortcutPath",
    "}",
    "$menuPath = Join-Path $desktop 'Codex Profile Menu.lnk'",
    "$menuShortcut = $shell.CreateShortcut($menuPath)",
    "$menuShortcut.TargetPath = $HostPath",
    "$menuShortcut.Arguments = $MenuArguments",
    "$menuShortcut.WorkingDirectory = $WorkingDirectory",
    "$menuShortcut.IconLocation = $HostIcon",
    "$menuShortcut.Description = 'Open the Codex Profile notification-area menu'",
    "$menuShortcut.Save()",
    "$created += $menuPath",
    "$startupMenuPath = Join-Path $startup 'Codex Profile Menu.lnk'",
    "$startupShortcut = $shell.CreateShortcut($startupMenuPath)",
    "$startupShortcut.TargetPath = $HostPath",
    "$startupShortcut.Arguments = $StartupArguments",
    "$startupShortcut.WorkingDirectory = $WorkingDirectory",
    "$startupShortcut.IconLocation = $HostIcon",
    "$startupShortcut.Description = 'Keep the Codex Profile notification-area menu available after sign-in'",
    "$startupShortcut.Save()",
    "$created += $startupMenuPath",
    "$created | ConvertTo-Json -Compress",
  ].join("; ");
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", encodedCommand], { encoding: "utf8", env });
  if (result.status !== 0) throw new Error(`failed to create Windows profile shortcuts${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
  const output = result.stdout.trim();
  const created = output ? JSON.parse(output) : [];
  return Array.isArray(created) ? created : [created];
}

export const _test = { desktopReady, shortcutSafeName, windowsTaskkillArguments };

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ProfileStore } from "../src/store.js";
import { parseDesktopUseArguments } from "../src/cli.js";
import {
  _test,
  classifyWindowsDesktopProcesses,
  ensureWindowsMenuHost,
  installWindowsShortcuts,
  resolveDesktopShellBinary,
  launchDesktop,
  resolveDesktopWorkspace,
  switchDesktopProfile,
  windowsDesktopAppId,
} from "../src/desktop.js";
import { fakeAuth, tempEnvironment, writeJson } from "./helpers.js";

test("Windows process classification isolates the Desktop tree from a login process", () => {
  const processes = [
    { pid: 10, ppid: 1, name: "ChatGPT.exe", path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\ChatGPT.exe", commandLine: "ChatGPT.exe" },
    { pid: 11, ppid: 10, name: "ChatGPT.exe", path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\ChatGPT.exe", commandLine: "ChatGPT.exe --type=renderer" },
    { pid: 12, ppid: 10, name: "codex.exe", path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\resources\\codex.exe", commandLine: "codex.exe app-server" },
    { pid: 20, ppid: 2, name: "codex.exe", path: "C:\\npm\\codex.exe", commandLine: "codex.exe login" },
  ];
  const result = classifyWindowsDesktopProcesses(processes);
  assert.deepEqual(result.desktop.map((item) => item.pid).sort(), [10, 11, 12]);
  assert.deepEqual(result.otherCodex.map((item) => item.pid), [20]);
});

test("Windows Desktop readiness requires a visible main window and app server", () => {
  const hidden = {
    roots: [{ name: "ChatGPT.exe", mainWindowHandle: 0 }],
    desktop: [{ name: "ChatGPT.exe", mainWindowHandle: 0 }, { name: "codex.exe", commandLine: "codex.exe app-server" }],
  };
  assert.equal(_test.desktopReady(hidden, "win32"), false);
  hidden.roots[0].mainWindowHandle = 123;
  assert.equal(_test.desktopReady(hidden, "win32"), true);
});

test("Windows forced close terminates the complete Desktop tree in one command", () => {
  assert.deepEqual(_test.windowsTaskkillArguments([12, 10, 12, 0, -1]), [
    "/F", "/T", "/PID", "12", "/PID", "10",
  ]);
});

test("Windows launch uses the installed AppID without invoking the download launcher", async (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  const events = [];
  const state = {
    roots: [{ pid: 10, name: "ChatGPT.exe", mainWindowHandle: 123 }],
    desktop: [{ pid: 10, name: "ChatGPT.exe", mainWindowHandle: 123 }, { pid: 11, name: "codex.exe", commandLine: "codex.exe app-server" }],
  };
  const result = await launchDesktop(fixture.root, fixture.codexHome, fixture.env, "win32", {
    resolveAppId: () => "OpenAI.Codex_test!App",
    startPackage: (appId) => events.push(`start:${appId}`),
    waitForStart: async () => state,
    focus: () => { events.push("focus"); return true; },
  });
  assert.deepEqual(events, ["start:OpenAI.Codex_test!App", "focus"]);
  assert.equal(result.visibleWindow, true);
  assert.equal(result.workspaceNavigation, "preserved-desktop-state");
});

test("installed Windows Desktop AppID resolves to the stable package family", { skip: process.platform !== "win32" }, () => {
  assert.match(windowsDesktopAppId(), /^OpenAI\.Codex_[A-Za-z0-9]+!App$/);
});

test("workspace resolution prefers the project containing the command cwd", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  const project = path.join(fixture.root, "project");
  const selected = path.join(fixture.root, "selected");
  fs.mkdirSync(path.join(project, "nested"), { recursive: true });
  fs.mkdirSync(selected, { recursive: true });
  writeJson(path.join(fixture.codexHome, ".codex-global-state.json"), {
    "selected-project": { type: "local", projectId: "selected" },
    "local-projects": {
      project: { id: "project", rootPaths: [project] },
      selected: { id: "selected", rootPaths: [selected] },
    },
  });
  assert.equal(resolveDesktopWorkspace(fixture.codexHome, null, path.join(project, "nested")), project);
});

test("desktop switch closes, activates, then launches in that order", async (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  writeJson(path.join(fixture.codexHome, "auth.json"), fakeAuth("account-1", "first@example.test"));
  const store = new ProfileStore(fixture.env);
  store.initialize("First");
  const secondAuth = path.join(fixture.root, "second.json");
  writeJson(secondAuth, fakeAuth("account-2", "second@example.test"));
  store.addFromAuth(secondAuth, "Second");
  const events = [];
  let usageReads = 0;
  const result = await switchDesktopProfile({
    store,
    selector: "Second",
    requestedWorkspace: fixture.root,
    close: async () => { events.push("close"); return { wasRunning: true, forced: false, closed: 1 }; },
    launch: async (workspace) => { events.push(`launch:${store.inspectShared().email}:${workspace}`); },
    readUsage: async () => {
      usageReads += 1;
      return {
        account: { account: { email: "second@example.test", type: "chatgpt", planType: "pro" } },
        usage: { rateLimits: { primary: { usedPercent: 20, resetsAt: 1 } } },
      };
    },
  });
  assert.deepEqual(events, ["close", `launch:second@example.test:${fixture.root}`]);
  assert.equal(result.switched.target.label, "Second");
  assert.equal(result.usage.email, "second@example.test");
  assert.equal(usageReads, 1);
  assert.equal(result.integrity.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(store.paths.desktopAudit, "utf8")).sharedState.ok, true);
  const history = fs.readFileSync(store.paths.desktopAuditHistory, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(history.at(-1).to.label, "Second");
  assert.equal(JSON.stringify(history).includes("refresh-account"), false);
});

test("shortcut names cannot escape the Desktop directory", () => {
  assert.equal(_test.shortcutSafeName('Work:/\\*?"<>|'), "Work_________");
});

test("Desktop shell resolver honors an explicit cross-platform binary", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  const shell = path.join(fixture.root, process.platform === "win32" ? "profile.exe" : "profile");
  fs.writeFileSync(shell, "shell");
  assert.equal(resolveDesktopShellBinary({ ...fixture.env, CODEX_PROFILE_UI_BIN: shell }, process.platform), shell);
});

test("Windows shortcut creation produces an encoded one-click launcher", { skip: process.platform !== "win32" }, (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  const desktop = path.join(fixture.root, "Desktop");
  const startup = path.join(fixture.root, "Startup");
  fs.mkdirSync(desktop);
  fs.mkdirSync(startup);
  const created = installWindowsShortcuts(
    [{ id: "00000000-0000-4000-8000-000000000001", label: "Personal" }],
    { cliPath: path.join(fixture.root, "codex-profile.js"), cwd: fixture.root, desktopPath: desktop, startupPath: startup },
  );
  assert.deepEqual(created, [
    path.join(desktop, "Codex Personal.lnk"),
    path.join(desktop, "Codex Profile Menu.lnk"),
    path.join(startup, "Codex Profile Menu.lnk"),
  ]);
  assert.equal(created.every((file) => fs.statSync(file).isFile()), true);
  const gui = ensureWindowsMenuHost(fixture.env);
  assert.equal(fs.statSync(gui.host).isFile(), true);
  assert.equal(fs.readFileSync(gui.host, { encoding: null, flag: "r" }).subarray(0, 2).toString("ascii"), "MZ");
});

test("desktop audit identifies a known manual-login drift as the real outgoing account", async (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  writeJson(path.join(fixture.codexHome, "auth.json"), fakeAuth("account-1", "first@example.test"));
  const store = new ProfileStore(fixture.env);
  store.initialize("First");
  const secondAuth = path.join(fixture.root, "second.json");
  writeJson(secondAuth, fakeAuth("account-2", "second@example.test"));
  store.addFromAuth(secondAuth, "Second");
  fs.copyFileSync(secondAuth, store.sharedAuthPath());
  const result = await switchDesktopProfile({
    store,
    selector: "First",
    requestedWorkspace: fixture.root,
    close: async () => ({ wasRunning: true, forced: false, closed: 1 }),
    launch: async () => ({ attempt: 1, processCount: 1 }),
    readUsage: async () => ({
      account: { account: { email: "first@example.test", type: "chatgpt", planType: "plus" } },
      usage: { rateLimits: {} },
    }),
  });
  assert.equal(result.audit.manualDriftDetected, true);
  assert.equal(result.audit.from.label, "Second");
  assert.equal(result.audit.to.label, "First");
  assert.equal(store.activeDrift().status, "ok");
});

test("failed target preflight leaves Desktop and active profile untouched", async (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  writeJson(path.join(fixture.codexHome, "auth.json"), fakeAuth("account-1", "first@example.test"));
  const store = new ProfileStore(fixture.env);
  store.initialize("First");
  const secondAuth = path.join(fixture.root, "second.json");
  writeJson(secondAuth, fakeAuth("account-2", "second@example.test"));
  store.addFromAuth(secondAuth, "Second");
  let closeCalled = false;
  let launchCalled = false;
  await assert.rejects(switchDesktopProfile({
    store,
    selector: "Second",
    requestedWorkspace: fixture.root,
    validate: async () => { throw new Error("token revoked"); },
    close: async () => { closeCalled = true; },
    launch: async () => { launchCalled = true; },
  }), /token revoked/);
  assert.equal(closeCalled, false);
  assert.equal(launchCalled, false);
  assert.equal(store.activeDrift().active.label, "First");
  assert.equal(JSON.parse(fs.readFileSync(store.paths.desktopAudit, "utf8")).outcome, "preflight-failed");
});

test("desktop use keeps browser repair opt-in", () => {
  assert.deepEqual(parseDesktopUseArguments(["Secondary"]), {
    workspace: null,
    repairLoginRequested: false,
    selector: "Secondary",
  });
  assert.deepEqual(parseDesktopUseArguments(["Secondary", "--repair-login"]), {
    workspace: null,
    repairLoginRequested: true,
    selector: "Secondary",
  });
});

test("Windows companion is compact, draggable, scalable, and keeps repair explicit", () => {
  const launcher = fs.readFileSync(path.join(import.meta.dirname, "..", "legacy", "windows", "CodexProfileLauncher.ps1"), "utf8");
  const host = fs.readFileSync(path.join(import.meta.dirname, "..", "legacy", "windows", "CodexProfileHost.cs"), "utf8");
  assert.match(launcher, /AllowsTransparency="False"/);
  assert.match(launcher, /TextOptions\.TextRenderingMode="ClearType"/);
  assert.match(launcher, /Width="690" Height="350"/);
  assert.match(launcher, /if \(-not \$StartHidden\) \{ \$mainWindow\.Show\(\) \}/);
  assert.match(launcher, /chatgpt-tray-light\.ico/);
  assert.match(launcher, /CodexAppIcon = Get-CodexResource "chatgpt-tray-dark\.ico"/);
  assert.match(launcher, /HorizontalScrollBarVisibility="Hidden"/);
  assert.match(launcher, /Add_PreviewMouseLeftButtonDown/);
  assert.match(launcher, /Add_PreviewMouseWheel/);
  assert.match(launcher, /\$dockWindow\.Width - 42/);
  assert.doesNotMatch(launcher, /\$card\.Background = New-SolidBrush "#292A2D"/);
  assert.match(launcher, /if \(\$needsRepair\) \{ \$arguments \+= "--repair-login" \}/);
  assert.match(launcher, /Add Account is already waiting/);
  assert.match(host, /OpenAI\.CodexProfile/);
  assert.match(host, /SetCurrentProcessExplicitAppUserModelID/);
});

test("a Desktop close failure restores the existing account and workspace", async (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  writeJson(path.join(fixture.codexHome, "auth.json"), fakeAuth("account-1", "first@example.test"));
  const store = new ProfileStore(fixture.env);
  store.initialize("First");
  const secondAuth = path.join(fixture.root, "second.json");
  writeJson(secondAuth, fakeAuth("account-2", "second@example.test"));
  const second = store.addFromAuth(secondAuth, "Second");
  const calls = [];
  const beforeFingerprint = store.activeDrift().shared.fingerprint;

  await assert.rejects(
    switchDesktopProfile({
      store,
      selector: second.id,
      requestedWorkspace: fixture.root,
      validate: async () => ({ target: second, usage: { email: second.email } }),
      close: async () => {
        calls.push("close");
        throw new Error("partial shutdown");
      },
      launch: async (workspace) => {
        calls.push(`launch:${workspace}`);
        return { workspace, attempt: 1 };
      },
    }),
    /existing account was kept and Desktop was restored/,
  );

  assert.deepEqual(calls, ["close", `launch:${fixture.root}`]);
  assert.equal(store.activeDrift().shared.fingerprint, beforeFingerprint);
  const audit = JSON.parse(fs.readFileSync(store.paths.desktopAudit, "utf8"));
  assert.equal(audit.outcome, "close-failed");
  assert.equal(audit.relaunch.ok, true);
  assert.equal(audit.relaunch.recovery, true);
});

test("post-close failure rolls back and relaunches the previous account", async (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  writeJson(path.join(fixture.codexHome, "auth.json"), fakeAuth("account-1", "first@example.test"));
  const store = new ProfileStore(fixture.env);
  store.initialize("First");
  const secondAuth = path.join(fixture.root, "second.json");
  writeJson(secondAuth, fakeAuth("account-2", "second@example.test"));
  const second = store.addFromAuth(secondAuth, "Second");
  let launchedAs = null;
  await assert.rejects(switchDesktopProfile({
    store,
    selector: second.id,
    requestedWorkspace: fixture.root,
    validate: async () => ({ target: second, usage: { email: second.email } }),
    close: async () => {
      writeJson(store.authPath(second.id), fakeAuth("wrong-account", "wrong@example.test"));
      return { wasRunning: true, forced: false, closed: 1 };
    },
    launch: async () => { launchedAs = store.inspectShared().email; return { attempt: 1, processCount: 1 }; },
  }), /relaunched as "First"/);
  assert.equal(launchedAs, "first@example.test");
  assert.equal(store.activeDrift().status, "ok");
  const audit = JSON.parse(fs.readFileSync(store.paths.desktopAudit, "utf8"));
  assert.equal(audit.outcome, "rolled-back");
  assert.equal(audit.relaunch.ok, true);
});

test("explicit login repair runs before Desktop is closed", async (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  writeJson(path.join(fixture.codexHome, "auth.json"), fakeAuth("account-1", "first@example.test"));
  const store = new ProfileStore(fixture.env);
  store.initialize("First");
  const secondAuth = path.join(fixture.root, "second.json");
  writeJson(secondAuth, fakeAuth("account-2", "second@example.test"));
  const second = store.addFromAuth(secondAuth, "Second");
  const events = [];
  let validationAttempt = 0;
  await switchDesktopProfile({
    store,
    selector: second.id,
    requestedWorkspace: fixture.root,
    validate: async () => {
      validationAttempt += 1;
      events.push(`validate-${validationAttempt}`);
      if (validationAttempt === 1) throw new Error("revoked");
      return { target: second, usage: { email: second.email } };
    },
    repairLogin: async () => { events.push("repair"); },
    close: async () => { events.push("close"); return { wasRunning: true, forced: false, closed: 1 }; },
    readUsage: async () => ({ account: { account: { email: second.email } }, usage: { rateLimits: {} } }),
    launch: async () => { events.push("launch"); return { attempt: 1, processCount: 1 }; },
  });
  assert.deepEqual(events, ["validate-1", "repair", "validate-2", "close", "launch"]);
});

# Architecture and storage map

This map was verified on 2026-08-13 against:

- Codex Desktop for Windows `26.803.10989.0`;
- the Desktop-bundled `codex-cli 0.147.0-alpha.6.6` and matching open-source tag `rust-v0.147.0-alpha.6.6`;
- installed npm `@openai/codex 0.144.6` and matching open-source tag `rust-v0.144.6`;
- the current official Codex manual fetched on the same date.

## Storage ownership

| State | Observed location or authority | Owner in Codex Profile | Treatment |
| --- | --- | --- | --- |
| ChatGPT/API auth | `$CODEX_HOME/auth.json` | Account | One protected snapshot per profile; one atomic active slot. |
| Keyring auth alternative | OS keyring service `Codex Auth`, account key `cli\|<sha256(canonical CODEX_HOME)[0:16]>` | Account | v0.1 selects file storage so one shared home can retain multiple snapshots. |
| Encrypted auth alternative | `$CODEX_HOME/secrets/codex_auth.age`, key protected by OS keyring | Account | Detected as a compatibility case; not exported by v0.1. |
| User config | `$CODEX_HOME/config.toml`, `$CODEX_HOME/<name>.config.toml` | Shared workspace/user | Never profiled. Only the auth-store selector is patched in place. |
| Project config/instructions | `<repo>/.codex/config.toml`, `AGENTS.md`, `.agents/skills` | Shared project | Outside profile storage and untouched. |
| Skills/plugins/rules/hooks | `$CODEX_HOME/skills`, `plugins`, `rules`, plus config | Shared workspace/user | Untouched. |
| MCP definitions | `[mcp_servers.*]` and app/plugin entries in config | Shared workspace/user | Untouched. |
| MCP OAuth direct keyring | OS service `Codex MCP Credentials`, key derived from server name + URL | Shared integration | Already independent of ChatGPT account and left in place. |
| MCP OAuth file fallback | `$CODEX_HOME/.credentials.json` | Shared integration | Left in the one shared home. |
| MCP encrypted OAuth | `$CODEX_HOME/secrets/mcp_oauth.age` | Shared integration | Left in the one shared home. |
| Local conversations | `$CODEX_HOME/sessions`, `archived_sessions`, `session_index.jsonl`, `history.jsonl` | Shared workspace | Untouched and visible to every selected identity. |
| Thread/index database | `$CODEX_HOME/state_5.sqlite` (`threads`, sections, spawn edges, dynamic tools, backfill) | Shared workspace | Untouched. |
| Goals/logs/memories/queue | `$CODEX_HOME/goals_1.sqlite`, `logs_2.sqlite`, `memories_1.sqlite`, `queue_1.sqlite` | Shared workspace | Untouched. |
| Attachments/worktrees | `$CODEX_HOME/attachments`, `worktrees`, generated images, remote attachments | Shared workspace | Untouched. |
| Desktop project/UI state | `$CODEX_HOME/.codex-global-state.json` | Shared desktop workspace | Untouched; contains project ordering, roots, pinned threads, window state, and UI atoms. |
| Desktop package/cache state | Windows app package data and `%LOCALAPPDATA%\OpenAI\Codex` runtimes | Shared client installation | Untouched. |
| Remote thread object | OpenAI service, scoped to the creating account/workspace | Account/server | Cannot be reassigned locally; use a local fork handoff. |

The inspected local session header contains `id`, `timestamp`, `cwd`, `originator`, CLI version, source, model provider, instructions, tools, and Git metadata. It is local workspace context, not a safe authority for changing remote account ownership.

## Why an active-slot companion

Separate full `CODEX_HOME` directories initially look attractive, but they also separate sessions, config, databases, skills, plugins, UI state, and MCP encrypted-file state. Re-linking every internal path would be a brittle shadow filesystem and would miss newly introduced files.

Keeping one home and switching its single file-backed auth slot has the smallest compatibility surface:

1. On `init`, copy the existing valid auth slot into the first profile.
2. On `add`, run `codex login` with an isolated staging `CODEX_HOME` and file auth forced. The shared home is never touched.
3. On `use`, refuse concurrent Codex processes, lock the registry, identify the live auth slot, and capture it into the outgoing profile.
4. Write a switch journal, atomically install the target snapshot, parse it again, and compare the account fingerprint.
5. Commit active-profile metadata and remove the journal.

Refresh-token rotation is therefore retained during the next switch. If the live slot belongs to another known profile, metadata is repaired. If it belongs to an unknown account, switching stops without overwriting anything.

## Desktop compatibility adapter

`src/desktop.js` isolates process discovery, graceful shutdown, project resolution, and launch behavior from the profile transaction engine. On the verified Windows build it recognizes the Microsoft Store `OpenAI.Codex` process tree and the Desktop-owned local app-server, while leaving independent `codex login` and CLI processes outside that tree. Cold relaunch resolves the installed package AppID through Windows `Get-StartApps`, opens it through the stable `shell:AppsFolder` mechanism, waits for both app-server readiness and a visible top-level window, then focuses that window. Workspace restoration is delegated to Desktop's shared local project registry; no download-oriented CLI URI launcher is called.

The WPF launcher and generated Desktop shortcuts call that same adapter. The launcher deliberately uses a compact opaque per-monitor-DPI-aware window: WPF transparent/layered windows disable ClearType and made text and avatars look visibly soft. Its single Codex-gray surface retains native text rendering, uses installed Codex icon resources, protected high-resolution avatars, centered vector controls, full-title-bar dragging, and animated avatar-only profile targets. Profiles use a hidden-scroll horizontal carousel, so future accounts fit without card backgrounds, permanent scrollbars, or window growth. Ready-profile clicks invoke the browser-free switch transaction. A revoked profile invokes the explicit repair path, while Add Account starts at most one isolated login helper and keeps its waiting state visible.

The PowerShell WPF implementation runs in-process inside a small generated Windows GUI executable built from `CodexProfileHost.cs`; it is not launched by a visible PowerShell console. The host has a stable AppUserModelID and an embedded icon resolved from the installed Codex package, so Windows identifies the taskbar surface as Codex Profile instead of PowerShell. The generated binary is kept under the protected profile root and contains no credentials.

The Startup shortcut launches this host with `--start-hidden`. It creates the single-instance monitor but never shows the selector automatically. If Codex is absent, no companion window is visible; when a public Win32 Codex window appears, a 54 px independent Codex-logo overlay is attached near its bottom-right edge with extra right inset so it does not cover the vertical scrollbar. Clicking it opens the selector, leaving the built-in bottom-left account area unobstructed. They do not edit Electron assets, inject into Desktop, scrape UI content, or handle credential values. The installed app and current official extension surfaces expose no supported hook for adding an item to the built-in bottom-left account menu. Native menu/sidebar injection was rejected because it would couple the project to proprietary bundle layout, signing, and update behavior.

The companion is single-instance, lives outside the Codex process tree, and is automatically started or signaled after every successful profile switch. If it exited during shutdown/relaunch, the switch worker creates a fresh instance. The overlay is positioned from the public Win32 window rectangle only; it does not inspect Codex renderer data.

`src/shared-state.js` provides credential-blind before/after verification. It never opens `auth.json`: it compares hashes or semantic inventories for shared config/MCP definitions, skills, plugins, rules, Desktop project roots, repository state, and confirms that pre-existing local session files remain present.

## Failure semantics

Desktop switching is fail-safe rather than best-effort. The selected profile is first exercised against Codex's account/rate-limit interface in an isolated temporary home; this can safely retain token rotation but cannot affect the active Desktop slot. By default, revoked credentials stop the operation before Desktop is closed and no browser is launched. Repair is opt-in through `reauth` or `desktop use --repair-login`; a replacement credential is accepted only if its identity fingerprint matches the selected profile.

Windows relaunch uses the installed package AppID and succeeds only after both the app-server and a visible top-level Codex window exist; the window is then focused. `codex app <workspace>` is not used on Windows because the verified current CLI routes it through a ChatGPT installer/download surface rather than reliably navigating the installed Codex package. The shared Desktop project registry remains authoritative for workspace restoration.

After Desktop closes, any activation or identity failure attempts to restore the outgoing known profile. A close error also invokes the recovery launcher before returning the error, covering partial shutdowns without changing the active auth slot. The independent Windows watchdog then keeps activating the installed package AppID until both the main Desktop process and its app-server are present. There is deliberately no bounded retry count that can leave the application closed. Each attempt records only profile labels/emails, safe usage metadata, process outcomes, and shared-state comparison—never bearer credentials.

## Compatibility boundary

Codex-specific knowledge is isolated in `src/codex-adapter.js`, `src/auth.js`, and `src/app-server.js`. The app-server adapter exposes credential-free account, usage, and model-catalog projections while discarding raw protocol payloads. The registry and transaction engine operate on an opaque credential file plus a non-secret account fingerprint. A future Codex format/path change should require a new adapter, not changes to switching semantics.

The `doctor` command exposes the selected Codex version, adapter conditions, auth drift, switch journal, and process state. The registry has an explicit schema version and adapter id.

Primary references: [official authentication documentation](https://learn.chatgpt.com/docs/auth), [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp), [Codex 0.147 auth storage source](https://github.com/openai/codex/blob/rust-v0.147.0-alpha.6.6/codex-rs/login/src/auth/storage.rs), and [Codex 0.147 MCP OAuth source](https://github.com/openai/codex/blob/rust-v0.147.0-alpha.6.6/codex-rs/rmcp-client/src/oauth.rs).

## Profile registry

`state.json` contains labels, email when Codex exposes it, auth mode, plan label, identity fingerprint, UUIDs, and timestamps. It contains no access token, refresh token, API key, raw account id, or credential payload. Credentials live only at `profiles/<uuid>/auth.json`.

Filesystem writes use create-exclusive temporary files, `fsync`, and rename. POSIX files use mode `0600` and directories `0700`. Windows applies a protected ACL to the Codex Profile tree for the current user, SYSTEM, and Administrators; it does not alter the shared Codex home ACL. No credential material is written to logs, stdout, telemetry, crash reports, or repository files by this project.

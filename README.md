# Codex Profile

**Multiple accounts, one workspace.**

Codex Profile is an open-source companion for people who legitimately use more than one Codex/OpenAI account on one computer. It retains each login, lets the user choose the active identity, and leaves the existing Codex workspace in place.

See [SETUP.md](SETUP.md) for the install → detect existing account → add another account → one-click Desktop switch flow.

It does not rotate accounts automatically, bypass usage limits, patch the proprietary desktop UI, or copy workspace state into per-account silos.

## v0.1 flow

Requirements: Node.js 20+, a current `codex` installation, and the platform prerequisites for [Tauri 2](https://v2.tauri.app/start/prerequisites/).

```console
git clone <your-fork-url>
cd codex-profile
npm install -g .

# Detect and retain the account already logged in to Codex.
codex-profile init --label Personal

# Authenticate once in an isolated CODEX_HOME. The active account is untouched.
codex-profile add Work

codex-profile list --usage

# One action: close Desktop safely, switch, and reopen this project.
codex-profile desktop use Work

# Start the ordinary CLI in the same repository and shared Codex home.
codex-profile run
```

`add --device-code` uses Codex's device-code login when local browser callbacks are unsuitable. `run --profile Personal -- <codex arguments>` switches and launches in one command.

## Commands

| Command | Purpose |
| --- | --- |
| `init [--label LABEL]` | Create the registry and import the existing file-backed Codex login. |
| `add [LABEL] [--device-code]` | Run a new login in an isolated staging home and retain the result. |
| `reauth PROFILE [--device-code]` | Repair an expired/revoked retained login; replacement is accepted only when the account identity matches. |
| `list [--usage] [--json]` | Show labels, email when exposed by Codex, active state, auth health, plan, and active-account limits. |
| `use PROFILE [--force]` | Atomically activate a retained login. |
| `rename PROFILE LABEL` | Change a profile's display label without reading or rewriting its credentials. |
| `remove PROFILE [--force]` | Delete one retained credential snapshot. Active-profile removal requires `--force`. |
| `run [--profile PROFILE] [--] ...` | Launch the installed Codex CLI with the selected identity and shared home. |
| `handoff SESSION [--profile PROFILE]` | Fork a local session under the selected account when direct server continuation is not allowed. |
| `desktop use PROFILE [--workspace PATH] [--repair-login]` | Preflight auth, gracefully close Desktop, switch, and verify a packaged-app relaunch. Normal switching never opens a browser; `--repair-login` is an explicit opt-in for a revoked login. |
| `desktop menu` | Open the single-instance Tauri profile selector on Windows or macOS. |
| `desktop shortcuts` | Put one-click Switch and Relaunch shortcuts for retained profiles on the Windows Desktop. |
| `desktop status [--json]` | Show Desktop process state and the workspace that will be reopened. |
| `desktop audit [--json]` | Inspect the last credential-free identity and shared-state verification result. |
| `doctor [--json]` | Check Codex version, paths, auth mode, drift, incomplete switches, and running processes. |

Profile selectors accept an exact label, exact email, full UUID, or an unambiguous UUID prefix of at least eight characters.

## How it preserves one workspace

Codex Profile keeps the user's normal `CODEX_HOME` authoritative. Switching replaces only its account credential slot, `auth.json`, using a verified atomic write. Everything else remains exactly where Codex already keeps it:

- repositories and working trees;
- local sessions and archives;
- `config.toml` and project `.codex/config.toml` files;
- `AGENTS.md`, skills, plugins, rules, hooks, and automations;
- MCP server configuration and MCP OAuth credentials;
- attachments, memories, local databases, UI project organization, and caches.

Before switching, the live auth slot is captured back into the outgoing profile. That retains refresh-token rotation. A profile fingerprint derived from account identity prevents an unexpected credential from being overwritten or assigned to the wrong profile. A switch journal makes interrupted operations diagnosable.

Codex Profile sets `cli_auth_credentials_store = "file"` in the shared `config.toml`. This is necessary because Codex's OS-keyring auth entry is keyed by the canonical `CODEX_HOME`; one shared home otherwise has only one keyring auth slot. The file and profile directories are created with user-private modes where the OS supports POSIX permissions and inherit the user's protected home ACL on Windows.

## One-action Desktop switching

The current Desktop app owns an in-memory app-server auth manager. Replacing credentials under a running app can race token refreshes or leave the process using the old identity. `desktop use` handles that boundary as a single transaction:

1. validate the target profile in an isolated temporary home before touching Desktop; a revoked profile fails safely while Desktop remains usable and never opens a browser unless `--repair-login` was explicitly requested;
2. identify the installed Codex Desktop process tree without mistaking an isolated login for Desktop;
3. request a graceful Desktop close, with process termination only if it does not exit;
4. retain any rotated live credential in the outgoing profile and atomically install the selected profile;
5. if post-close identity verification fails, roll back to the outgoing account;
6. run an independent Windows watchdog that repeatedly activates the installed Codex package by AppID until the app-server **and a visible Desktop main window** are present;
7. bring that visible window to the foreground and let Desktop restore its own last project state.

The watchdog intentionally has no fixed retry ceiling: a transient Windows activation failure must not strand the user with Codex closed. Its credential-free result is recorded in `last-desktop-switch.json`, with an append-only local history in `desktop-switch-history.jsonl` under the protected profile directory.

If Desktop shutdown itself fails or only partially completes, the same watchdog restores the existing account and workspace before the command reports the failure. The auth slot is not changed in that case.

Run `codex-profile desktop shortcuts` for one-click `Codex Personal`, `Codex Secondary`, and `Codex Profile Menu` launchers on Windows. The installed Tauri application also registers itself for per-user startup with `--hidden`, so only its tray icon remains until the user chooses a profile.

The selector is a lightweight Tauri 2 shell around a framework-free TypeScript/Vite frontend. Its 780 x 470 borderless surface uses native WebView rendering, the current Codex neutral-gray palette, the icon loaded at runtime from the installed Codex package, high-resolution protected avatars, centered vector controls, a custom drag region, smooth selected/hover states, and reduced-motion support. There are no profile cards, embedded screenshots, Electron runtime, terminal window, or proprietary Desktop patches. A 52 px always-on-top launcher follows the public Codex window rectangle, stays out of the taskbar, hides when Codex closes, and opens the selector when clicked. It does not read or modify Codex renderer content. The Rust bridge strips account email, credential paths, and auth material before data reaches the webview. The previous WPF/PowerShell implementation lives under `legacy/windows` only as an unpackaged fallback when a Tauri binary cannot be found.

Ready-profile clicks are strictly browser-free. A card marked `Sign in required` means OpenAI rejected that retained OAuth session; clicking that exceptional state explicitly runs the supported one-time repair before switching. `Add account` also uses the supported isolated login, keeps the selector visible, reports that Chrome is waiting, and prevents a second hidden login helper from being started by repeated clicks.

On Windows, Codex Profile deliberately does **not** call `codex app <workspace>` after relaunch. The currently installed CLI routes that command to the ChatGPT app download page, which caused repeated `ChatGPT Installer (n).exe` downloads. AppID activation starts the already-installed package directly and Desktop restores its shared local project state.

## Sessions and handoff

Local session files remain visible after switching because they are workspace state. A remote conversation/thread may still be owned by the account that created it; another account can be forbidden from continuing the same server-side object. Codex Profile never presents that as seamless continuity.

Use `codex-profile handoff <session-id> --profile Work`. It delegates to Codex's local `fork` command, which creates a new thread from the locally available context under the selected identity. The original session remains intact.

## Usage and credential health

`list --usage` reads only the active account through Codex's app-server `account/read` and `account/rateLimits/read` methods. Inactive profiles are not refreshed merely to populate a dashboard; doing so could rotate tokens behind an active desktop process. Revocation can only be confirmed by Codex/OpenAI during an authenticated request. Locally, Codex Profile reports structural validity, expiry, and whether refresh material is available.

## Platform paths

| Platform | Profile registry default |
| --- | --- |
| Windows | `%LOCALAPPDATA%\CodexProfile` |
| macOS | `~/Library/Application Support/CodexProfile` |
| Linux | `$XDG_STATE_HOME/codex-profile` or `~/.local/state/codex-profile` |

`CODEX_PROFILE_HOME` and `CODEX_PROFILE_CODEX_HOME` override these paths for portable/testing scenarios. Standard `CODEX_HOME` remains supported. The Windows implementation resolves the native `codex.exe` behind npm/PowerShell shims to avoid shell execution and argument injection.

## Known v0.1 limitations

- The verified implementation targets file-backed auth. If an existing login exists only in an OS keyring or encrypted `secrets/codex_auth.age` store and no `auth.json` is present, `init` cannot export it; add the account once through `codex-profile add`.
- Desktop switching closes and reopens the client because no supported external hot-reload API imports an arbitrary retained credential. The bundled project registry is used to reopen the current project, but exact window/tab focus restoration remains Desktop-owned.
- Server-owned threads cannot move between accounts. `handoff` creates a truthful local fork instead.
- Usage is reliable only when Codex's current app-server exposes the account methods and the service returns limit data.
- A user-initiated logout revokes that account's OAuth session server-side, including retained refresh credentials. A normal profile click then fails safely before Desktop closes and never opens Chrome. Repair requires the explicit `reauth PROFILE` command or `desktop use PROFILE --repair-login`; an email address alone cannot securely replace OAuth consent, password, or 2FA.
- Codex Desktop exposes no supported third-party extension point for its built-in bottom-left account menu. v0.1 therefore keeps the selector in a signed-binary-independent Tauri companion/tray surface instead of injecting into proprietary assets.
- The Tauri shell, Node bridge, paths, tray, autostart, and macOS application bundle configuration are cross-platform. Windows was built and live-verified against the installed Desktop/CLI versions listed in [the project log](docs/PROJECT_LOG.md); a signed macOS build and live two-account Desktop cycle still need verification on macOS hardware.

## Development

```console
npm test
npm run check
npm run ui:visual-check
npm run tauri:build
npm pack --dry-run
```

Automated tests use synthetic JWT-shaped fixtures and a fake Codex process. They never read real credentials. A credential-blind shared-state verifier hashes config/MCP definitions, user skills, rules and project state; inventories plugins and bundled system skills without rejecting safe cache additions/refreshes; compares Desktop project roots; and checks that existing local sessions were not deleted. See [Architecture and storage map](docs/ARCHITECTURE.md), [Security](SECURITY.md), and [Project log](docs/PROJECT_LOG.md).

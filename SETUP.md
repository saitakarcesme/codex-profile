# Install Codex Profile

Codex Profile keeps multiple legitimate Codex/OpenAI logins while preserving one shared Codex workspace.

## Requirements

- Node.js 20 or newer
- Git
- A current Codex CLI installation
- Codex Desktop for one-action close/switch/relaunch
- Rust stable and the platform prerequisites listed by [Tauri](https://v2.tauri.app/start/prerequisites/) when building the desktop UI from source
- One Codex account already signed in on the computer

Verify the prerequisites:

```console
node --version
codex --version
git --version
```

## Install from GitHub

```console
git clone https://github.com/saitakarcesme/codex-profile.git
cd codex-profile
npm install -g .
npm install
npm run tauri:build
codex-profile doctor
```

The install is local. No credential is uploaded to this repository or to a Codex Profile service.

## Keep the existing account

With the primary account already signed in to Codex:

```console
codex-profile init --label Personal
```

This copies only the current file-backed Codex authentication into protected profile storage. It does not move repositories, sessions, config, skills, plugins, MCP settings, or project state.

## Add another account once

```console
codex-profile add Secondary
```

Complete the supported OpenAI sign-in in the browser. The login runs in an isolated temporary Codex home, so the active `Personal` login is not destroyed. Normal switching is browser-free after this one-time login.

If browser callbacks are unsuitable, use:

```console
codex-profile add Secondary --device-code
```

Confirm both profiles:

```console
codex-profile list --usage
```

The Windows installer is produced at `src-tauri/target/release/bundle/nsis/`. The MSI is beside it under `bundle/msi`. On macOS, the same command produces the `.app`/DMG on a Mac.

## One-click Desktop switching

```console
codex-profile desktop shortcuts
```

This creates:

- one Desktop shortcut per profile;
- a `Codex Profile Menu` shortcut;
- a Startup shortcut that runs the companion invisibly.

The Tauri companion starts hidden in the system tray at sign-in. Choose `Codex Profile` from the tray, then choose a profile. Codex Profile safely closes Desktop, switches the protected auth slot, relaunches the installed Codex package, and keeps the same workspace authoritative. `codex-profile desktop menu` opens or focuses the same single instance.

You can also switch from a terminal:

```console
codex-profile desktop use Personal
codex-profile desktop use Secondary
```

## macOS

The Tauri frontend and Rust shell are shared with Windows. macOS-specific autostart uses a LaunchAgent; Node process/path handling uses the existing macOS adapter. Build on a Mac with `npm run tauri:build`. The source is cross-platform, but v0.1 has not yet completed a live signed-package/two-real-account cycle on Mac hardware.

## Linux

The CLI profile store and atomic switching paths are implemented for Linux. The current desktop bundle targets Windows/macOS; close active Codex processes, then run:

```console
codex-profile use Secondary
codex
```

Live multi-account Desktop validation on macOS and Linux is still pending.

## Updating

```console
cd codex-profile
git pull --ff-only
npm install -g .
codex-profile desktop shortcuts
codex-profile doctor
```

Rebuilding or reinstalling the Tauri shell never touches stored accounts. Regenerating Windows shortcuts updates their target without touching profile data.

## Credential recovery

Normal profile selection never opens a browser. If OpenAI has revoked or expired a retained session, repair it explicitly:

```console
codex-profile reauth Secondary
```

or, for the one-action Desktop flow:

```console
codex-profile desktop use Secondary --repair-login
```

Codex Profile accepts the replacement only when it belongs to the same account identity.

## Security notes

- Never commit or share `auth.json`, `.credentials.json`, `codex_auth.age`, `mcp_oauth.age`, crash dumps, or verbose Codex logs.
- Profile credentials are stored under `%LOCALAPPDATA%\CodexProfile` on Windows, `~/Library/Application Support/CodexProfile` on macOS, and `$XDG_STATE_HOME/codex-profile` on Linux.
- Removing the npm package does not delete stored profile credentials automatically. This avoids accidental account loss; remove profiles explicitly with `codex-profile remove` first if desired.

For design boundaries and troubleshooting, see [README.md](README.md), [Security](SECURITY.md), and [Architecture](docs/ARCHITECTURE.md).

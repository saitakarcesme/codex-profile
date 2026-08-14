# Install Codex Profile

Codex Profile keeps multiple legitimate Codex/OpenAI logins while preserving one shared Codex workspace.

## Give this repository to Codex on a Mac

The repository is intentionally self-installing through this document. A Mac user can give Codex the GitHub URL and say only:

> Bu repoyu SETUP.md üzerinden Mac'e kur.

Codex should then follow the **Codex agent: complete macOS installation** section below from start to finish. It should perform the terminal work itself, preserve any existing Codex Profile accounts, and pause only when macOS or OpenAI requires the user to approve an installation or complete an interactive sign-in.

## Codex agent: complete macOS installation

These are execution instructions for a Codex agent operating on the user's Mac.

1. Confirm the host is macOS with `uname -s`. Never copy, print, stage, or upload Codex authentication files.
2. Check for Git, Node.js 20 or newer, the Xcode Command Line Tools, Rust stable, the current Codex CLI, and the installed Codex Desktop app. Use these checks:

   ```console
   git --version
   node --version
   xcode-select -p
   rustc --version
   cargo --version
   codex --version
   test -d /Applications/ChatGPT.app || test -d /Applications/Codex.app
   ```

   Install only missing prerequisites from their official sources. Prefer Homebrew when it is already installed. `xcode-select --install` requires the user to approve Apple's dialog. Do not use `sudo npm install -g`; the desktop bundle can be installed without a global npm package.
3. Clone `https://github.com/saitakarcesme/codex-profile.git` into a normal user-owned source directory. For an existing clone, preserve uncommitted work, switch to `main`, and update only with `git pull --ff-only`. Do not reset or delete user changes.
4. From the repository root, install the locked dependencies and verify the source:

   ```console
   npm ci
   npm test
   npm run check
   npm run tauri:build
   ```

5. Install the generated application bundle. Quit an older running Codex Profile instance first. Prefer `/Applications`; if that directory is not writable, use the user's `~/Applications` directory instead:

   ```console
   SOURCE_APP="$PWD/src-tauri/target/release/bundle/macos/Codex Profile.app"
   test -d "$SOURCE_APP"
   osascript -e 'tell application "Codex Profile" to quit' 2>/dev/null || true
   if test -w /Applications; then
     DESTINATION_APP="/Applications/Codex Profile.app"
   else
     mkdir -p "$HOME/Applications"
     DESTINATION_APP="$HOME/Applications/Codex Profile.app"
   fi
   /usr/bin/ditto "$SOURCE_APP" "$DESTINATION_APP"
   ```

   Do not remove `~/Library/Application Support/CodexProfile`; it contains the user's protected profile registry and is intentionally preserved across reinstalls.
6. Initialize the registry through the repository-local CLI so global npm permissions cannot block setup:

   ```console
   node bin/codex-profile.js init --label Personal
   node bin/codex-profile.js doctor
   node bin/codex-profile.js list
   ```

   Start the installed application after initialization:

   ```console
   if test -d "/Applications/Codex Profile.app"; then
     open "/Applications/Codex Profile.app"
   else
     open "$HOME/Applications/Codex Profile.app"
   fi
   ```

   If `init` reports that no existing file-backed account was found, ask the user to select **Add account** and complete the official OpenAI sign-in. Never attempt to automate credentials, passwords, consent, or 2FA. After the user finishes, rerun `node bin/codex-profile.js list` and confirm at least one profile is present.
7. Finish only after all of the following are true: the installed application launches, `doctor` completes without a blocking error, the selector lists the retained or newly added account, and that account shows its own dynamically fetched avatar when OpenAI supplies one. Report the installed app path and any optional prerequisite that remains unavailable.

The app contains its own Codex Profile JavaScript core, but Node.js 20+ remains a runtime requirement. Opening the release app registers its per-user macOS LaunchAgent so the tray/menu-bar companion can start hidden at login.

## Requirements

- Node.js 20 or newer
- Git
- A current Codex CLI installation
- Codex Desktop for one-action close/switch/relaunch
- Rust stable and the platform prerequisites listed by [Tauri](https://v2.tauri.app/start/prerequisites/) when building the desktop UI from source
- Optionally, one existing Codex account to import; otherwise the installer initializes an empty registry and the user signs in through **Add account**

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
npm ci
npm install -g .
npm run tauri:build
codex-profile doctor
```

The global CLI installation is optional on macOS; every command can instead be run as `node bin/codex-profile.js ...` from the clone. The install is local. No credential is uploaded to this repository or to a Codex Profile service.

The build generates the macOS, Windows, Linux, tray/menu-bar, taskbar, and shortcut icons from the transparent master logo in `assets/brand/codex-profile-logo.png`. Rebuilding keeps every shell surface on the same mark.

`npm run ui:visual-check` automatically uses Edge, Chrome, or Chromium. Set `CODEX_PROFILE_BROWSER_BIN` when the browser executable lives elsewhere.

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

## Windows one-click Desktop shortcuts

```console
codex-profile desktop shortcuts
```

This creates:

- one Desktop shortcut per profile;
- a `Codex Profile Menu` shortcut;
- a Startup shortcut that runs the companion invisibly.

The Tauri companion starts hidden in the system tray at sign-in. Choose `Codex Profile` from the tray, then choose a profile. Codex Profile safely closes Desktop, switches the protected auth slot, relaunches the installed Codex package, and keeps the same workspace authoritative. `codex-profile desktop menu` opens or focuses the same single instance.

On macOS, launch the installed `Codex Profile.app` directly or choose it from its menu-bar item; Windows shortcut generation is not required.

You can also switch from a terminal:

```console
codex-profile desktop use Personal
codex-profile desktop use Secondary
```

## macOS

The Tauri frontend and Rust shell are shared with Windows. macOS-specific autostart uses a LaunchAgent; Node process/path handling uses the macOS adapter. The release `.app` build, installation under `/Applications`, transparent native window corners, menu-bar icon, bundled core discovery, and dynamic real-account avatar path have been live-verified on Apple Silicon macOS. A locally source-built bundle is not an Apple-notarized public release; macOS may therefore ask the user to confirm first launch according to the machine's Gatekeeper policy.

## Linux

The CLI profile store and atomic switching paths are implemented for Linux. The current desktop bundle targets Windows/macOS; close active Codex processes, then run:

```console
codex-profile use Secondary
codex
```

Live Linux Desktop validation and a two-real-account macOS switch cycle remain pending; the macOS build and single-account installed-app flow are verified.

## Updating

```console
cd codex-profile
git pull --ff-only
npm ci
npm run tauri:build
# Reinstall the generated bundle using the macOS step above.
node bin/codex-profile.js doctor
```

Rebuilding or reinstalling the Tauri shell never touches stored accounts. On Windows, regenerating shortcuts updates their target without touching profile data.

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

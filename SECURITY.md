# Security policy

Codex Profile manages bearer credentials. Treat its profile directory with the same care as the standard Codex auth store.

## Guarantees and design rules

- Credential payloads are never printed, logged, committed, included in registry metadata, sent to project telemetry, or copied into the repository.
- Switching validates account fingerprints before and after the atomic write.
- Unexpected live credentials stop a switch instead of being overwritten.
- Existing Codex processes block normal switching to avoid stale in-memory tokens and refresh races.
- MCP credentials stay in the existing shared Codex store and are not copied into account profiles.
- Tests use synthetic, nonfunctional credentials only.
- On Windows, the profile credential tree has protected NTFS inheritance and grants access only to the current user, SYSTEM, and Administrators. The shared Codex home is not re-ACL'd.
- Target credentials are exercised in an isolated temporary home before Desktop is closed. Reauthorization replaces a snapshot only after its account fingerprint matches the selected profile.
- Desktop audit/history files contain labels, email/plan/limit metadata, process outcomes, and shared-state comparisons only. They never include raw auth payloads or tokens.

Local attackers already running as the same OS user can generally access that user's Codex session, standard `auth.json`, and this tool's snapshots. Disk encryption, a locked OS session, and a protected user account remain necessary. Administrators/root can also bypass ordinary file permissions.

Do not attach `auth.json`, `.credentials.json`, encrypted secret-store files, crash dumps, or verbose Codex logs to bug reports. Run `codex-profile doctor --json`; its output is designed to be credential-free.

Report vulnerabilities privately to the maintainers of the eventual project repository. Include a minimal synthetic reproduction and never include a working OpenAI credential.

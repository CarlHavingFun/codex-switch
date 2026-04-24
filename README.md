# codex-switch

`codex-switch` is a Node.js/TypeScript CLI for managing multiple isolated Codex login profiles.

It keeps each profile in its own `CODEX_HOME`, stores sensitive `auth.json` data in the OS credential store, and lets you switch manually between profiles without overwriting one shared Codex login state.

The repository also ships a Windows-only tray app that uses the CLI as its backend. The tray app gives you a global active-profile switcher for future Codex launches, shows best-effort remaining usage and reset times, and can automatically discover a new raw `codex login` from the default `~/.codex/auth.json`.

See [docs/login-flow.md](docs/login-flow.md) for a sanitized write-up of the observed Codex ChatGPT login flow and workspace-selection findings.

## Features

- Multiple isolated Codex profiles
- `import-current` to capture an existing Codex login
- `login` with optional auto-naming from `email__chatgpt_account_id`
- Windows-default isolated browser login, with `--native-browser` as an explicit fallback
- Same-account dedupe based on `chatgpt_account_id`
- `authFingerprint` tracking so external logins and token refreshes can be synchronized safely
- Best-effort workspace title detection from ChatGPT JWT claims
- `sync-current` to import or switch to the current raw Codex login
- `--json` output for tray/frontend integrations
- `run` passthrough so Codex launches under the selected profile
- `desktop launch` to start the official Codex desktop app under a managed session on Windows
- `desktop status` to inspect the managed desktop sync state
- `desktop switch` to restart the managed Codex desktop app on another saved profile
- Optional shell hook so `codex` can transparently route through `codex-switch`
- Windows tray app for one-click manual profile switching

## Requirements

- Node.js 20+
- A working `codex` CLI in `PATH`, or `CODEX_SWITCH_CODEX_COMMAND` configured
- OS credential store support compatible with `keytar`

## Install

```bash
npm install
npm run build
```

For local CLI usage:

```bash
npm link
```

For the Windows tray app, `codex-switch.cmd` should be available in `PATH`. If you prefer not to `npm link`, set `CODEX_SWITCH_TRAY_COMMAND` to the command or full path you want the tray app to launch.

## User Config

Personal desktop settings such as proxy information, the Codex Desktop path, and the preferred working directory live in a local JSON config file:

- default path: `~/.codex-switch/config.json`
- if `CODEX_SWITCH_HOME` is set: `<CODEX_SWITCH_HOME>/config.json`

Example:

```json
{
  "codex": {
    "command": "codex",
    "commandArgs": []
  },
  "desktop": {
    "proxyUrl": "http://127.0.0.1:7890",
    "clientPath": "",
    "workingDirectory": "D:\\001_CODEX",
    "clientArgs": [],
    "monitorPollIntervalMs": 60000
  }
}
```

Notes:

- this file is machine-local and should not be committed
- matching environment variables still override config values
- `monitorPollIntervalMs` controls how often the managed desktop monitor checks for workspace/profile changes

## Basic Usage

### Windows PowerShell Quick Start

If you want the shortest path on Windows:

```powershell
npm install
npm run build
npm link
codex-switch import-current
codex-switch list
codex-switch use "<your-profile>"
Invoke-Expression (& codex-switch shell init pwsh | Out-String)
codex
```

What each step does:

- `npm link`: makes `codex-switch` available as a global command so the tray app and your shell can find it
- `import-current`: captures the login currently stored in the default `~/.codex`
- `list`: shows the profiles currently managed by `codex-switch`
- `use`: marks one profile as the active profile
- `shell init pwsh`: teaches the current PowerShell session to route `codex` through `codex-switch run`
- `codex`: after the shell hook is loaded, this starts Codex under the active managed profile

If you want the shell hook every time PowerShell starts, add it to `$PROFILE`:

```powershell
if (!(Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force }
Add-Content $PROFILE 'Invoke-Expression (& codex-switch shell init pwsh | Out-String)'
```

Import the currently logged-in Codex state:

```bash
codex-switch import-current
```

Create a new profile through the official login flow:

```bash
codex-switch login
codex-switch login team-a
codex-switch login --isolated-browser
codex-switch login --native-browser
```

On Windows, plain `codex-switch login` now defaults to the isolated-browser flow. `codex-switch` starts the official `codex app-server account/login/start` flow inside the managed profile, opens the returned ChatGPT auth URL in an isolated Chrome/Edge user-data directory, and waits for the official `account/login/completed` notification before using the resulting `auth.json`. This keeps the upstream login context intact while still reducing broken session state from the everyday browser profile.

Use `--native-browser` if you explicitly want the old behavior and let the upstream `codex login` command control both the browser launch and token exchange. Use `--isolated-browser` if you want to force the isolated app-server-backed flow explicitly in scripts or cross-check behavior.

View and switch profiles:

```bash
codex-switch list
codex-switch status --all
codex-switch use team-a
codex-switch sync-current
```

Run Codex under the active profile:

```bash
codex-switch run
codex-switch run -- --version
```

Initialize a shell hook:

```bash
codex-switch shell init pwsh
codex-switch shell init bash
codex-switch shell init zsh
```

Machine-readable output is available for integrations:

```bash
codex-switch list --json
codex-switch status --all --json
codex-switch use team-a --json
codex-switch sync-current --json
codex-switch desktop status --json
codex-switch desktop switch team-a --json
```

### Managed Codex Desktop Launch

On Windows, `codex-switch` can also launch the official Codex desktop app through a managed session:

```powershell
codex-switch desktop launch
codex-switch desktop status
codex-switch desktop switch team-a
```

This mode is the supported way to keep `codex-switch` and the official Codex desktop app aligned:

- `codex-switch` seeds the desktop session from the current active managed profile
- the desktop app runs with a dedicated managed `CODEX_HOME`
- a background monitor watches that managed desktop session for auth changes
- when the desktop app switches to another workspace, `codex-switch` imports or reuses the matching `chatgptAccountId` profile and marks it active
- the managed desktop monitor checks for changes every 60 seconds by default
- `desktop switch <profile>` restarts the managed desktop app onto another saved profile

Current v1 boundary:

- automatic desktop sync is only guaranteed for Codex desktop instances launched through `codex-switch desktop launch`
- already-running desktop instances and VS Code / Cursor extensions are not auto-synchronized

### Tray App Quick Start

1. Run `npm link` once so `codex-switch.cmd` is in `PATH`.
2. Start `windows-tray/publish/win-x64/CodexSwitch.Tray.exe`.
3. In the tray menu, use `Launch Codex Desktop`, `Add Profile`, or `Import Current Login`.
4. If managed desktop sync is running, clicking a profile restarts the desktop app on that profile. Otherwise it just updates the active profile for future launches.
5. Launch future managed Codex sessions with `codex-switch run`, or use the PowerShell shell hook so plain `codex` follows the active profile.

## Windows Tray App

The tray app is in `windows-tray/CodexSwitch.Tray`. It does not replace every running Codex session in the system. Instead, it maintains one global active profile for the managed `codex-switch` flow, so the next terminal/Codex process you launch through that flow uses the selected profile.

The tray app:

- shows all managed profiles in the system tray
- displays best-effort workspace, remaining usage, and reset time
- lets you click a profile to make it active
- supports `Add Profile` and `Import Current Login`
- can launch the official Codex desktop app through `Launch Codex Desktop`
- shows whether desktop auto-sync is connected
- restarts the managed desktop app onto a selected profile when you click a profile while desktop sync is running
- watches the default `~/.codex/auth.json` and syncs newly detected external logins

Build and test it with:

```bash
npm run build:tray
npm run test:tray
```

Publish a Windows binary with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/publish-windows-tray.ps1
```

## Command Summary

- `codex-switch login [profile] [--isolated-browser|--native-browser]`
- `codex-switch import-current [profile]`
- `codex-switch list`
- `codex-switch status [--all|--profile <name>]`
- `codex-switch sync-current`
- `codex-switch desktop launch`
- `codex-switch desktop status`
- `codex-switch desktop switch <profile>`
- `codex-switch use <profile>`
- `codex-switch run [--profile <name>] -- <codex args...>`
- `codex-switch doctor`
- `codex-switch shell init <pwsh|bash|zsh>`

## Security Notes

- Sensitive authentication material is stored in the system credential store, not committed to the repository.
- Managed profile homes keep non-sensitive Codex state and sanitized skeleton files only.
- Workspace detection is best-effort and intended for display, not as a stable unique identifier.
- The tray app and CLI switch a managed global active profile for future launches. Desktop auto-sync only applies to official Codex desktop instances launched through `codex-switch desktop launch`; already-running desktop instances and the VS Code Codex extension are outside this v1 guarantee.

## FAQ

### Why is the default profile name something like `user@example.com__66414859-b7e5-42c4-a8f4-549b05779e09`?

That is the current auto-generated naming rule for imports and logins without a manually supplied profile name:

- left side: the ChatGPT email found in the login token
- right side: the ChatGPT account/workspace identifier (`chatgpt_account_id`)

This is intentionally stable and dedupe-friendly, because the right-hand identifier is what `codex-switch` uses to recognize â€œthe same profileâ€ across re-imports and logins.

If you want a friendlier label, pass one explicitly:

```bash
codex-switch import-current team-a
codex-switch login personal
```

The underlying profile still keeps the account/workspace metadata internally even if the display name is friendlier.

### Can the same email account produce multiple managed profiles?

Yes. `codex-switch` dedupes by `chatgpt_account_id`, not just by email.

In real login captures, two different workspace selections under the same email account produced two different `chatgpt_account_id` values. That means the same ChatGPT email can still map to multiple managed profiles when different workspace/account contexts are selected during login.

This is also why `organizations[].title` is treated as best-effort display data only. In the observed login flow, that title was not always enough to distinguish the actual workspace context, while `chatgpt_account_id` was.

## Development

```bash
npm test
npm run check
npm run build
npm run test:tray
npm run build:tray
```

## License

MIT

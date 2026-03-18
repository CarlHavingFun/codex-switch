# codex-switch

`codex-switch` is a Node.js/TypeScript CLI for managing multiple isolated Codex login profiles.

It keeps each profile in its own `CODEX_HOME`, stores sensitive `auth.json` data in the OS credential store, and lets you switch manually between profiles without overwriting one shared Codex login state.

## Features

- Multiple isolated Codex profiles
- `import-current` to capture an existing Codex login
- `login` with optional auto-naming from `email__chatgpt_account_id`
- Same-account dedupe based on `chatgpt_account_id`
- Best-effort workspace title detection from ChatGPT JWT claims
- `run` passthrough so Codex launches under the selected profile
- Optional shell hook so `codex` can transparently route through `codex-switch`

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

## Basic Usage

Import the currently logged-in Codex state:

```bash
codex-switch import-current
```

Create a new profile through the official login flow:

```bash
codex-switch login
codex-switch login team-a
```

View and switch profiles:

```bash
codex-switch list
codex-switch status --all
codex-switch use team-a
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

## Command Summary

- `codex-switch login [profile]`
- `codex-switch import-current [profile]`
- `codex-switch list`
- `codex-switch status [--all|--profile <name>]`
- `codex-switch use <profile>`
- `codex-switch run [--profile <name>] -- <codex args...>`
- `codex-switch doctor`
- `codex-switch shell init <pwsh|bash|zsh>`

## Security Notes

- Sensitive authentication material is stored in the system credential store, not committed to the repository.
- Managed profile homes keep non-sensitive Codex state and sanitized skeleton files only.
- Workspace detection is best-effort and intended for display, not as a stable unique identifier.

## Development

```bash
npm test
npm run check
npm run build
```

## License

MIT

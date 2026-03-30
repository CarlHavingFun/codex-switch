# Codex Login Flow Notes

This document summarizes the observed Codex ChatGPT login flow in a sanitized form.

It is based on:

- `codex app-server` JSON-RPC messages
- browser network logging during a real sign-in
- post-login `auth.json` / JWT claim inspection

No raw captures, personal identifiers, tokens, request IDs, or local user paths are committed to the repository.

## Scope

These notes describe the public CLI-visible flow and the browser-visible auth flow used during a successful ChatGPT login for Codex.

They do not claim to document every private desktop-only API used by the official Codex desktop app.

## High-Level Result

Observed facts:

- The public `account/login/start` response provides a login type, login ID, and browser auth URL.
- The public `account/login/completed` / `account/updated` notifications do not expose a `workspaceTitle`.
- After a successful login, the CLI-visible account state includes `authMode`, `planType`, and JWT claims such as `chatgpt_account_id` and `organizations[]`.
- A successful browser flow includes an extra workspace-selection step before the final consent redirect.

## JSON-RPC Sequence

The CLI-side flow starts with:

1. `initialize`
2. `account/login/start`

The login-start response contains:

- `type = "chatgpt"`
- `loginId = <uuid>`
- `authUrl = https://auth.openai.com/oauth/authorize?...`

After a successful browser flow, the CLI then receives:

1. `account/login/completed`
2. `account/updated`

Observed `account/updated` payload shape:

```json
{
  "authMode": "chatgpt",
  "planType": "team"
}
```

Notably absent from the public notifications:

- `workspaceTitle`
- `workspaceName`
- `organizations[]`

## Authorize URL Shape

The browser is launched with an authorization URL of this general form:

```text
https://auth.openai.com/oauth/authorize
  ?response_type=code
  &client_id=<client_id>
  &redirect_uri=http://localhost:1455/auth/callback
  &scope=openid profile email offline_access api.connectors.read api.connectors.invoke
  &code_challenge=<pkce_challenge>
  &code_challenge_method=S256
  &id_token_add_organizations=true
  &codex_cli_simplified_flow=true
  &state=<state>
  &originator=Codex Desktop
```

## Successful Browser Flow

In a successful observed run, the browser-side flow reached these endpoints in order:

1. `/oauth/authorize`
2. `/api/oauth/oauth2/auth`
3. `/api/accounts/login`
4. `/log-in`
5. `/api/accounts/authorize/continue`
6. `/api/accounts/password/verify`
7. `/log-in/password`
8. `/api/accounts/mfa/issue_challenge`
9. `/api/accounts/mfa/verify`
10. `/mfa-challenge/<challenge>`
11. `/api/accounts/workspace/select`
12. `/sign-in-with-chatgpt/codex/consent`
13. `/api/oauth/oauth2/auth` with `login_verifier`
14. `/api/accounts/consent` with `consent_challenge`
15. `/api/oauth/oauth2/auth` with `consent_verifier`
16. `http://localhost:1455/auth/callback`
17. `http://localhost:1455/success`

Important observation:

- `POST /api/accounts/workspace/select` occurs after password/MFA and before the final consent redirect.

This was the most important extra step visible in the successful run.

## Failure Pattern

In the failed `missing_required_parameter` runs, the flow did not complete the full sequence above.

The failure pattern was:

1. `/oauth/authorize`
2. `/api/oauth/oauth2/auth`
3. `/api/accounts/login`
4. browser error page at `/error?payload=...`

Because of that early failure:

- the localhost callback was never reached
- `account/login/completed` either reported failure or never reached the successful state
- no post-login claims were available to inspect

## What Becomes Visible After Success

Once login succeeds and `auth.json` is written, the JWT claims expose fields like:

- `email`
- `chatgpt_account_id`
- `chatgpt_plan_type`
- `organizations[]`

An example sanitized shape:

```json
{
  "email": "<user@example.com>",
  "https://api.openai.com/auth": {
    "chatgpt_account_id": "<account-or-workspace-id>",
    "chatgpt_plan_type": "team",
    "organizations": [
      {
        "id": "<org-id>",
        "title": "<org-title>",
        "is_default": true,
        "role": "owner"
      }
    ]
  }
}
```

## Workspace Name Findings

Observed conclusions:

- The public CLI-visible protocol does not directly return a workspace display name.
- The final localhost callback does not expose a friendly workspace display name either.
- JWT claims may contain `organizations[].title`, but that value is not guaranteed to match the user-facing workspace label shown by every Codex client surface.
- The existence of `/api/accounts/workspace/select` strongly suggests that some workspace/account context is selected in the browser flow before consent completes.

Additional findings from two successful logins under the same email account:

- Two different workspace selections produced two different `chatgpt_account_id` values.
- In the successful browser capture that included `POST /api/accounts/workspace/select`, the submitted `workspace_id` exactly matched the final JWT `chatgpt_account_id`.
- In both successful runs, `organizations[].title` still appeared as `Personal`, so it was not sufficient to distinguish the two workspace contexts by itself.

Current best inference:

- A user-facing workspace label shown by the desktop client is more likely to come from browser/private auth UI state around workspace selection than from the public CLI protocol.
- For profile isolation and dedupe, `chatgpt_account_id` is the strongest workspace-distinguishing identifier currently visible to `codex-switch`.

## Why Isolated-Browser Login Helps

Observed conclusion from repeated failures and a successful isolated run:

- the standard `codex login` flow already uses browser sign-in
- the failing runs did not appear to be missing the standard OAuth query parameters in the initial authorize URL
- the successful isolated run used the same broad authorize URL shape, but completed when the browser flow ran in a separate Chromium user-data directory

Current best inference:

- the earlier failures were more likely caused by broken or stale browser-side auth session state after the initial login challenge
- they were not explained by a missing top-level CLI authorize parameter

This is why `codex-switch` exposes an isolated-browser login mode:

- it keeps the official `codex app-server` login flow
- it launches the auth URL in an isolated Chromium profile on Windows
- it reduces the chance that a polluted everyday browser profile breaks the login sequence before workspace selection and consent complete

Current `codex-switch` behavior:

- on Windows, `codex-switch login` defaults to the isolated-browser strategy
- `codex-switch login --native-browser` explicitly falls back to the upstream `codex login` browser flow

## Implications For `codex-switch`

These findings support the current design choices:

- profile isolation should continue to use per-profile `CODEX_HOME`
- `chatgpt_account_id` is a better dedupe key than a friendly display label
- workspace display should remain best-effort
- any friendly workspace title should be treated as a display hint, not a stable unique identifier

## Privacy And Repository Hygiene

Do not commit:

- raw `auth.json`
- raw browser netlogs
- raw login captures under `output/`
- real email addresses
- real account IDs, org IDs, request IDs, or callback URLs

Repository policy for this project:

- `output/` is ignored
- only sanitized summaries belong in version control

# Hired Gun for Claude (MCP server and skill)

Lets Claude Code, Claude Desktop or any MCP client look at Hired Gun jobs and, only with an explicit human yes, create one. It wraps the operator CLI in `../../operator/`. Design and safety rules: `../../docs/operator-api-contract.md` (section 6).

The CLI and package names below are **placeholders** (`hg-operator`, workspace-private package `gigagent-operator-wip`) until the human chooses the real name; change `operator/src/names.ts`, `operator/package.json` `bin`, and these files together.

## One-time setup (on the operator's machine)

1. `npm install && npm run build` in the repo.
2. The server must have `OPERATOR_API_ENABLED=1`.
3. Mint a token with the admin token, without ever putting it in a file or flag, and save it as this machine's login:
   ```
   GIGAGENT_SERVER=https://YOUR-SERVER GIGAGENT_ADMIN_TOKEN=... \
     node operator/dist/bin.js tokens create --label claude --preset read --save
   ```
   Presets: `read` (look only, the default), `claude` (read plus create jobs), `operate`, `full`. Claude tokens never get instruct/kill/revoke: the MCP server does not expose them even if the token had them. Webhook and email targets are off unless you pass `--allow-webhook-host` / `--allow-email`.
4. Check it: `node operator/dist/bin.js doctor`.

## Use it from Claude Code

```
claude mcp add hired-gun -- node /ABSOLUTE/PATH/TO/repo/operator/dist/bin.js mcp
```

or install this folder as a Claude Code plugin (`integrations/claude/`: `.claude-plugin/plugin.json`, `.mcp.json`, `skills/hired-gun/SKILL.md`). Do not blanket-allow `hired_gun_create_job` in your permission rules: the per-call prompt is part of the safety design.

For Claude Desktop add the same command and args to `claude_desktop_config.json` under `mcpServers`. The token is read from the macOS Keychain, `GIGAGENT_OPERATOR_TOKEN_FILE`, or the private credentials file, never from the config.

## Tools

Read-only: `hired_gun_whoami`, `hired_gun_get_config`, `hired_gun_list_jobs`, `hired_gun_get_job`, `hired_gun_get_session`, `hired_gun_get_session_events`.
Needs `invites:create`: `hired_gun_prepare_job` (validates, creates nothing, returns a `draft_id`) and `hired_gun_create_job` (needs that `draft_id` and `user_confirmed: true`; one use per draft; at most 3 jobs per hour per MCP process).

Options: `GIGAGENT_MCP_REDACT_CODE=1` copies the command to the clipboard (macOS) and returns the code masked, so it never enters the transcript.

## Safety in one paragraph

Read-only unless the token allows creating jobs. The server process refuses the master `ADMIN_TOKEN`. A job can only be created from a previously prepared draft, so what the user saw is what is created; if the client supports MCP elicitation the user also gets a confirmation dialog. All text written on the recipient's computer is returned under an `untrusted` key, stripped of control characters and clipped. Secrets are scrubbed from every output and log line.

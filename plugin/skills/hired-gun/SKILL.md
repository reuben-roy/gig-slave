---
name: hired-gun
description: Use when the user wants a task done on another person's Mac (or their own) through Hired Gun: creating a job and its one-time code, watching progress, sending instructions, stopping it, or reading the structured result.
---

# Hired Gun jobs

Hired Gun runs a helper agent on a Mac after the person at that computer types a one-time code. You manage jobs through the `hired-gun` MCP tools. You never touch the admin token or the dashboard.

## Connect (once)

If the tools are missing or return an authorization error, run `/mcp`, select `hired-gun` and authenticate. A browser page opens where the service owner approves this connection and chooses which account and permissions it gets. Do not try to approve it yourself or ask for the owner's admin token.

Headless agents can use an operator token instead: `claude mcp add --transport http hired-gun <server>/mcp --header "Authorization: Bearer $HIRED_GUN_TOKEN"`. Get the token with `hired-gun login` (the owner approves the request), never by asking for it.

## Run a job

1. `get_account`: read your limits (jobs at once, per day, longest job, allowed models).
2. `create_job` with `label`, `task` (plain English, no secrets), and an `idempotency_key` you choose once per intended job. Retrying with the same key never creates a second job.
3. Give the user the returned `command` (`npx gigagent ABCD-EFGH`). The person at the computer has to run it themselves; nothing happens until they do. The code is shown once. If it is lost, `reissue_code` (only works before anyone has run it).
4. `get_job` with `wait_seconds: 20`, repeatedly, until `state` is `succeeded`, `failed`, `stopped` or `expired`. States: `waiting_for_recipient`, `running`, then one of those four.
5. Read `job.result`: `summary` (for the person at the computer), `answer` (what you asked for), `findings` and `changes`. Use `get_job_events` for the step-by-step log.

## While it runs

- `send_instruction` sends a follow-up (fails with `not_running` if nobody is connected).
- `stop_job` stops it. It is safe to repeat. Offer it if the helper is going the wrong way.

## Rules

- One job per person-at-a-computer request; do not create jobs the user did not ask for.
- A job only touches the folder named in `working_dir` and the helper is told never to delete, only move. Say so when you ask the user to confirm the task.
- Errors come back with a `code` (`limit_exceeded`, `not_running`, `idempotency_conflict`, `insufficient_scope`, `not_found`); report them plainly rather than retrying blindly.

import { config } from "./config.js";
import {
  addEvent, getInvite, getSession, inviteJson, parseResult, run, sessionJson,
  type InviteRow, type Result, type SessionRow,
} from "./db.js";

const TIMEOUT_MS = 5000;

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

interface Ctx {
  invite: InviteRow;
  session: SessionRow;
  result: Result | null;
  ok: boolean;
  summary: string;
  url: string;
  machine: string;
  took: string;
}

function context(invite: InviteRow, session: SessionRow): Ctx {
  const result = parseResult(session.result);
  const m = session.machine ? (JSON.parse(session.machine) as Record<string, string>) : null;
  return {
    invite, session, result,
    ok: session.status === "done",
    summary: result?.summary || session.report || session.status_text || "",
    url: `${config.publicUrl}/dashboard#session=${session.id}`,
    machine: m ? [m.hostname, m.username && `(${m.username})`, m.platform].filter(Boolean).join(" ") : "",
    took: session.ended_at ? duration(session.ended_at - session.started_at) : "",
  };
}

const subject = (x: Ctx) =>
  x.ok ? `✅ Hired Gun: "${x.invite.label}" is done` : `⚠️ Hired Gun: "${x.invite.label}" needs attention`;

function emailContent(x: Ctx) {
  const { result } = x;
  const rows: string[] = [];
  if (x.machine) rows.push(`<tr><td style="color:#6b7280;padding:2px 12px 2px 0">Machine</td><td>${esc(x.machine)}</td></tr>`);
  if (x.took) rows.push(`<tr><td style="color:#6b7280;padding:2px 12px 2px 0">Took</td><td>${esc(x.took)}</td></tr>`);
  rows.push(`<tr><td style="color:#6b7280;padding:2px 12px 2px 0">Task</td><td>${esc(clip(x.invite.task, 300))}</td></tr>`);

  const findings = result?.findings ?? [];
  const changes = result?.changes ?? [];
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:620px;margin:0 auto;padding:24px">
<div style="background:#fff;border-radius:10px;padding:24px;border:1px solid #e5e7eb">
<div style="font-size:13px;color:#6b7280;margin-bottom:6px">Hired Gun</div>
<h1 style="font-size:20px;margin:0 0 12px">${x.ok ? "✅" : "⚠️"} ${esc(x.invite.label)} ${x.ok ? "is done" : "needs attention"}</h1>
<p style="font-size:15px;line-height:1.5;margin:0 0 16px;white-space:pre-wrap">${esc(clip(x.summary, 4000))}</p>
${result?.answer ? `<h2 style="font-size:14px;margin:16px 0 6px">Answer</h2><div style="font-size:14px;line-height:1.5;white-space:pre-wrap;background:#f9fafb;border-radius:6px;padding:10px 12px">${esc(clip(result.answer, 6000))}</div>` : ""}
${findings.length ? `<h2 style="font-size:14px;margin:16px 0 6px">Findings</h2><table style="border-collapse:collapse;font-size:14px;width:100%">${findings.map((f) => `<tr><td style="border-top:1px solid #e5e7eb;padding:6px 12px 6px 0;color:#6b7280;vertical-align:top">${esc(f.label)}</td><td style="border-top:1px solid #e5e7eb;padding:6px 0">${esc(f.value)}</td></tr>`).join("")}</table>` : ""}
${changes.length ? `<h2 style="font-size:14px;margin:16px 0 6px">Changes made</h2><ul style="font-size:14px;line-height:1.5;margin:0;padding-left:20px">${changes.slice(0, 50).map((c) => `<li>${esc(c)}</li>`).join("")}</ul>${changes.length > 50 ? `<p style="font-size:13px;color:#6b7280">…and ${changes.length - 50} more</p>` : ""}` : ""}
<table style="font-size:13px;margin:20px 0 0">${rows.join("")}</table>
<p style="margin:20px 0 0"><a href="${esc(x.url)}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:14px">Open in dashboard</a></p>
</div></div></body></html>`;

  const text = [
    subject(x),
    "",
    clip(x.summary, 4000),
    result?.answer ? `\nAnswer:\n${clip(result.answer, 6000)}` : "",
    findings.length ? `\nFindings:\n${findings.map((f) => `- ${f.label}: ${f.value}`).join("\n")}` : "",
    changes.length ? `\nChanges:\n${changes.slice(0, 50).map((c) => `- ${c}`).join("\n")}` : "",
    x.machine ? `\nMachine: ${x.machine}` : "",
    x.took ? `Took: ${x.took}` : "",
    `\n${x.url}`,
  ].filter((l) => l !== "").join("\n");

  return { html, text };
}

/** Slack mrkdwn: & < > are control characters (links, @channel, <!here>). Escape all agent-controlled text. */
const sl = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function slackText(x: Ctx) {
  const lines = [
    `*${x.ok ? "✅" : "⚠️"} Hired Gun: "${sl(clip(x.invite.label, 200))}" ${x.ok ? "is done" : "needs attention"}*`,
    sl(clip(x.summary, 1500)),
  ];
  if (x.result?.answer) lines.push(`*Answer*\n${sl(clip(x.result.answer, 1500))}`);
  if (x.result?.findings.length) {
    lines.push(
      x.result.findings.slice(0, 15).map((f) => `• *${sl(clip(f.label, 100))}:* ${sl(clip(f.value, 300))}`).join("\n"),
    );
  }
  if (x.machine) lines.push(`_${sl(x.machine)}${x.took ? `, took ${x.took}` : ""}_`);
  lines.push(`<${x.url}|Open in dashboard>`); // our own link: the only unescaped angle brackets
  return lines.join("\n\n");
}

/** Break @everyone / @here with a zero-width space (allowed_mentions also blocks every ping server-side). */
const dc = (s: unknown) => String(s ?? "").replace(/@(everyone|here)/gi, "@\u200b$1");

function discordText(x: Ctx) {
  const head = `**${x.ok ? "✅" : "⚠️"} Hired Gun: "${dc(clip(x.invite.label, 200))}" ${x.ok ? "is done" : "needs attention"}**`;
  const tail = `\n${x.url}`;
  const body = dc(clip(x.summary + (x.result?.answer ? `\n\n${x.result.answer}` : ""), 1900 - head.length - tail.length));
  return `${head}\n${body}${tail}`;
}

async function attempt(sessionId: string, channel: "email" | "webhook", fn: () => Promise<string>) {
  let ok = false;
  let detail: string;
  try {
    detail = await fn();
    ok = true;
  } catch (e) {
    detail = clip((e as Error)?.message || String(e), 300);
  }
  try {
    await addEvent(sessionId, "notification", { channel, ok, detail });
  } catch (e) {
    console.error("notification event failed:", (e as Error).message);
  }
}

async function sendEmail(x: Ctx): Promise<string> {
  const { html, text } = emailContent(x);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${config.resendApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: config.notifyFrom, to: x.invite.notify_email, subject: subject(x), html, text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${clip(await res.text().catch(() => ""), 200)}`);
  return `Sent to ${x.invite.notify_email}`;
}

async function sendWebhook(x: Ctx): Promise<string> {
  const url = new URL(x.invite.notify_webhook!);
  const host = url.hostname.toLowerCase();
  let payload: unknown;
  if (host === "hooks.slack.com") payload = { text: slackText(x) };
  else if (host === "discord.com" || host.endsWith(".discord.com") || host === "discordapp.com" || host.endsWith(".discordapp.com")) {
    payload = { content: discordText(x), allowed_mentions: { parse: [] } };
  } else {
    payload = {
      type: "gigagent.session.ended",
      invite: inviteJson(x.invite),
      session: sessionJson(x.session),
      result: x.result,
      dashboard_url: x.url,
    };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status >= 300) throw new Error(`HTTP ${res.status} from ${host}`);
  return `HTTP ${res.status} from ${host}`;
}

/**
 * Notify once per session when it ended as done/failed. Atomic guard on sessions.notified,
 * so concurrent callers (agent + sweeper) cannot double-send. Never throws; awaited by callers.
 */
export async function notifySession(sessionId: string): Promise<void> {
  try {
    const claimed = await run(
      "UPDATE sessions SET notified = TRUE WHERE id = $1 AND notified = FALSE AND status IN ('done', 'failed')",
      [sessionId],
    );
    if (!claimed) return;
    const session = await getSession(sessionId);
    const invite = session && (await getInvite(session.invite_id));
    if (!session || !invite) return;
    const x = context(invite, session);

    const jobs: Promise<void>[] = [];
    if (config.resendApiKey && invite.notify_email) jobs.push(attempt(sessionId, "email", () => sendEmail(x)));
    if (invite.notify_webhook) jobs.push(attempt(sessionId, "webhook", () => sendWebhook(x)));
    await Promise.all(jobs);
  } catch (e) {
    console.error("notifySession failed:", (e as Error).message);
  }
}

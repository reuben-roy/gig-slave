import { config } from "./config.js";
import { all, one, run } from "./db.js";

/**
 * Operator audit trail (docs/operator-api-contract.md section 3.4).
 * Stores ids, lengths and status only: never token secrets, request bodies, task text, instruction text or invite codes.
 */
export interface AuditInput {
  actor: "admin" | "operator";
  token_id?: string | null;
  action: string;
  target_type?: "invite" | "session" | "token" | null;
  target_id?: string | null;
  status: number;
  ip?: string | null;
  client?: string | null;
  detail?: string | null;
}

const clip = (v: string | null | undefined, n: number) => (v ? v.slice(0, n) : null);

export async function writeAudit(a: AuditInput) {
  try {
    await run(
      `INSERT INTO operator_audit (ts, actor, token_id, action, target_type, target_id, status, ok, ip, client, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        Date.now(), a.actor, a.token_id ?? null, a.action, a.target_type ?? null, clip(a.target_id, 64),
        a.status, a.status < 400, clip(a.ip, 64), clip(a.client, 64), clip(a.detail, 200),
      ],
    );
  } catch (e) {
    // Auditing must never break the request that already happened.
    console.error("audit write failed:", (e as Error).message);
  }
}

export async function countRecent(tokenId: string, action: string, sinceMs: number) {
  const r = await one<{ n: string }>(
    "SELECT COUNT(*) AS n FROM operator_audit WHERE token_id = $1 AND action = $2 AND ok = TRUE AND ts > $3",
    [tokenId, action, sinceMs],
  );
  return Number(r?.n ?? 0);
}

let lastPrune = 0;
/** Lazy retention: at most once per 10 minutes per instance; no cron, no sweeper change. */
export async function pruneLazy(now = Date.now()) {
  if (now - lastPrune < 600_000) return;
  lastPrune = now;
  try {
    await run("DELETE FROM operator_audit WHERE ts < $1", [now - config.operatorAuditRetentionDays * 86_400_000]);
    await run("DELETE FROM idempotency_keys WHERE created_at < $1", [now - 86_400_000]);
  } catch (e) {
    console.error("audit prune failed:", (e as Error).message);
  }
}

export interface AuditQuery {
  after?: number;
  limit: number;
  token_id?: string;
  action?: string;
}

export async function listAudit(q: AuditQuery) {
  const conds: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    conds.push(sql.replace("?", `$${params.length}`));
  };
  if (q.after) add("a.id > ?", q.after);
  if (q.token_id) add("a.token_id = ?", q.token_id);
  if (q.action) add("a.action = ?", q.action);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  // Without a cursor: the latest N (returned oldest first). With a cursor: the next N after it.
  const order = q.after ? "ASC" : "DESC";
  const rows = await all(
    `SELECT a.*, t.label AS token_label FROM operator_audit a LEFT JOIN operator_tokens t ON t.id = a.token_id
     ${where} ORDER BY a.id ${order} LIMIT ${q.limit}`,
    params,
  );
  if (!q.after) rows.reverse();
  const entries = rows.map((r) => ({
    id: Number(r.id), ts: Number(r.ts), actor: r.actor as string, token_id: (r.token_id ?? null) as string | null,
    token_label: (r.token_label ?? null) as string | null, action: r.action as string,
    target_type: (r.target_type ?? null) as string | null, target_id: (r.target_id ?? null) as string | null,
    status: Number(r.status), ok: r.ok === true || r.ok === "t", ip: (r.ip ?? null) as string | null,
    client: (r.client ?? null) as string | null, detail: (r.detail ?? null) as string | null,
  }));
  return { entries, next: entries.length ? entries[entries.length - 1].id : null };
}

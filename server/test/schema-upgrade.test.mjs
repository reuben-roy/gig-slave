// A database created before operator accounts existed must upgrade in place, and re-running the schema must be a no-op.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const SCHEMA = readFileSync(new URL("../dist/db.js", import.meta.url), "utf8").match(/const SCHEMA = `([\s\S]*?)`;/)[1];

test("adds operator columns to an existing invites table and is idempotent", async () => {
  const pg = new PGlite("memory://");
  await pg.exec(`CREATE TABLE invites (
    id TEXT PRIMARY KEY, seq BIGSERIAL, code_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
    task TEXT NOT NULL, working_dir TEXT NOT NULL, model TEXT NOT NULL,
    expiry_policy TEXT NOT NULL, expires_at BIGINT, max_redemptions INTEGER,
    redemptions INTEGER NOT NULL DEFAULT 0, failed_attempts INTEGER NOT NULL DEFAULT 0,
    notify_email TEXT, notify_webhook TEXT, status TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
  )`);
  await pg.query(
    `INSERT INTO invites (id, code_hash, label, task, working_dir, model, expiry_policy, status, created_at, updated_at)
     VALUES ('old', 'h', 'old job', 't', '~', 'm', 'one_use', 'pending', 1, 1)`,
  );

  await pg.exec(SCHEMA);
  await pg.exec(SCHEMA);

  const cols = (await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'invites'`)).rows.map((r) => r.column_name);
  for (const c of ["operator_id", "idem_key", "idem_hash"]) assert.ok(cols.includes(c), `invites.${c}`);
  const old = (await pg.query(`SELECT operator_id, idem_key FROM invites WHERE id = 'old'`)).rows[0];
  assert.deepEqual(old, { operator_id: null, idem_key: null });

  // two jobs without a key never collide on the idempotency index; a repeated key for one operator does
  const ins = (id, key) =>
    pg.query(
      `INSERT INTO invites (id, code_hash, label, task, working_dir, model, expiry_policy, status, created_at, updated_at, operator_id, idem_key)
       VALUES ($1, $1, 'l', 't', '~', 'm', 'one_use', 'pending', 1, 1, 'op', $2)`,
      [id, key],
    );
  await ins("a", null);
  await ins("b", null);
  await ins("c", "k");
  await assert.rejects(ins("d", "k"), /unique|duplicate/i);
  await pg.close();
});

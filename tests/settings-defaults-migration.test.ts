// Migration 0003 corrects settings.report_send_time / thankyou_send_time's
// column DEFAULTs (which were wrong — '18:00'/'17:30' instead of spec §5's
// '17:30'/'17:00', the winter-window bug's root cause — see
// netlify/functions/email-cron.mts's header) and, in the same migration,
// rewrites the singleton row IF it's still sitting at those old defaults.
//
// This can't be exercised through the normal createTestDb() + migrate()
// helper (tests/helpers/db.ts): that helper always applies the ENTIRE
// migrations folder in one shot, so by the time any test code runs, 0003
// has already applied — there's no way to observe a "pre-0003" row through
// it. To actually test "does 0003 rewrite an untouched-default row but
// leave an admin-customized one alone", this file drives a bare PGlite
// instance directly: build the settings table exactly as it existed AFTER
// migration 0002 (0001/0002 never touch the settings table, so
// drizzle/0000_init.sql's original CREATE TABLE — frozen, per that file's
// own "do NOT regenerate" policy — IS that exact state), seed a row by
// hand, then execute migration 0003's REAL SQL file (read from disk, not
// re-typed here, so this actually verifies the shipped migration).
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PRE_0003_SETTINGS_DDL = `
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"approve_mode" boolean DEFAULT true NOT NULL,
	"report_send_time" text DEFAULT '18:00' NOT NULL,
	"thankyou_send_time" text DEFAULT '17:30' NOT NULL,
	"report_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"open_seats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "settings_singleton" CHECK ("id" = 1)
);
`;

const MIGRATION_0003_SQL = readFileSync(
  path.resolve(__dirname, '../drizzle/0003_open_princess_powerful.sql'),
  'utf-8',
).replace(/-->\s*statement-breakpoint/g, ';');

type SettingsRow = { id: number; report_send_time: string; thankyou_send_time: string };

async function freshPreMigrationDb(): Promise<PGlite> {
  const client = new PGlite();
  await client.exec(PRE_0003_SETTINGS_DDL);
  return client;
}

async function selectSettings(client: PGlite): Promise<SettingsRow> {
  const res = await client.query('SELECT * FROM "settings" WHERE id = 1');
  return (res.rows as unknown as SettingsRow[])[0];
}

describe('migration 0003: settings send-time defaults', () => {
  it('rewrites a row still sitting at the old (wrong) defaults', async () => {
    const client = await freshPreMigrationDb();
    await client.query('INSERT INTO "settings" (id) VALUES (1)'); // relies on the OLD column defaults
    const before = await selectSettings(client);
    expect(before.report_send_time).toBe('18:00');
    expect(before.thankyou_send_time).toBe('17:30');

    await client.exec(MIGRATION_0003_SQL);

    const after = await selectSettings(client);
    expect(after.report_send_time).toBe('17:30');
    expect(after.thankyou_send_time).toBe('17:00');
  });

  it('also corrects the column DEFAULT itself, for any future singleton insert', async () => {
    const client = await freshPreMigrationDb();
    await client.exec(MIGRATION_0003_SQL); // no row yet — only the DEFAULT/no-op UPDATE run
    await client.query('INSERT INTO "settings" (id) VALUES (1)'); // relies on the NEW column defaults
    const after = await selectSettings(client);
    expect(after.report_send_time).toBe('17:30');
    expect(after.thankyou_send_time).toBe('17:00');
  });

  it('leaves a fully admin-customized row untouched (both columns survive)', async () => {
    const client = await freshPreMigrationDb();
    await client.query(`INSERT INTO "settings" (id, report_send_time, thankyou_send_time) VALUES (1, '19:15', '18:45')`);

    await client.exec(MIGRATION_0003_SQL);

    const after = await selectSettings(client);
    expect(after.report_send_time).toBe('19:15'); // admin's custom value survives
    expect(after.thankyou_send_time).toBe('18:45');
  });

  it('leaves BOTH columns untouched when only thankyou_send_time was customized (dual-column guard)', async () => {
    // report_send_time is still exactly the OLD default ('18:00') in
    // isolation, but thankyou_send_time was customized away from ITS old
    // default ('17:30' -> '17:45'). The migration's WHERE guards both
    // columns together, so neither gets rewritten here — a single-column
    // guard keyed on report_send_time alone would have incorrectly
    // clobbered this admin's customized thankyou_send_time back to '17:00'.
    const client = await freshPreMigrationDb();
    await client.query(`INSERT INTO "settings" (id, report_send_time, thankyou_send_time) VALUES (1, '18:00', '17:45')`);

    await client.exec(MIGRATION_0003_SQL);

    const after = await selectSettings(client);
    expect(after.report_send_time).toBe('18:00');
    expect(after.thankyou_send_time).toBe('17:45');
  });
});

#!/usr/bin/env node
/**
 * Seed: 5 usług z zasadami grafiku, stanowiska, grafik tygodniowy (godziny otwarcia z src/build.py + przerwa),
 * czasy trwania i konto admina. Domyślne liczby: api/_lib/defaults.js.
 * Można uruchamiać wielokrotnie – uzupełnia tylko to, czego brakuje, i nie nadpisuje ustawień zmienionych w panelu.
 *
 * Konto admina: ADMIN_LOGIN i ADMIN_PASSWORD z env. Lokalnie bez ADMIN_PASSWORD hasło zostanie wylosowane i wypisane;
 * przy wdrożeniu (onDeploy) nigdy nie losujemy – logi builda nie są miejscem na hasła.
 */
const crypto = require("crypto");
require("./env").load();
const { tx, closePool } = require("../api/_lib/db");
const { hashPassword } = require("../api/_lib/auth");
const SERVICES = require("../api/_uslugi.json");
const DEFAULTS = require("../api/_lib/defaults");
const { migrate } = require("./migrate");

const DEPOSIT = 5000; // 50 zł – wartość prototypowa, zmieniana w panelu (Usługi)

/** Przedziały godzin pracy dla dnia: godziny otwarcia minus przerwa (pon–pt). */
function intervals(weekday, open, close) {
  const br = DEFAULTS.weekdayBreak;
  if (!br || weekday > 5 || !(br[0] > open && br[1] < close)) return [[open, close]];
  return [[open, br[0]], [br[1], close]];
}

async function seed({ quiet = false, adminLogin, adminPassword, onDeploy = false } = {}) {
  await migrate({ quiet: true });
  const log = quiet ? () => {} : console.log;
  return tx(async (c) => {
    let sort = 0;
    const ids = {};
    for (const [slug, s] of Object.entries(SERVICES)) {
      const d = DEFAULTS.services[slug] || { base: 30, buffer: 10, step: 30, notice: 60, daysAhead: 60, durations: {} };
      const { rows: [svc] } = await c.query(
        `INSERT INTO services (slug, name, deposit_amount, deposit_required, uses_slots, sort)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, uses_slots = EXCLUDED.uses_slots, sort = EXCLUDED.sort
         RETURNING *`,
        // ubezpieczenia = prośba o kontakt bez terminu, więc zaliczka domyślnie wyłączona (można włączyć w panelu)
        [slug, s.name, DEPOSIT, s.slots, s.slots, sort++]);
      ids[slug] = svc.id;
      if (!svc.defaults_applied) {
        // pierwszy raz (albo usługa sprzed grafiku): wartości z defaults.js; potem zmienia się je tylko w panelu
        await c.query(
          `UPDATE services SET base_minutes = $2, buffer_minutes = $3, step_minutes = $4, min_notice_minutes = $5,
                               max_days_ahead = $6, duration_rules = $7, defaults_applied = true WHERE id = $1`,
          [svc.id, d.base, d.buffer, d.step, d.notice, d.daysAhead, JSON.stringify(d.durations)]);
      }

      const { rows: [{ n }] } = await c.query("SELECT count(*)::int AS n FROM service_hours WHERE service_id = $1", [svc.id]);
      if (!n && svc.uses_slots) {
        for (const [dow, [open, close]] of Object.entries(s.hours)) {
          const wd = Number(dow) === 0 ? 7 : Number(dow);
          for (const [a, b] of intervals(wd, open, close)) {
            await c.query("INSERT INTO service_hours (service_id, weekday, start_time, end_time) VALUES ($1, $2, $3, $4)", [svc.id, wd, a, b]);
          }
        }
        log(`usługa ${slug}: grafik tygodniowy`);
      }
    }

    const { rows: [{ n: resCount }] } = await c.query("SELECT count(*)::int AS n FROM resources");
    if (!resCount) {
      let i = 0;
      for (const r of DEFAULTS.resources) {
        const { rows: [res] } = await c.query("INSERT INTO resources (name, sort) VALUES ($1, $2) RETURNING id", [r.name, i++]);
        for (const slug of r.services) if (ids[slug]) await c.query("INSERT INTO service_resources VALUES ($1, $2) ON CONFLICT DO NOTHING", [ids[slug], res.id]);
      }
      log(`stanowiska: ${DEFAULTS.resources.length}`);
    }

    // rezerwacje sprzed grafiku (z dawnych slotów) – przypisujemy pierwsze wolne stanowisko usługi
    const { rows: legacy } = await c.query(
      "SELECT id, service_id FROM bookings WHERE resource_id IS NULL AND start_at IS NOT NULL AND status IN ('pending_payment', 'confirmed')");
    for (const b of legacy) {
      const { rows: res } = await c.query("SELECT resource_id FROM service_resources WHERE service_id = $1 ORDER BY resource_id", [b.service_id]);
      for (const r of res) {
        await c.query("SAVEPOINT legacy");
        try { await c.query("UPDATE bookings SET resource_id = $2 WHERE id = $1", [b.id, r.resource_id]); await c.query("RELEASE SAVEPOINT legacy"); break; }
        catch (e) { await c.query("ROLLBACK TO SAVEPOINT legacy"); }
      }
    }

    const loginName = (adminLogin || process.env.ADMIN_LOGIN || "admin").trim().toLowerCase();
    const pass = adminPassword || process.env.ADMIN_PASSWORD;
    const { rows: [existing] } = await c.query("SELECT id FROM admin_users WHERE login = $1", [loginName]);
    if (!existing && !pass && onDeploy) {
      log(`admin: brak konta „${loginName}” – ustaw ADMIN_PASSWORD w zmiennych środowiskowych i wdróż ponownie`);
    } else if (!existing) {
      const pwd = pass || crypto.randomBytes(9).toString("base64url");
      await c.query("INSERT INTO admin_users (login, password_hash) VALUES ($1, $2)", [loginName, hashPassword(pwd)]);
      log(pass ? `admin: utworzono konto „${loginName}”` : `admin: utworzono konto „${loginName}”, hasło: ${pwd}  (zapisz je – nie pokażę go ponownie)`);
    } else if (pass) {
      await c.query("UPDATE admin_users SET password_hash = $2 WHERE id = $1", [existing.id, hashPassword(pass)]);
      log(`admin: zaktualizowano hasło konta „${loginName}”`);
    }
  });
}

module.exports = { seed };

if (require.main === module) {
  seed().then(() => { console.log("Seed gotowy."); return closePool(); })
    .catch((e) => { console.error("Seed nie powiódł się:", e.message); process.exit(1); });
}

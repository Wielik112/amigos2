#!/usr/bin/env node
/**
 * Seed: 5 usług, sloty na 2 tygodnie (godziny otwarcia z src/build.py), konto admina.
 * Można uruchamiać wielokrotnie – nie dubluje danych i nie nadpisuje ustawień zmienionych w panelu.
 *
 * Konto admina: ADMIN_LOGIN i ADMIN_PASSWORD z env. Bez ADMIN_PASSWORD hasło zostanie wylosowane i wypisane.
 * Istniejącemu kontu hasło zmienia się tylko, gdy ustawisz ADMIN_PASSWORD.
 */
const crypto = require("crypto");
require("./env").load();
const { tx, closePool } = require("../api/_lib/db");
const { generateSlots } = require("../api/_lib/slots");
const { hashPassword } = require("../api/_lib/auth");
const SERVICES = require("../api/_uslugi.json");
const { migrate } = require("./migrate");

const DEPOSIT = 5000; // 50 zł – wartość prototypowa, zmieniana w panelu (Ustawienia usług)
const DAYS = 14;

const ymd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw" }).format(d);

/**
 * onDeploy = true (wywołanie z build na Vercelu): sloty startowe tylko dla usług, które nie mają jeszcze
 * żadnego slotu (żeby slotów usuniętych w panelu nie odtwarzać przy każdym wdrożeniu), a hasło admina
 * wyłącznie z ADMIN_PASSWORD – nigdy losowe (logi builda nie są miejscem na hasła).
 */
async function seed({ quiet = false, adminLogin, adminPassword, days = DAYS, onDeploy = false } = {}) {
  await migrate({ quiet: true });
  const log = quiet ? () => {} : console.log;
  return tx(async (c) => {
    let sort = 0;
    for (const [slug, s] of Object.entries(SERVICES)) {
      const { rows: [svc] } = await c.query(
        `INSERT INTO services (slug, name, deposit_amount, deposit_required, slot_duration_minutes, uses_slots, sort)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, uses_slots = EXCLUDED.uses_slots, sort = EXCLUDED.sort
         RETURNING *`,
        // ubezpieczenia = prośba o kontakt bez terminu, więc zaliczka domyślnie wyłączona (można włączyć w panelu)
        [slug, s.name, DEPOSIT, s.slots, s.slotMinutes || 30, s.slots, sort++]);
      if (!svc.uses_slots) continue;
      if (onDeploy) {
        const { rows: [{ n }] } = await c.query("SELECT count(*)::int AS n FROM slots WHERE service_id = $1", [svc.id]);
        if (n) continue;
      }
      const from = ymd(new Date());
      const to = ymd(new Date(Date.now() + (days - 1) * 86400000));
      let n = 0;
      for (const [dow, [open, close]] of Object.entries(s.hours)) {
        n += await generateSlots({
          serviceId: svc.id, from, to, weekdays: [Number(dow) === 0 ? 7 : Number(dow)],
          timeFrom: open, timeTo: close, duration: svc.slot_duration_minutes, capacity: 1,
        }, c);
      }
      log(`usługa ${slug}: +${n} slotów`);
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

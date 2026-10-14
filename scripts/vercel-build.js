#!/usr/bin/env node
/**
 * Krok build na Vercelu (`npm run vercel-build`, uruchamiany automatycznie przy każdym wdrożeniu):
 * sprawdza konfigurację i przygotowuje bazę – migracje, usługi, sloty startowe, konto admina.
 * Wszystko jest idempotentne i nie nadpisuje ustawień zmienionych w panelu.
 */
require("./env").load();
const { getConfig, ConfigError } = require("../api/_lib/config");

(async () => {
  try {
    getConfig();
  } catch (e) {
    if (e instanceof ConfigError && !process.env.DATABASE_URL) {
      console.warn("⚠ Brak DATABASE_URL – strona się wdroży, ale rezerwacje nie zadziałają. Podłącz bazę (Vercel → Storage) i wdróż ponownie.");
      return;
    }
    console.error("✖ " + e.message);   // np. PAYMENTS_MODE=real bez kluczy Stripe – wdrożenie się zatrzyma
    process.exit(1);
  }
  const { seed } = require("./seed");
  const { closePool } = require("../api/_lib/db");
  await seed({ onDeploy: true });
  await closePool();
  console.log("✔ Baza gotowa.");
})().catch((e) => { console.error("✖ Przygotowanie bazy nie powiodło się:", e.message); process.exit(1); });

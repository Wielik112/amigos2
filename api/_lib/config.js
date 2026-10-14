/**
 * Konfiguracja z env. Czytana przy każdym wywołaniu (tanie), żeby testy mogły zmieniać tryb.
 * Przy PAYMENTS_MODE=real bez kluczy Stripe rzuca błąd – serwer deweloperski nie wstanie,
 * a funkcje na Vercelu zwrócą 500 z tym komunikatem w logach.
 */
class ConfigError extends Error {}

function getConfig() {
  const env = process.env;
  const mode = (env.PAYMENTS_MODE || "mock").trim().toLowerCase();
  if (mode !== "mock" && mode !== "real") {
    throw new ConfigError(`PAYMENTS_MODE="${env.PAYMENTS_MODE}" – dozwolone wartości: mock | real.`);
  }
  if (mode === "real") {
    const missing = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "PUBLIC_BASE_URL"].filter((k) => !(env[k] || "").trim());
    if (missing.length) {
      throw new ConfigError(`PAYMENTS_MODE=real wymaga ustawienia: ${missing.join(", ")}. ` +
        "Uzupełnij zmienne środowiskowe albo wróć do PAYMENTS_MODE=mock (zob. README: „Jak przełączyć na prawdziwe płatności”).");
    }
  }
  if (!(env.DATABASE_URL || "").trim()) throw new ConfigError("Brak DATABASE_URL (adres bazy Postgres) – zob. .env.example.");
  return {
    paymentsMode: mode,
    stripeSecretKey: env.STRIPE_SECRET_KEY || "",
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
    publicBaseUrl: (env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
    databaseUrl: env.DATABASE_URL,
    holdMinutes: Math.max(1, Number(env.HOLD_MINUTES) || 15),
    cronSecret: env.CRON_SECRET || "",
  };
}

module.exports = { getConfig, ConfigError, TZ: "Europe/Warsaw" };

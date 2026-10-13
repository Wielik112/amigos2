const { query } = require("./db");

/**
 * Limit żądań w oknie czasowym, trzymany w bazie (instancje funkcji serverless nie dzielą pamięci).
 * Zwraca true, gdy limit został przekroczony.
 */
async function isLimited(key, max, windowSeconds) {
  const { rows } = await query(
    `WITH ins AS (INSERT INTO rate_limits (key) VALUES ($1))
     SELECT count(*)::int AS n FROM rate_limits WHERE key = $1 AND at > now() - make_interval(secs => $2)`,
    [key, windowSeconds]);
  // sprzątanie starych wpisów co jakiś czas
  if (Math.random() < 0.02) query("DELETE FROM rate_limits WHERE at < now() - interval '1 day'").catch(() => {});
  return rows[0].n + 1 > max;   // +1: wiersz z CTE nie jest widoczny w tym samym zapytaniu
}

async function resetLimit(key) {
  await query("DELETE FROM rate_limits WHERE key = $1", [key]);
}

module.exports = { isLimited, resetLimit };

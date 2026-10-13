/**
 * Logowanie admina: hasło hashowane scryptem (node:crypto, bez zależności), sesja w ciasteczku httpOnly.
 * W bazie trzymamy tylko sha256 tokenu sesji.
 */
const crypto = require("crypto");
const { query } = require("./db");
const { HttpError, parseCookies } = require("./http");

const COOKIE = "amigos_admin";
const SESSION_HOURS = 12;
const SCRYPT = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64");
  const got = crypto.scryptSync(String(password), Buffer.from(salt, "base64"), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, got);
}

// stały hash do porównania, gdy login nie istnieje (ten sam czas odpowiedzi)
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString("hex"));

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");

const isSecure = (req) => String(req.headers["x-forwarded-proto"] || "").includes("https") || /^https:/.test(process.env.PUBLIC_BASE_URL || "");

function cookie(req, value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isSecure(req) ? "; Secure" : ""}`;
}

async function login(req, loginName, password) {
  const { rows: [u] } = await query("SELECT * FROM admin_users WHERE login = $1", [String(loginName || "").trim().toLowerCase()]);
  const ok = verifyPassword(password, u ? u.password_hash : DUMMY_HASH) && !!u;
  if (!ok) return null;
  const token = crypto.randomBytes(32).toString("base64url");
  await query("INSERT INTO admin_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))",
    [sha(token), u.id, SESSION_HOURS]);
  query("DELETE FROM admin_sessions WHERE expires_at < now()").catch(() => {});
  return { user: { id: u.id, login: u.login }, setCookie: cookie(req, token, SESSION_HOURS * 3600) };
}

async function logout(req) {
  const t = parseCookies(req)[COOKIE];
  if (t) await query("DELETE FROM admin_sessions WHERE token_hash = $1", [sha(t)]);
  return cookie(req, "", 0);
}

/** Zwraca zalogowanego admina albo rzuca 401. */
async function requireAdmin(req) {
  const t = parseCookies(req)[COOKIE];
  if (t) {
    const { rows: [u] } = await query(
      `SELECT u.id, u.login FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha(t)]);
    if (u) return u;
  }
  throw new HttpError(401, "Zaloguj się do panelu.");
}

module.exports = { hashPassword, verifyPassword, login, logout, requireAdmin, COOKIE };

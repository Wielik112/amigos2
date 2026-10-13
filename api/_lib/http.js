/** Wspólne helpery HTTP dla funkcji w /api (działają na Vercelu i w scripts/dev-server.js). */
const { ConfigError } = require("./config");

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const MAX_BODY = 64 * 1024;

/** Surowe body (Buffer) – potrzebne do weryfikacji podpisu webhooka Stripe. */
async function readRaw(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, "Za duże żądanie.");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** Body jako obiekt: JSON albo formularz (application/x-www-form-urlencoded). */
async function readBody(req) {
  let body = req.body;
  if (body === undefined || body === null) {
    const raw = (await readRaw(req)).toString("utf8");
    const ct = req.headers["content-type"] || "";
    if (!raw) return {};
    if (ct.includes("application/x-www-form-urlencoded")) {
      const out = {};
      for (const [k, v] of new URLSearchParams(raw)) {
        if (k in out) out[k] = [].concat(out[k], v); else out[k] = v;
      }
      return out;
    }
    try { return JSON.parse(raw); } catch (e) { throw new HttpError(400, "Niepoprawny JSON."); }
  }
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body === "string") { try { return JSON.parse(body); } catch (e) { return {}; } }
  return body || {};
}

function sendJson(res, status, payload, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(payload));
}

function redirect(res, location) {
  res.statusCode = 303;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Location", location);
  res.end();
}

const getIp = (req) => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() || "?";

function getUrl(req) {
  return new URL(req.url || "/", "http://localhost");
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Żądania zmieniające stan tylko z naszej domeny (ochrona CSRF obok SameSite=Strict). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  try { return !host || new URL(origin).host === host; } catch (e) { return false; }
}

/** Opakowanie handlera: błędy HttpError -> JSON, reszta -> 500 z logiem. */
function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { ok: false, error: e.message, ...(e.extra || {}) });
      if (e instanceof ConfigError) {
        console.error("[config]", e.message);
        return sendJson(res, 500, { ok: false, error: "Błąd konfiguracji serwera." });
      }
      console.error("[api]", e);
      return sendJson(res, 500, { ok: false, error: "Błąd serwera. Spróbuj ponownie za chwilę." });
    }
  };
}

module.exports = { HttpError, readRaw, readBody, sendJson, redirect, getIp, getUrl, parseCookies, sameOrigin, handler };

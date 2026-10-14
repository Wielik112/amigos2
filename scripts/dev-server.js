#!/usr/bin/env node
/**
 * Lokalny serwer: pliki statyczne + funkcje z /api, z tymi samymi regułami co vercel.json
 * (cleanUrls, redirects, rewrites, headers). `npm run dev` -> http://localhost:3000
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { PassThrough } = require("stream");
require("./env").load();
const { getConfig } = require("../api/_lib/config");

const ROOT = path.join(__dirname, "..");
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json" };
const BLOCKED = /^\/(api\/_|scripts|test|src|node_modules|\.)/;

// path-to-regexp w wersji minimalnej: :param, :param* oraz (.*)
function compile(source) {
  const names = [];
  const re = source.replace(/[.+?^${}|[\]\\]/g, "\\$&")
    .replace(/\(\\\.\*\)|\(\.\*\)/g, () => { names.push(String(names.length + 1)); return "(.*)"; })
    .replace(/:(\w+)\*/g, (_, n) => { names.push(n); return "(.*)"; })
    .replace(/:(\w+)/g, (_, n) => { names.push(n); return "([^/]+)"; });
  return { re: new RegExp("^" + re + "$"), names };
}
const rules = (list) => (list || []).map((r) => ({ ...r, ...compile(r.source) }));
const REDIRECTS = rules(VERCEL.redirects), REWRITES = rules(VERCEL.rewrites), HEADERS = rules(VERCEL.headers);

function apply(rule, pathname) {
  const m = rule.re.exec(pathname);
  if (!m) return null;
  let dest = rule.destination;
  rule.names.forEach((n, i) => { dest = dest.split(":" + n + "*").join(m[i + 1]).split(":" + n).join(m[i + 1]).split("$" + n).join(m[i + 1]); });
  return dest;
}

function staticFile(pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  const candidates = rel === "" ? ["index.html"] : [rel, rel + ".html", path.join(rel, "index.html")];
  for (const c of candidates) {
    const f = path.join(ROOT, c);
    if (!f.startsWith(ROOT)) return null;
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}

/**
 * Body tak jak w @vercel/node (addHelpers/restoreBody): leniwe `req.body` sparsowane wg Content-Type,
 * a surowe bajty dostępne tylko przez zdarzenia „data”/„end”. Dzięki temu testy łapią różnice względem Vercela.
 */
function vercelBody(req, body) {
  const pass = new PassThrough();
  const on = pass.on.bind(pass);
  const originalOn = req.on.bind(req);
  req.read = pass.read.bind(pass);
  req.on = req.addListener = (name, cb) => (name === "data" || name === "end" ? on(name, cb) : originalOn(name, cb));
  pass.write(body);
  pass.end();
  const type = String(req.headers["content-type"] || "").split(";")[0].trim();
  let parsed, done = false;
  Object.defineProperty(req, "body", {
    configurable: true, enumerable: true,
    get() {
      if (done) return parsed;
      done = true;
      if (req.headers["content-type"] === undefined) parsed = undefined;
      else if (type === "application/json") { const t = body.toString(); parsed = t ? JSON.parse(t) : {}; }
      else if (type === "application/x-www-form-urlencoded") parsed = Object.fromEntries(new URLSearchParams(body.toString()));
      else if (type === "text/plain") parsed = body.toString();
      else if (type === "application/octet-stream") parsed = body;
      return parsed;
    },
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let pathname = url.pathname;

    for (const h of HEADERS) if (h.re.test(pathname)) for (const { key, value } of h.headers) {
      if (key === "Strict-Transport-Security") continue;                        // nie na http://localhost
      res.setHeader(key, key === "Content-Security-Policy" ? value.replace("; upgrade-insecure-requests", "") : value);
    }
    for (const r of REDIRECTS) {
      const d = apply(r, pathname);
      if (d) { res.statusCode = r.permanent ? 308 : 307; res.setHeader("Location", d); return res.end(); }
    }
    if (pathname.endsWith(".html")) { res.statusCode = 308; res.setHeader("Location", pathname.slice(0, -5).replace(/\/index$/, "/")); return res.end(); }
    if (pathname.length > 1 && pathname.endsWith("/")) { res.statusCode = 308; res.setHeader("Location", pathname.slice(0, -1) + url.search); return res.end(); }

    let search = url.search;
    for (const r of REWRITES) {
      const d = apply(r, pathname);
      if (d) {
        const du = new URL(d, "http://localhost");
        for (const [k, v] of url.searchParams) if (!du.searchParams.has(k)) du.searchParams.set(k, v);
        pathname = du.pathname; search = du.search;
        break;
      }
    }

    if (BLOCKED.test(pathname)) return notFound(res);

    const api = /^\/api\/([\w-]+)$/.exec(pathname);
    if (api) {
      const file = path.join(ROOT, "api", api[1] + ".js");
      if (!fs.existsSync(file)) return notFound(res);
      const chunks = [];
      for await (const c of req) chunks.push(c);
      vercelBody(req, Buffer.concat(chunks));
      req.url = pathname + search;
      try {
        return await require(file)(req, res);
      } catch (e) {
        console.error(e); res.statusCode = 500; return res.end("Błąd serwera");
      }
    }

    const file = staticFile(pathname);
    if (!file) return notFound(res);
    res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  });
}

function notFound(res) {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  fs.createReadStream(path.join(ROOT, "404.html")).pipe(res);
}

module.exports = { createServer };

if (require.main === module) {
  let cfg;
  try { cfg = getConfig(); } catch (e) { console.error("\n✖ Nie uruchomiono serwera: " + e.message + "\n"); process.exit(1); }
  const port = Number(process.env.PORT) || 3000;
  if (!process.env.PUBLIC_BASE_URL) process.env.PUBLIC_BASE_URL = `http://localhost:${port}`;
  createServer().listen(port, () => console.log(`Amigos: http://localhost:${port}  (płatności: ${cfg.paymentsMode}, panel: /admin)`));
}

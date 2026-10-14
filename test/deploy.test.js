const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const h = require("./helpers");

let env;
before(async () => { env = await h.setup(); await h.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public"); });
after(async () => { await env.close(); });

const build = (extra = {}) => spawnSync(process.execPath, ["scripts/vercel-build.js"], {
  cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 30000,
  env: { ...process.env, ADMIN_LOGIN: "", ADMIN_PASSWORD: "", ...extra },
});

test("build na Vercelu przygotowuje pustą bazę i nie odtwarza usuniętych slotów", async () => {
  let out = build();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /ustaw ADMIN_PASSWORD/);
  let { rows: [a] } = await h.query("SELECT count(*)::int n FROM admin_users");
  assert.equal(a.n, 0, "bez ADMIN_PASSWORD nie powstaje konto z losowym hasłem");
  const { rows: [s] } = await h.query("SELECT count(*)::int n FROM services");
  assert.equal(s.n, 5);
  const { rows: [sl] } = await h.query("SELECT count(*)::int n FROM slots");
  assert.ok(sl.n > 0);

  await h.query("UPDATE services SET deposit_amount = 1234 WHERE slug = 'myjnia-reczna'");
  await h.query("DELETE FROM slots WHERE id IN (SELECT id FROM slots ORDER BY id LIMIT 10)");
  out = build({ ADMIN_LOGIN: "szef", ADMIN_PASSWORD: "haslo-z-vercela" });
  assert.equal(out.status, 0, out.stderr);
  const { rows: [sl2] } = await h.query("SELECT count(*)::int n FROM slots");
  assert.equal(sl2.n, sl.n - 10, "usunięte sloty nie wracają");
  const { rows: [d] } = await h.query("SELECT deposit_amount FROM services WHERE slug = 'myjnia-reczna'");
  assert.equal(d.deposit_amount, 1234, "ustawienia z panelu zostają");
  ({ rows: [a] } = await h.query("SELECT count(*)::int n FROM admin_users WHERE login = 'szef'"));
  assert.equal(a.n, 1);
  const login = await h.post(env.base, "/api/admin/login", { login: "szef", haslo: "haslo-z-vercela" });
  assert.equal(login.status, 200);
});

test("build zatrzymuje wdrożenie przy PAYMENTS_MODE=real bez kluczy, a bez bazy tylko ostrzega", () => {
  const real = build({ PAYMENTS_MODE: "real" });
  assert.equal(real.status, 1);
  assert.match(real.stderr, /STRIPE_SECRET_KEY/);
  const noDb = build({ DATABASE_URL: "" });
  assert.equal(noDb.status, 0);
  assert.match(noDb.stderr, /Brak DATABASE_URL/);
});

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");

let env, cookie;
before(async () => { env = await h.setup(); cookie = await h.adminCookie(env.base); });
after(async () => { await env.close(); });

const req = async (method, path, body, headers = {}) => {
  const res = await fetch(env.base + path, {
    method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

test("endpointy admina bez sesji zwracają 401", async () => {
  const id = "00000000-0000-4000-8000-000000000000";
  const calls = [
    ["GET", "/api/admin/me"], ["GET", "/api/admin/rezerwacje"], ["GET", `/api/admin/rezerwacje/${id}`],
    ["POST", `/api/admin/rezerwacje/${id}/anuluj`, {}], ["GET", "/api/admin/uslugi"], ["PATCH", "/api/admin/uslugi/1", { zaliczka: 1 }],
    ["GET", "/api/admin/sloty?usluga=1"], ["POST", "/api/admin/sloty/generuj", {}], ["POST", "/api/admin/sloty/blokada", {}],
    ["DELETE", "/api/admin/sloty/1"], ["GET", "/api/admin/powiadomienia"], ["POST", "/api/admin/powiadomienia/przeczytane", { wszystkie: true }],
    ["POST", "/api/admin/logout"], ["GET", "/api/admin/cokolwiek"],
  ];
  for (const [m, p, b] of calls) {
    const r = await req(m, p, b);
    assert.equal(r.status, 401, `${m} ${p}`);
    const bogus = await req(m, p, b, { cookie: "amigos_admin=zly-token" });
    assert.equal(bogus.status, 401, `${m} ${p} (zły token)`);
  }
});

test("logowanie: złe hasło 401, sesja w ciasteczku httpOnly, limit prób", async () => {
  const bad = await h.post(env.base, "/api/admin/login", { login: "admin", haslo: "zle" }, { "X-Forwarded-For": "10.9.9.9" });
  assert.equal(bad.status, 401);
  const ok = await h.post(env.base, "/api/admin/login", h.ADMIN, { "X-Forwarded-For": "10.9.9.8" });
  const sc = ok.headers.get("set-cookie");
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  let last;
  for (let i = 0; i < 11; i++) last = await h.post(env.base, "/api/admin/login", { login: "admin", haslo: "zle" }, { "X-Forwarded-For": "10.7.7.7" });
  assert.equal(last.status, 429);
  const { rows: [u] } = await h.query("SELECT password_hash FROM admin_users WHERE login = 'admin'");
  assert.match(u.password_hash, /^scrypt\$/);
});

test("anulowanie przez admina zwalnia termin i zapisuje kto/kiedy/dlaczego", async () => {
  const slot = await h.makeSlot("stacja-kontroli-pojazdow", { time: "21:00" });
  const r = await h.post(env.base, "/api/zapis", h.bookingBody("stacja-kontroli-pojazdow", slot));
  const paymentId = r.json.redirectUrl.split("/").pop();
  await h.post(env.base, "/api/platnosc/mock", { paymentId, wynik: "zaplac" });

  let free = await h.get(env.base, `/api/terminy?usluga=stacja-kontroli-pojazdow&dzien=${slot.date}`);
  assert.ok(!free.json.terminy.some((t) => t.godzina === slot.time));

  const c = await req("POST", `/api/admin/rezerwacje/${r.json.bookingId}/anuluj`, { powod: "Klient zadzwonił" }, { cookie });
  assert.equal(c.status, 200);
  assert.equal(c.json.rezerwacja.status, "cancelled");
  assert.equal(c.json.rezerwacja.anulowal, "admin");
  assert.equal(c.json.rezerwacja.powod, "Klient zadzwonił");
  assert.ok(c.json.rezerwacja.anulowano);
  assert.equal(c.json.zwrot.refunded, true, "mock: płatność oznaczona jako zwrócona");
  assert.equal(c.json.rezerwacja.platnosci[0].status, "refunded");

  free = await h.get(env.base, `/api/terminy?usluga=stacja-kontroli-pojazdow&dzien=${slot.date}`);
  assert.ok(free.json.terminy.some((t) => t.godzina === slot.time), "termin wrócił do puli");

  const again = await req("POST", `/api/admin/rezerwacje/${r.json.bookingId}/anuluj`, {}, { cookie });
  assert.equal(again.status, 409);

  // ktoś inny może teraz zarezerwować ten termin
  const r2 = await h.post(env.base, "/api/zapis", h.bookingBody("stacja-kontroli-pojazdow", slot, { imie: "Ewa" }));
  assert.equal(r2.status, 200);
});

test("grafik: nie da się usunąć slotu z rezerwacją, można go zablokować; generator i blokada dnia", async () => {
  const { rows: [svc] } = await h.query("SELECT id FROM services WHERE slug = 'myjnia-reczna'");
  const slot = await h.makeSlot("myjnia-reczna", { time: "21:00" });
  await h.query("UPDATE services SET deposit_required = false WHERE id = $1", [svc.id]);
  const r = await h.post(env.base, "/api/zapis", h.bookingBody("myjnia-reczna", slot));
  assert.equal(r.json.status, "confirmed");

  const del = await req("DELETE", `/api/admin/sloty/${slot.id}`, null, { cookie });
  assert.equal(del.status, 409);
  const blk = await req("POST", "/api/admin/sloty/blokada", { ids: [String(slot.id)], zablokuj: true }, { cookie });
  assert.equal(blk.json.zmieniono, 1);

  const empty = await h.makeSlot("myjnia-reczna", { time: "22:00" });
  assert.equal((await req("DELETE", `/api/admin/sloty/${empty.id}`, null, { cookie })).status, 200);

  const day = h.ymdPL(new Date(Date.now() + 10 * 86400000));
  const gen = await req("POST", "/api/admin/sloty/generuj", { usluga: svc.id, od: day, do: day, dni: [1, 2, 3, 4, 5, 6, 7],
    godzinaOd: "10:00", godzinaDo: "12:00", dlugosc: 45, pojemnosc: 2 }, { cookie });
  assert.equal(gen.json.utworzono, 2);   // 10:00 i 10:45 (11:30 + 45 min > 12:00)
  const day2 = await req("POST", "/api/admin/sloty/blokada", { usluga: svc.id, dzien: day, zablokuj: true }, { cookie });
  assert.equal(day2.json.zmieniono, 2);
  const list = await req("GET", `/api/admin/sloty?usluga=${svc.id}&od=${day}&dni=1`, null, { cookie });
  assert.ok(list.json.sloty.every((s) => s.zablokowany));
  const bad = await req("POST", "/api/admin/sloty/generuj", { usluga: svc.id, od: day, do: day, dni: [], godzinaOd: "10:00", godzinaDo: "12:00", dlugosc: 45 }, { cookie });
  assert.equal(bad.status, 422);
  await h.query("UPDATE services SET deposit_required = true WHERE id = $1", [svc.id]);
});

test("ustawienia usług: zmiana zaliczki działa dla nowych rezerwacji", async () => {
  const { rows: [svc] } = await h.query("SELECT id FROM services WHERE slug = 'geometria-kol-3d'");
  const up = await req("PATCH", `/api/admin/uslugi/${svc.id}`, { zaliczka: 7500, zaliczkaWymagana: true, dlugoscSlotu: 60, aktywna: true }, { cookie });
  assert.equal(up.status, 200);
  assert.equal(up.json.usluga.zaliczka, 7500);
  const slot = await h.makeSlot("geometria-kol-3d", { time: "21:00" });
  const r = await h.post(env.base, "/api/zapis", h.bookingBody("geometria-kol-3d", slot));
  const { rows: [p] } = await h.query("SELECT amount FROM payments WHERE booking_id = $1", [r.json.bookingId]);
  assert.equal(p.amount, 7500);
  const bad = await req("PATCH", `/api/admin/uslugi/${svc.id}`, { dlugoscSlotu: 3 }, { cookie });
  assert.equal(bad.status, 422);
  const off = await req("PATCH", `/api/admin/uslugi/${svc.id}`, { aktywna: false }, { cookie });
  assert.equal(off.json.usluga.aktywna, false);
  const blocked = await h.post(env.base, "/api/zapis", h.bookingBody("geometria-kol-3d", await h.makeSlot("geometria-kol-3d", { time: "22:00" })));
  assert.equal(blocked.status, 422);
});

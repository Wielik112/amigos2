const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const av = require("../api/_lib/availability");

let env, cookie;
before(async () => { env = await h.setup(); cookie = await h.adminCookie(env.base); });
after(async () => { await env.close(); });

const req = async (method, path, body, headers = { cookie }) => {
  const res = await fetch(env.base + path, {
    method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const svcId = async (slug) => (await h.query("SELECT id FROM services WHERE slug = $1", [slug])).rows[0].id;
const free = async (slug, date, extra = "") => (await h.get(env.base, `/api/terminy?usluga=${slug}&dzien=${date}${extra}`)).json.terminy.map((t) => t.godzina);

test("endpointy admina bez sesji zwracają 401", async () => {
  const id = "00000000-0000-4000-8000-000000000000";
  const calls = [
    ["GET", "/api/admin/me"], ["GET", "/api/admin/rezerwacje"], ["POST", "/api/admin/rezerwacje", {}], ["GET", `/api/admin/rezerwacje/${id}`],
    ["POST", `/api/admin/rezerwacje/${id}/anuluj`, {}], ["GET", "/api/admin/wolne?usluga=1&dzien=2030-01-01"], ["GET", "/api/admin/kalendarz"],
    ["GET", "/api/admin/uslugi"], ["PATCH", "/api/admin/uslugi/1", { zaliczka: 1 }], ["POST", "/api/admin/uslugi/1/domyslne-czasy"],
    ["GET", "/api/admin/grafik/1"], ["PUT", "/api/admin/grafik/1/godziny", { godziny: [] }],
    ["POST", "/api/admin/wyjatki", {}], ["DELETE", "/api/admin/wyjatki/1"], ["POST", "/api/admin/blokady", {}], ["DELETE", "/api/admin/blokady/1"],
    ["GET", "/api/admin/stanowiska"], ["POST", "/api/admin/stanowiska", {}], ["PATCH", "/api/admin/stanowiska/1", {}], ["DELETE", "/api/admin/stanowiska/1"],
    ["GET", "/api/admin/powiadomienia"], ["POST", "/api/admin/powiadomienia/przeczytane", { wszystkie: true }],
    ["POST", "/api/admin/logout"], ["GET", "/api/admin/cokolwiek"],
  ];
  for (const [m, p, b] of calls) {
    assert.equal((await req(m, p, b, {})).status, 401, `${m} ${p}`);
    assert.equal((await req(m, p, b, { cookie: "amigos_admin=zly-token" })).status, 401, `${m} ${p} (zły token)`);
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
  const slot = h.pick({ days: 2, time: "10:00" });
  const r = await h.post(env.base, "/api/zapis", h.bookingBody("geometria-kol-3d", slot));
  await h.post(env.base, "/api/platnosc/mock", { paymentId: r.json.redirectUrl.split("/").pop(), wynik: "zaplac" });
  assert.ok(!(await free("geometria-kol-3d", slot.date)).includes(slot.time));

  const c = await req("POST", `/api/admin/rezerwacje/${r.json.bookingId}/anuluj`, { powod: "Klient zadzwonił" });
  assert.equal(c.status, 200);
  assert.equal(c.json.rezerwacja.status, "cancelled");
  assert.equal(c.json.rezerwacja.anulowal, "admin");
  assert.equal(c.json.rezerwacja.powod, "Klient zadzwonił");
  assert.ok(c.json.rezerwacja.anulowano);
  assert.equal(c.json.zwrot.refunded, true, "mock: płatność oznaczona jako zwrócona");
  assert.equal(c.json.rezerwacja.platnosci[0].status, "refunded");
  assert.ok((await free("geometria-kol-3d", slot.date)).includes(slot.time), "termin wrócił do puli");
  assert.equal((await req("POST", `/api/admin/rezerwacje/${r.json.bookingId}/anuluj`, {})).status, 409);
  assert.equal((await h.post(env.base, "/api/zapis", h.bookingBody("geometria-kol-3d", slot, { imie: "Ewa" }))).status, 200);
});

test("rezerwacja wpisana w panelu (telefon) od razu blokuje termin online; kolizja i poza grafikiem", async () => {
  const geo = await svcId("geometria-kol-3d");
  const day = h.pick({ days: 3 });
  const add = (extra) => req("POST", "/api/admin/rezerwacje", { usluga: geo, data: day.date, godzina: "11:00", czas: 60, imie: "Pan Telefon", telefon: "600 700 800", ...extra });

  const wolne = await req("GET", `/api/admin/wolne?usluga=${geo}&dzien=${day.date}&czas=60`);
  assert.ok(wolne.json.terminy.some((t) => t.godzina === "11:00" && t.do === "12:00"));
  const a = await add();
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.rezerwacja.status, "confirmed");
  assert.equal(a.json.rezerwacja.zrodlo, "telefon");
  assert.equal(a.json.rezerwacja.godzinaDo, "12:00");
  const online = await free("geometria-kol-3d", day.date);
  assert.ok(!online.includes("11:00") && !online.includes("11:30"), "zajęte online");

  const clash = await add({ godzina: "11:30", czas: 30, telefon: "600 700 801" });
  assert.equal(clash.status, 409);
  const late = await add({ godzina: "21:15", czas: 30, telefon: "600 700 802" });
  assert.equal(late.status, 409, "poza godzinami bez zaznaczenia „poza grafikiem”");
  const late2 = await add({ godzina: "21:15", czas: 30, telefon: "600 700 802", pozaGrafikiem: true });
  assert.equal(late2.status, 200);
  const late3 = await add({ godzina: "21:30", czas: 30, telefon: "600 700 803", pozaGrafikiem: true });
  assert.equal(late3.status, 409, "poza grafikiem też nie nałoży się na inną wizytę (z zapasem)");
  assert.equal((await add({ telefon: "123" })).status, 422);

  const cal = await req("GET", `/api/admin/kalendarz?dzien=${day.date}`);
  const evs = cal.json.rezerwacje.filter((b) => b.usluga === geo);
  assert.deepEqual(evs.map((b) => b.godzina), ["11:00", "21:15"]);
  assert.ok(cal.json.do >= "22:00", "siatka kalendarza obejmuje wizytę po godzinach");
});

test("grafik: zapis godzin z przerwą, wyjątek z ostrzeżeniem o kolizji, blokada czasu", async () => {
  const myj = await svcId("myjnia-reczna");
  const day = h.pick({ days: 4 });
  const dow = av.isoDow(day.date);
  const g0 = await req("GET", `/api/admin/grafik/${myj}`);
  assert.ok(g0.json.godziny.length > 0);
  assert.ok(g0.json.swieta.length > 0, "lista świąt");

  const godziny = g0.json.godziny.filter((x) => x.dzien !== dow).concat([{ dzien: dow, od: "10:00", do: "12:00" }, { dzien: dow, od: "12:30", do: "15:00" }]);
  assert.equal((await req("PUT", `/api/admin/grafik/${myj}/godziny`, { godziny })).status, 200);
  const t = await free("myjnia-reczna", day.date, "&pakiet=Mycie%20r%C4%99czne%20nadwozia&pojazd=Osobowy");
  assert.equal(t[0], "10:00");
  assert.ok(!t.includes("11:30"), "11:30 + 45 min wchodzi w przerwę");
  assert.ok(t.includes("12:30"));
  const overlap = await req("PUT", `/api/admin/grafik/${myj}/godziny`, { godziny: [{ dzien: 1, od: "08:00", do: "12:00" }, { dzien: 1, od: "11:00", do: "14:00" }] });
  assert.equal(overlap.status, 422);

  await h.post(env.base, "/api/zapis", h.bookingBody("myjnia-reczna", { date: day.date, time: "10:00" }));
  const exc = await req("POST", "/api/admin/wyjatki", { usluga: myj, dzien: day.date, zamkniete: true, notatka: "Awaria" });
  assert.equal(exc.json.kolizje, 1, "ostrzeżenie: tego dnia jest już wizyta");
  assert.equal((await free("myjnia-reczna", day.date)).length, 0);
  const g1 = await req("GET", `/api/admin/grafik/${myj}`);
  const ex = g1.json.wyjatki.find((x) => x.dzien === day.date);
  assert.equal(ex.notatka, "Awaria");
  await req("DELETE", `/api/admin/wyjatki/${ex.id}`);
  assert.ok((await free("myjnia-reczna", day.date)).length > 0);

  const blk = await req("POST", "/api/admin/blokady", { usluga: myj, dzien: day.date, od: "12:30", do: "15:00", powod: "Szkolenie" });
  assert.equal(blk.status, 200);
  assert.ok(!(await free("myjnia-reczna", day.date)).some((x) => x >= "12:30"));
  const cal = await req("GET", `/api/admin/kalendarz?dzien=${day.date}`);
  assert.ok(cal.json.blokady.some((b) => b.powod === "Szkolenie"));
});

test("zasady usługi: zapas, krok, wyprzedzenie, czasy trwania, stanowiska", async () => {
  const geo = await svcId("geometria-kol-3d");
  const day = h.pick({ days: 5 });
  let up = await req("PATCH", `/api/admin/uslugi/${geo}`, { krok: 15, zapas: 0, czasBazowy: 0,
    czasy: { zakres: { "Sam pomiar": 25 }, pojazd: { "Osobowy": 0 }, nieistnieje: { x: 5 } } });
  assert.equal(up.status, 200);
  assert.deepEqual(up.json.usluga.czasy, { zakres: { "Sam pomiar": 25 }, pojazd: { "Osobowy": 0 } });
  const r = await h.get(env.base, `/api/terminy?usluga=geometria-kol-3d&dzien=${day.date}&zakres=Sam%20pomiar&pojazd=Osobowy`);
  assert.equal(r.json.czas, 25);
  assert.equal(av.toMin(r.json.terminy[1].godzina) - av.toMin(r.json.terminy[0].godzina), 15, "krok 15 min");

  assert.equal((await req("PATCH", `/api/admin/uslugi/${geo}`, { krok: 7 })).status, 422);
  assert.equal((await req("PATCH", `/api/admin/uslugi/${geo}`, { stanowiska: [] })).status, 422, "usługa bez stanowiska");
  up = await req("POST", `/api/admin/uslugi/${geo}/domyslne-czasy`);
  assert.equal(up.json.usluga.czasy.zakres["Geometria całego auta"], 60);

  const off = await req("PATCH", `/api/admin/uslugi/${geo}`, { aktywna: false });
  assert.equal(off.json.usluga.aktywna, false);
  assert.equal((await h.post(env.base, "/api/zapis", h.bookingBody("geometria-kol-3d", h.pick({ days: 5, time: "12:00" })))).status, 422);
  await req("PATCH", `/api/admin/uslugi/${geo}`, { aktywna: true, zapas: 10, krok: 30 });
});

test("stanowiska: dodanie zwiększa liczbę równoczesnych wizyt, wyłączenie ją zmniejsza", async () => {
  const geo = await svcId("geometria-kol-3d");
  const day = h.pick({ days: 6, time: "10:00" });
  assert.equal((await h.post(env.base, "/api/zapis", h.bookingBody("geometria-kol-3d", day))).status, 200);
  assert.equal((await h.post(env.base, "/api/zapis", h.bookingBody("geometria-kol-3d", day))).status, 409);

  const add = await req("POST", "/api/admin/stanowiska", { nazwa: "Geometria – stanowisko 2", uslugi: [geo] });
  const st = add.json.stanowiska.find((s) => s.nazwa === "Geometria – stanowisko 2");
  assert.deepEqual(st.uslugi, [geo]);
  assert.equal((await h.post(env.base, "/api/zapis", h.bookingBody("geometria-kol-3d", day))).status, 200, "drugie stanowisko przyjmuje wizytę");

  await req("PATCH", `/api/admin/stanowiska/${st.id}`, { aktywne: false });
  assert.ok(!(await free("geometria-kol-3d", day.date)).includes("10:00"));
  const del = await req("DELETE", `/api/admin/stanowiska/${st.id}`);
  assert.equal(del.status, 409, "stanowisko z historią można tylko wyłączyć");
  const tmp = await req("POST", "/api/admin/stanowiska", { nazwa: "Do usunięcia" });
  const tmpId = tmp.json.stanowiska.find((s) => s.nazwa === "Do usunięcia").id;
  assert.equal((await req("DELETE", `/api/admin/stanowiska/${tmpId}`)).status, 200);
});

test("lista rezerwacji: wyszukiwanie po telefonie i numerze rejestracyjnym", async () => {
  const phone = h.randomPhone();
  const r = await h.post(env.base, "/api/zapis", h.bookingBody("stacja-kontroli-pojazdow", h.pick({ days: 7 }), { telefon: phone, rejestracja: "FNW 4242X" }));
  assert.equal(r.status, 200);
  const byPhone = await req("GET", `/api/admin/rezerwacje?szukaj=${phone.slice(-6)}`);
  assert.ok(byPhone.json.rezerwacje.some((x) => x.id === r.json.bookingId));
  const byPlate = await req("GET", "/api/admin/rezerwacje?szukaj=fnw4242x");
  assert.ok(byPlate.json.rezerwacje.some((x) => x.id === r.json.bookingId));
  assert.equal(byPlate.json.rezerwacje[0].stanowisko.startsWith("Stacja kontroli"), true);
});

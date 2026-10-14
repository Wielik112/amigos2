const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { createBooking, listAvailable, expireHolds, SLOT_TAKEN } = require("../api/_lib/bookings");
const { validateBooking } = require("../api/_lib/validate");
const av = require("../api/_lib/availability");

let env;
before(async () => { env = await h.setup(); });
after(async () => { await env.close(); });

const data = (slug, slot, extra) => {
  const v = validateBooking(h.bookingBody(slug, slot, extra));
  assert.deepEqual(v.errors, []);
  return v.data;
};
const times = async (slug, date, details) => (await listAvailable(slug, date, details)).starts.map((s) => s.time);
const svcId = async (slug) => (await h.query("SELECT id FROM services WHERE slug = $1", [slug])).rows[0].id;

test("równoczesna rezerwacja tego samego terminu (1 stanowisko): wygrywa dokładnie jedna", async () => {
  const slot = h.pick({ days: 3, time: "10:00" });
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => createBooking(data("geometria-kol-3d", slot))));
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 11);
  for (const f of failed) { assert.equal(f.reason.status, 409); assert.equal(f.reason.message, SLOT_TAKEN); }
});

test("równoczesne żądania HTTP: jedno przechodzi, drugie dostaje czytelny błąd", async () => {
  const slot = h.pick({ days: 3, time: "15:00" });
  const [a, b] = await Promise.all([1, 2].map(() => h.post(env.base, "/api/zapis", h.bookingBody("geometria-kol-3d", slot))));
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.json.error, "Ten termin właśnie został zajęty – wybierz inną godzinę.");
  assert.deepEqual(loser.json.fields, ["godzina"]);
});

test("dwa stanowiska: dwie równoczesne rezerwacje wchodzą, trzecia nie", async () => {
  const slot = h.pick({ days: 3, time: "11:00" });
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => createBooking(data("stacja-kontroli-pojazdow", slot))));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  const { rows } = await h.query(
    "SELECT count(DISTINCT resource_id)::int AS n FROM bookings WHERE status IN ('pending_payment','confirmed') AND start_at = $1",
    [av.localToUtc(slot.date, av.toMin(slot.time))]);
  assert.equal(rows[0].n, 2, "każda na innym stanowisku");
});

test("constraint w bazie: nachodzące wizyty na tym samym stanowisku są odrzucane nawet z pominięciem kodu", async () => {
  const { rows: [r] } = await h.query("SELECT resource_id FROM service_resources WHERE service_id = $1 LIMIT 1", [await svcId("myjnia-reczna")]);
  const ins = (s, e) => h.query(
    `INSERT INTO bookings (service_id, resource_id, start_at, end_at, block_until, status, customer_name, phone, consent_at)
     SELECT id, $1, $2, $3, $3, 'confirmed', 'X', '+48600100200', now() FROM services WHERE slug = 'myjnia-reczna'`, [r.resource_id, s, e]);
  await ins("2031-01-07T08:00:00Z", "2031-01-07T10:00:00Z");
  await assert.rejects(ins("2031-01-07T09:00:00Z", "2031-01-07T09:30:00Z"), (e) => e.code === "23P01");
  await ins("2031-01-07T10:00:00Z", "2031-01-07T10:30:00Z");   // styka się, ale nie nachodzi – OK
});

test("czas wizyty zależy od wyboru: długa wizyta blokuje kolejne starty (z zapasem)", async () => {
  const slot = h.pick({ days: 4, time: "08:00" });
  // „Pakiet komplet” = 180 min + 10 min zapasu, na obu stanowiskach myjni
  const long = { pakiet: "Pakiet komplet", pojazd: "Osobowy" };
  await createBooking(data("myjnia-reczna", slot, long));
  await createBooking(data("myjnia-reczna", slot, long));
  const free = await times("myjnia-reczna", slot.date, { pakiet: "Mycie ręczne nadwozia", pojazd: "Osobowy" });
  for (const t of ["08:00", "09:00", "10:30", "11:00"]) assert.ok(!free.includes(t), `${t} zajęte`);
  assert.ok(free.includes("11:30"), "11:30 wolne (08:00 + 180 min + 10 min zapasu = 11:10)");
  // 45-minutowe mycie o 10:00 też już się nie zmieści – oba stanowiska zajęte do 11:10
  const busy = await h.post(env.base, "/api/zapis", h.bookingBody("myjnia-reczna", { date: slot.date, time: "10:00" }));
  assert.equal(busy.status, 409);
});

test("przerwa w grafiku: wizyta, która by na nią nachodziła, nie jest proponowana", async () => {
  const slot = h.pick({ days: 5 });
  // 210 min (komplet + bus); przerwa 13:00–13:30
  const free = await times("myjnia-reczna", slot.date, { pakiet: "Pakiet komplet", pojazd: "Bus / dostawczy" });
  assert.ok(free.includes("09:30"), "09:30–13:00 mieści się przed przerwą");
  assert.ok(!free.includes("10:00"), "10:00–13:30 wchodzi w przerwę");
  assert.ok(free.includes("13:30"));
  assert.ok(!free.includes("17:00"), "17:00–20:30 po zamknięciu");
});

test("wspólne stanowisko blokuje inną usługę", async () => {
  const geo = await svcId("geometria-kol-3d"), myj = await svcId("myjnia-reczna");
  const { rows: [g] } = await h.query("SELECT resource_id FROM service_resources WHERE service_id = $1", [geo]);
  const { rows: own } = await h.query("SELECT resource_id FROM service_resources WHERE service_id = $1", [myj]);
  await h.query("DELETE FROM service_resources WHERE service_id = $1", [myj]);
  await h.query("INSERT INTO service_resources VALUES ($1, $2)", [myj, g.resource_id]);
  try {
    const slot = h.pick({ days: 6, time: "12:00" });
    assert.ok((await times("myjnia-reczna", slot.date)).includes("12:00"));
    await createBooking(data("geometria-kol-3d", slot));
    assert.ok(!(await times("myjnia-reczna", slot.date)).includes("12:00"), "stanowisko zajęte przez geometrię");
  } finally {
    await h.query("DELETE FROM service_resources WHERE service_id = $1", [myj]);
    for (const r of own) await h.query("INSERT INTO service_resources VALUES ($1, $2)", [myj, r.resource_id]);
  }
});

test("święta, dni wolne i zmienione godziny", async () => {
  const geo = await svcId("geometria-kol-3d");
  const hol = "2026-12-25";
  const y = new Date().getFullYear();
  if (av.addDays(av.localYmd(new Date()), 60) >= hol && av.localYmd(new Date()) <= hol) {
    const r = await listAvailable("geometria-kol-3d", hol, {});
    assert.equal(r.closed, "Boże Narodzenie");
    assert.equal(r.starts.length, 0);
  }
  assert.equal(av.holidayName(`${y}-11-11`), "Święto Niepodległości");
  assert.equal(av.holidayName("2027-03-28"), "Wielkanoc");
  assert.equal(av.holidayName("2027-05-27"), "Boże Ciało");
  assert.equal(av.holidayName("2026-12-24"), "Wigilia");

  const day = h.pick({ days: 7 });
  await h.query("INSERT INTO schedule_exceptions (service_id, day, closed, note) VALUES ($1, $2, true, 'Inwentaryzacja')", [geo, day.date]);
  let r = await listAvailable("geometria-kol-3d", day.date, {});
  assert.equal(r.closed, "Inwentaryzacja");
  await h.query("UPDATE schedule_exceptions SET closed = false, start_time = '10:00', end_time = '12:00' WHERE day = $1", [day.date]);
  r = await listAvailable("geometria-kol-3d", day.date, { zakres: "Sam pomiar", pojazd: "Osobowy" });
  assert.equal(r.starts[0].time, "10:00");
  assert.equal(r.starts[r.starts.length - 1].end <= "12:00", true);
  // wyjątek „wszystkie usługi”
  const d2 = h.pick({ days: 8 });
  await h.query("INSERT INTO schedule_exceptions (service_id, day, closed) VALUES (NULL, $1, true)", [d2.date]);
  assert.equal((await listAvailable("myjnia-reczna", d2.date, {})).starts.length, 0);
  assert.equal((await listAvailable("stacja-kontroli-pojazdow", d2.date, {})).starts.length, 0);
});

test("minimalne wyprzedzenie i horyzont rezerwacji", async () => {
  const svc = await av.loadService({ query: h.query }, "slug = $1", "geometria-kol-3d");   // wyprzedzenie 120 min
  const day = h.pick({ days: 2 });
  const now = av.localToUtc(day.date, av.toMin("08:10"));
  const r = await av.freeStarts({ query: h.query }, svc, day.date, { duration: 30, now });
  assert.equal(r.starts[0].time, "10:30", "pierwszy start ≥ 08:10 + 2 h");
  const far = await listAvailable("geometria-kol-3d", av.addDays(av.localYmd(new Date()), 61), {});
  assert.equal(far.starts.length, 0);
});

test("blokada czasu: na usługę zamyka termin, na stanowisko zostawia drugie stanowisko", async () => {
  const day = h.pick({ days: 9 });
  const skp = await svcId("stacja-kontroli-pojazdow");
  const { rows: [line1] } = await h.query("SELECT resource_id FROM service_resources WHERE service_id = $1 ORDER BY resource_id LIMIT 1", [skp]);
  const s = av.localToUtc(day.date, av.toMin("09:00")), e = av.localToUtc(day.date, av.toMin("10:00"));
  await h.query("INSERT INTO time_blocks (resource_id, start_at, end_at) VALUES ($1, $2, $3)", [line1.resource_id, s, e]);
  let r = await listAvailable("stacja-kontroli-pojazdow", day.date, { pojazd: "Osobowy" });
  assert.equal(r.starts.find((x) => x.time === "09:00").resources.length, 1);
  await h.query("INSERT INTO time_blocks (service_id, start_at, end_at) VALUES ($1, $2, $3)", [skp, s, e]);
  r = await listAvailable("stacja-kontroli-pojazdow", day.date, { pojazd: "Osobowy" });
  assert.ok(!r.starts.some((x) => x.time === "09:00" || x.time === "09:30"));
});

test("wygasły hold zwalnia termin (przy odczycie i przy rezerwacji)", async () => {
  const slot = h.pick({ days: 10, time: "10:00" });
  const first = await createBooking(data("geometria-kol-3d", slot));
  assert.equal(first.status, "pending_payment");
  assert.ok(!(await times("geometria-kol-3d", slot.date, {})).includes(slot.time), "wstrzymany termin nie jest wolny");

  await h.query("UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1", [first.booking.id]);
  assert.ok((await times("geometria-kol-3d", slot.date, {})).includes(slot.time), "po wygaśnięciu holdu termin jest wolny");

  const second = await createBooking(data("geometria-kol-3d", slot, { imie: "Ewa" }));
  assert.equal(second.status, "pending_payment");
  const { rows: [b] } = await h.query("SELECT b.status, p.status AS pay FROM bookings b JOIN payments p ON p.id = b.payment_id WHERE b.id = $1", [first.booking.id]);
  assert.deepEqual(b, { status: "expired", pay: "expired" });
});

test("zadanie cykliczne oznacza wygasłe holdy", async () => {
  const slot = h.pick({ days: 10, time: "14:00" });
  const r = await createBooking(data("geometria-kol-3d", slot));
  await h.query("UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1", [r.booking.id]);
  assert.ok(await expireHolds(null) >= 1);
  const { rows: [b] } = await h.query("SELECT status FROM bookings WHERE id = $1", [r.booking.id]);
  assert.equal(b.status, "expired");
});

test("ta sama osoba nie zarezerwuje drugi raz tej samej usługi tego samego dnia", async () => {
  const phone = h.randomPhone();
  const a = await h.post(env.base, "/api/zapis", h.bookingBody("rejestracja-pojazdow", h.pick({ days: 11, time: "09:00" }), { telefon: phone }));
  assert.equal(a.status, 200);
  const b = await h.post(env.base, "/api/zapis", h.bookingBody("rejestracja-pojazdow", h.pick({ days: 11, time: "11:00" }), { telefon: "+48 " + phone }));
  assert.equal(b.status, 409);
  assert.equal(b.json.code, "duplicate");
  assert.match(b.json.error, /09:00/);
});

test("usługa bez zaliczki: od razu confirmed + powiadomienie", async () => {
  await h.query("UPDATE services SET deposit_required = false WHERE slug = 'geometria-kol-3d'");
  const r = await createBooking(data("geometria-kol-3d", h.pick({ days: 12, time: "10:00" })));
  assert.equal(r.status, "confirmed");
  assert.equal(r.redirectUrl, null);
  const { rows } = await h.query("SELECT type FROM notifications WHERE booking_id = $1", [r.booking.id]);
  assert.deepEqual(rows.map((x) => x.type), ["booking_confirmed"]);
  await h.query("UPDATE services SET deposit_required = true WHERE slug = 'geometria-kol-3d'");
});

test("kwota zaliczki pochodzi z bazy, nie z żądania", async () => {
  const r = await h.post(env.base, "/api/zapis", { ...h.bookingBody("myjnia-reczna", h.pick({ days: 12, time: "15:00" })), amount: 1, depositAmount: 1, kwota: 1 });
  assert.equal(r.status, 200);
  const { rows: [p] } = await h.query("SELECT amount, currency FROM payments WHERE booking_id = $1", [r.json.bookingId]);
  assert.deepEqual(p, { amount: 5000, currency: "PLN" });
});

test("walidacja: telefon, opcje spoza listy, zgoda; termin spoza grafiku", async () => {
  const slot = h.pick({ days: 12, time: "16:00" });
  const r = await h.post(env.base, "/api/zapis", h.bookingBody("myjnia-reczna", slot, { telefon: "123", pakiet: "Coś innego", zgoda: false }));
  assert.equal(r.status, 422);
  assert.deepEqual(r.json.fields.sort(), ["pakiet", "telefon", "zgoda"]);
  assert.equal(validateBooking(h.bookingBody("myjnia-reczna", slot, { telefon: "+48 600-100-200" })).data.phone, "+48600100200");
  const off = await h.post(env.base, "/api/zapis", h.bookingBody("myjnia-reczna", { date: slot.date, time: "21:00" }));
  assert.equal(off.status, 409);
  const odd = await h.post(env.base, "/api/zapis", h.bookingBody("myjnia-reczna", { date: slot.date, time: "10:10" }));
  assert.equal(odd.status, 409, "tylko godziny z siatki startów");
});

test("ubezpieczenia: prośba o kontakt bez terminu", async () => {
  const r = await h.post(env.base, "/api/zapis", { usluga: "ubezpieczenia", ubezpieczenie: "Na życie", polisa: "Nowa polisa", pora: "Rano",
    imie: "Anna", telefon: "600100300", zgoda: "tak" });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "confirmed");
});

test("strefa czasowa: 08:00 w Polsce przed i po zmianie czasu", () => {
  assert.equal(av.localToUtc("2026-10-24", 480).toISOString(), "2026-10-24T06:00:00.000Z");
  assert.equal(av.localToUtc("2026-10-26", 480).toISOString(), "2026-10-26T07:00:00.000Z");
  assert.equal(av.localToUtc("2027-03-29", 480).toISOString(), "2027-03-29T06:00:00.000Z");
  assert.equal(av.localHm(new Date("2026-10-25T23:30:00Z")), "00:30");
});

test("API /api/terminy: czas wizyty z wybranych opcji i godzina zakończenia", async () => {
  const day = h.pick({ days: 13 });
  const q = new URLSearchParams({ usluga: "geometria-kol-3d", dzien: day.date, pojazd: "Bus", zakres: "Geometria całego auta" });
  q.append("dodatkowo[]", "Kalibracja kąta skrętu");
  q.append("dodatkowo[]", "Coś spoza listy");
  const r = await h.get(env.base, "/api/terminy?" + q);
  assert.equal(r.json.czas, 15 + 60 + 15);
  const first = r.json.terminy[0];
  assert.equal(av.toMin(first.do) - av.toMin(first.godzina), 90);
  assert.equal(first.godzina, new Date(day.date + "T12:00:00Z").getUTCDay() === 2 ? "09:00" : "08:00", "otwarcie wg grafiku (wt od 9:00)");
});

test("API /api/terminy?dni=1: kalendarz wolnych dni w całym horyzoncie", async () => {
  const day = h.pick({ days: 14 });
  const before = (await h.get(env.base, "/api/terminy?usluga=geometria-kol-3d&dni=1&zakres=Sam%20pomiar&pojazd=Osobowy")).json;
  assert.equal(before.od, av.localYmd(new Date()));
  assert.equal(Object.keys(before.dni).length, 61, "dziś + 60 dni horyzontu");
  const n0 = before.dni[day.date].wolne;
  assert.ok(n0 > 0);
  const hol = Object.entries(before.dni).find(([d]) => av.holidayName(d));
  if (hol) assert.equal(hol[1].wolne, 0);
  const sunday = Object.keys(before.dni).find((d) => new Date(d + "T12:00:00Z").getUTCDay() === 0);
  assert.equal(before.dni[sunday].wolne, 0, "niedziela zamknięta");
  await createBooking(data("geometria-kol-3d", { date: day.date, time: before.dni[day.date].pierwsza }));
  const after = (await h.get(env.base, "/api/terminy?usluga=geometria-kol-3d&dni=1&zakres=Sam%20pomiar&pojazd=Osobowy")).json;
  assert.ok(after.dni[day.date].wolne < n0, "zajęta godzina znika z licznika dnia");
  assert.notEqual(after.dni[day.date].pierwsza, before.dni[day.date].pierwsza);
  const longer = (await h.get(env.base, "/api/terminy?usluga=geometria-kol-3d&dni=1&zakres=Geometria%20ca%C5%82ego%20auta&pojazd=Bus")).json;
  assert.ok(longer.dni[day.date].wolne < after.dni[day.date].wolne, "dłuższa wizyta = mniej możliwych startów");
});

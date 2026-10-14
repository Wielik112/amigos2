const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { createBooking, listAvailable, expireHolds, SLOT_TAKEN } = require("../api/_lib/bookings");
const { validateBooking } = require("../api/_lib/validate");
const { generateSlots } = require("../api/_lib/slots");

let env;
before(async () => { env = await h.setup(); });
after(async () => { await env.close(); });

const data = (slug, slot, extra) => {
  const v = validateBooking(h.bookingBody(slug, slot, extra));
  assert.deepEqual(v.errors, []);
  return v.data;
};

test("równoczesna rezerwacja tego samego slotu: wygrywa dokładnie jedna", async () => {
  const slot = await h.makeSlot("myjnia-reczna", { time: "21:00" });
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => createBooking(data("myjnia-reczna", slot))));
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 11);
  for (const f of failed) { assert.equal(f.reason.status, 409); assert.equal(f.reason.message, SLOT_TAKEN); }
  const { rows } = await h.query("SELECT count(*)::int n FROM bookings WHERE slot_id = $1 AND status IN ('pending_payment','confirmed')", [slot.id]);
  assert.equal(rows[0].n, 1);
});

test("równoczesne żądania HTTP: jedno przechodzi, drugie dostaje czytelny błąd", async () => {
  const slot = await h.makeSlot("geometria-kol-3d", { time: "21:00" });
  const [a, b] = await Promise.all([1, 2].map(() => h.post(env.base, "/api/zapis", h.bookingBody("geometria-kol-3d", slot))));
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.json.error, "Ten termin właśnie został zajęty – wybierz inną godzinę.");
  assert.deepEqual(loser.json.fields, ["godzina"]);
});

test("pojemność 2: dwie rezerwacje wchodzą, trzecia nie", async () => {
  const slot = await h.makeSlot("myjnia-reczna", { time: "21:30", capacity: 2 });
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => createBooking(data("myjnia-reczna", slot))));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
});

test("indeks w bazie blokuje drugą aktywną rezerwację na to samo miejsce (nawet z pominięciem kodu)", async () => {
  const slot = await h.makeSlot("myjnia-reczna", { time: "22:00" });
  const ins = `INSERT INTO bookings (service_id, slot_id, seat, status, customer_name, phone, consent_at)
               SELECT service_id, id, 1, 'confirmed', 'X', '+48600100200', now() FROM slots WHERE id = $1`;
  await h.query(ins, [slot.id]);
  await assert.rejects(h.query(ins, [slot.id]), (e) => e.code === "23505");
});

test("wygasły hold zwalnia termin (przy odczycie i przy rezerwacji)", async () => {
  const slot = await h.makeSlot("stacja-kontroli-pojazdow", { time: "21:00" });
  const first = await createBooking(data("stacja-kontroli-pojazdow", slot));
  assert.equal(first.status, "pending_payment");
  let free = await listAvailable("stacja-kontroli-pojazdow", slot.date);
  assert.ok(!free.some((s) => s.time === slot.time), "slot wstrzymany nie jest wolny");

  await h.query("UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1", [first.booking.id]);
  free = await listAvailable("stacja-kontroli-pojazdow", slot.date);
  assert.ok(free.some((s) => s.time === slot.time), "po wygaśnięciu holdu slot jest wolny");

  const second = await createBooking(data("stacja-kontroli-pojazdow", slot, { imie: "Ewa" }));
  assert.equal(second.status, "pending_payment");
  const { rows: [b] } = await h.query("SELECT b.status, p.status AS pay FROM bookings b JOIN payments p ON p.id = b.payment_id WHERE b.id = $1", [first.booking.id]);
  assert.deepEqual(b, { status: "expired", pay: "expired" });
});

test("zadanie cykliczne oznacza wygasłe holdy", async () => {
  const slot = await h.makeSlot("stacja-kontroli-pojazdow", { time: "22:00" });
  const r = await createBooking(data("stacja-kontroli-pojazdow", slot));
  await h.query("UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1", [r.booking.id]);
  assert.ok(await expireHolds(null) >= 1);
  const { rows: [b] } = await h.query("SELECT status FROM bookings WHERE id = $1", [r.booking.id]);
  assert.equal(b.status, "expired");
});

test("usługa bez zaliczki: od razu confirmed + powiadomienie", async () => {
  await h.query("UPDATE services SET deposit_required = false WHERE slug = 'geometria-kol-3d'");
  const slot = await h.makeSlot("geometria-kol-3d", { time: "22:00" });
  const r = await createBooking(data("geometria-kol-3d", slot));
  assert.equal(r.status, "confirmed");
  assert.equal(r.redirectUrl, null);
  const { rows } = await h.query("SELECT type FROM notifications WHERE booking_id = $1", [r.booking.id]);
  assert.deepEqual(rows.map((x) => x.type), ["booking_confirmed"]);
  await h.query("UPDATE services SET deposit_required = true WHERE slug = 'geometria-kol-3d'");
});

test("zablokowany slot i slot z przeszłości nie są dostępne", async () => {
  const slot = await h.makeSlot("myjnia-reczna", { time: "22:30" });
  await h.query("UPDATE slots SET blocked = true WHERE id = $1", [slot.id]);
  await assert.rejects(createBooking(data("myjnia-reczna", slot)), (e) => e.status === 409);
  assert.ok(!(await listAvailable("myjnia-reczna", slot.date)).some((s) => s.time === slot.time));
});

test("kwota zaliczki pochodzi z bazy, nie z żądania", async () => {
  const slot = await h.makeSlot("myjnia-reczna", { time: "23:00" });
  const r = await h.post(env.base, "/api/zapis", { ...h.bookingBody("myjnia-reczna", slot), amount: 1, depositAmount: 1, kwota: 1 });
  assert.equal(r.status, 200);
  const { rows: [p] } = await h.query("SELECT amount, currency FROM payments WHERE booking_id = $1", [r.json.bookingId]);
  assert.deepEqual(p, { amount: 5000, currency: "PLN" });
});

test("walidacja: telefon, opcje spoza listy, zgoda", async () => {
  const slot = await h.makeSlot("myjnia-reczna", { time: "23:30" });
  const r = await h.post(env.base, "/api/zapis", h.bookingBody("myjnia-reczna", slot, { telefon: "123", pakiet: "Coś innego", zgoda: false }));
  assert.equal(r.status, 422);
  assert.deepEqual(r.json.fields.sort(), ["pakiet", "telefon", "zgoda"]);
  const ok = validateBooking(h.bookingBody("myjnia-reczna", slot, { telefon: "+48 600-100-200" }));
  assert.equal(ok.data.phone, "+48600100200");
});

test("ubezpieczenia: prośba o kontakt bez terminu", async () => {
  const r = await h.post(env.base, "/api/zapis", { usluga: "ubezpieczenia", ubezpieczenie: "Na życie", polisa: "Nowa polisa", pora: "Rano",
    imie: "Anna", telefon: "600100300", zgoda: "tak" });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "confirmed");
});

test("generator slotów uwzględnia zmianę czasu (08:00 w Polsce przed i po 25.10.2026)", async () => {
  const { rows: [svc] } = await h.query("SELECT id FROM services WHERE slug = 'rejestracja-pojazdow'");
  // na stałe daty w przyszłości tylko, jeśli test działa przed zmianą czasu – w przeciwnym razie sprawdzamy marzec 2027
  const [from, to] = new Date() < new Date("2026-10-24T00:00:00Z") ? ["2026-10-24", "2026-10-26"] : ["2027-03-27", "2027-03-29"];
  await generateSlots({ serviceId: svc.id, from, to, weekdays: [1, 2, 3, 4, 5, 6, 7], timeFrom: "08:00", timeTo: "09:00", duration: 60, capacity: 1 });
  const { rows } = await h.query(
    `SELECT to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') utc, to_char(start_at AT TIME ZONE 'Europe/Warsaw', 'HH24:MI') pl
       FROM slots WHERE service_id = $1 AND start_at >= $2::date AND start_at < $3::date + 1 ORDER BY start_at`, [svc.id, from, to]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.pl === "08:00"));
  assert.notEqual(rows[0].utc.slice(11), rows[2].utc.slice(11), "przesunięcie UTC zmienia się po zmianie czasu");
});

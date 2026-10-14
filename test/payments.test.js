const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Stripe = require("stripe");
const h = require("./helpers");

let env;
before(async () => { env = await h.setup(); });
after(async () => { await env.close(); });

test("pełny flow mock: rezerwacja → płatność → confirmed → powiadomienie w panelu", async () => {
  const slot = await h.makeSlot("myjnia-reczna", { time: "21:00" });
  const r = await h.post(env.base, "/api/zapis", h.bookingBody("myjnia-reczna", slot));
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "pending_payment");
  const m = /\/platnosc\/mock\/([0-9a-f-]{36})$/.exec(r.json.redirectUrl);
  assert.ok(m, "redirectUrl prowadzi do strony symulacji");
  const paymentId = m[1];

  // strona symulacji się otwiera i pokazuje dane z bazy
  const page = await fetch(env.base + `/platnosc/mock/${paymentId}`);
  assert.equal(page.status, 200);
  const info = await h.get(env.base, `/api/platnosc/info?id=${paymentId}`);
  assert.equal(info.json.platnosc.kwota, 5000);
  assert.equal(info.json.platnosc.status, "pending");

  // przed płatnością: brak powiadomień
  const cookie = await h.adminCookie(env.base);
  let n = await h.get(env.base, "/api/admin/powiadomienia", { cookie });
  assert.equal(n.json.nieprzeczytane, 0);

  const pay = await h.post(env.base, "/api/platnosc/mock", { paymentId, wynik: "zaplac" });
  assert.equal(pay.status, 200);
  assert.equal(pay.json.status, "confirmed");
  assert.equal(pay.json.next, `/potwierdzenie?id=${r.json.bookingId}`);

  const st = await h.get(env.base, `/api/platnosc/status?id=${r.json.bookingId}`);
  assert.equal(st.json.rezerwacja.status, "confirmed");
  assert.equal(st.json.rezerwacja.platnosc.status, "succeeded");

  n = await h.get(env.base, "/api/admin/powiadomienia", { cookie });
  assert.equal(n.json.nieprzeczytane, 1);
  assert.equal(n.json.lista[0].typ, "booking_confirmed");
  assert.equal(n.json.lista[0].rezerwacja, r.json.bookingId);

  const list = await h.get(env.base, "/api/admin/rezerwacje?usluga=myjnia-reczna", { cookie });
  const row = list.json.rezerwacje.find((x) => x.id === r.json.bookingId);
  assert.equal(row.status, "confirmed");
  assert.equal(row.platnosc.status, "succeeded");

  // ponowne „Zapłać” nie dubluje efektu
  const again = await h.post(env.base, "/api/platnosc/mock", { paymentId, wynik: "zaplac" });
  assert.equal(again.json.status, "confirmed");
  const { rows } = await h.query("SELECT count(*)::int n FROM notifications WHERE booking_id = $1", [r.json.bookingId]);
  assert.equal(rows[0].n, 1);

  const read = await h.post(env.base, "/api/admin/powiadomienia/przeczytane", { wszystkie: true }, { cookie });
  assert.equal(read.json.nieprzeczytane, 0);
});

test("mock: „Anuluj” zwalnia termin od razu, a po czasie nie da się zapłacić", async () => {
  const slot = await h.makeSlot("myjnia-reczna", { time: "21:30" });
  const r = await h.post(env.base, "/api/zapis", h.bookingBody("myjnia-reczna", slot));
  const paymentId = r.json.redirectUrl.split("/").pop();
  const c = await h.post(env.base, "/api/platnosc/mock", { paymentId, wynik: "anuluj" });
  assert.equal(c.json.status, "expired");
  assert.match(c.json.next, /platnosc-nieudana.*powod=anulowano/);
  const free = await h.get(env.base, `/api/terminy?usluga=myjnia-reczna&dzien=${slot.date}`);
  assert.ok(free.json.terminy.some((t) => t.godzina === slot.time));

  const r2 = await h.post(env.base, "/api/zapis", h.bookingBody("myjnia-reczna", slot));
  const p2 = r2.json.redirectUrl.split("/").pop();
  await h.query("UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1", [r2.json.bookingId]);
  const late = await h.post(env.base, "/api/platnosc/mock", { paymentId: p2, wynik: "zaplac" });
  assert.equal(late.json.status, "expired");
  assert.match(late.json.next, /powod=czas/);
});

test("webhook Stripe: zła sygnatura odrzucona, powtórzone zdarzenie nie dubluje efektu", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
  try {
    const slot = await h.makeSlot("geometria-kol-3d", { time: "21:00" });
    const r = await h.post(env.base, "/api/zapis", h.bookingBody("geometria-kol-3d", slot));
    const bookingId = r.json.bookingId;
    // udajemy płatność utworzoną przez Stripe (bez łączenia z API Stripe)
    const { rows: [p] } = await h.query("UPDATE payments SET provider = 'stripe', provider_ref = 'cs_test_123' WHERE booking_id = $1 RETURNING id", [bookingId]);

    const event = (id, type, extra = {}) => JSON.stringify({ id, object: "event", type, data: { object: {
      id: "cs_test_123", object: "checkout.session", payment_status: "paid", metadata: { bookingId, paymentId: p.id }, ...extra } } });
    const sign = (payload, secret = "whsec_test_secret") => new Stripe("sk_test_dummy").webhooks.generateTestHeaderString({ payload, secret });

    const payload = event("evt_1", "checkout.session.completed");
    const bad = await h.post(env.base, "/api/stripe-webhook", payload, { "Stripe-Signature": sign(payload, "whsec_inny") });
    assert.equal(bad.status, 400);
    const none = await h.post(env.base, "/api/stripe-webhook", payload);
    assert.equal(none.status, 400);
    const tampered = await h.post(env.base, "/api/stripe-webhook", payload.replace("paid", "paid "), { "Stripe-Signature": sign(payload) });
    assert.equal(tampered.status, 400);
    let { rows: [b] } = await h.query("SELECT status FROM bookings WHERE id = $1", [bookingId]);
    assert.equal(b.status, "pending_payment", "zła sygnatura nie zmienia stanu");

    const ok = await h.post(env.base, "/api/stripe-webhook", payload, { "Stripe-Signature": sign(payload) });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.status, "confirmed");

    const dup = await h.post(env.base, "/api/stripe-webhook", payload, { "Stripe-Signature": sign(payload) });
    assert.equal(dup.status, 200);
    assert.equal(dup.json.duplicate, true);

    // inne zdarzenie z tą samą sesją też niczego nie dubluje
    const p2 = event("evt_2", "checkout.session.async_payment_succeeded");
    const dup2 = await h.post(env.base, "/api/stripe-webhook", p2, { "Stripe-Signature": sign(p2) });
    assert.equal(dup2.json.noop, true);
    // późne „expired” po potwierdzeniu nie cofa rezerwacji
    const p3 = event("evt_3", "checkout.session.expired", { payment_status: "unpaid" });
    await h.post(env.base, "/api/stripe-webhook", p3, { "Stripe-Signature": sign(p3) });

    ({ rows: [b] } = await h.query("SELECT status FROM bookings WHERE id = $1", [bookingId]));
    assert.equal(b.status, "confirmed");
    const { rows: [cnt] } = await h.query("SELECT count(*)::int n FROM notifications WHERE booking_id = $1", [bookingId]);
    assert.equal(cnt.n, 1);
    const { rows: [pay] } = await h.query("SELECT status FROM payments WHERE id = $1", [p.id]);
    assert.equal(pay.status, "succeeded");
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
});

test("webhook Stripe: checkout.session.expired zwalnia termin", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
  try {
    const slot = await h.makeSlot("geometria-kol-3d", { time: "21:30" });
    const r = await h.post(env.base, "/api/zapis", h.bookingBody("geometria-kol-3d", slot));
    const { rows: [p] } = await h.query("UPDATE payments SET provider = 'stripe', provider_ref = 'cs_test_exp' WHERE booking_id = $1 RETURNING id", [r.json.bookingId]);
    const payload = JSON.stringify({ id: "evt_exp", object: "event", type: "checkout.session.expired",
      data: { object: { id: "cs_test_exp", payment_status: "unpaid", metadata: { paymentId: p.id } } } });
    const sig = new Stripe("sk_test_dummy").webhooks.generateTestHeaderString({ payload, secret: "whsec_test_secret" });
    const res = await h.post(env.base, "/api/stripe-webhook", payload, { "Stripe-Signature": sig });
    assert.equal(res.json.status, "expired");
    const free = await h.get(env.base, `/api/terminy?usluga=geometria-kol-3d&dzien=${slot.date}`);
    assert.ok(free.json.terminy.some((t) => t.godzina === slot.time));
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
});

test("PAYMENTS_MODE=real bez kluczy: aplikacja nie startuje i mówi dlaczego", async () => {
  const { spawnSync } = require("child_process");
  const out = spawnSync(process.execPath, ["scripts/dev-server.js"], {
    cwd: require("path").join(__dirname, ".."),
    env: { ...process.env, PAYMENTS_MODE: "real", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", PORT: "0" },
    encoding: "utf8", timeout: 10000,
  });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /PAYMENTS_MODE=real wymaga ustawienia: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET/);
});

test("strona zaliczki: najpierw /zaliczka z kwotą i adresem płatności, rezygnacja od razu zwalnia termin", async () => {
  const slot = await h.makeSlot("myjnia-reczna", { time: "22:30" });
  const r = await h.post(env.base, "/api/zapis", h.bookingBody("myjnia-reczna", slot));
  assert.equal(r.json.nextUrl, `/zaliczka?id=${r.json.bookingId}`, "formularz prowadzi na stronę zaliczki, nie prosto do płatności");
  assert.equal((await fetch(env.base + r.json.nextUrl)).status, 200);
  const st = await h.get(env.base, `/api/platnosc/status?id=${r.json.bookingId}`);
  assert.equal(st.json.rezerwacja.platnosc.kwota, 5000);
  assert.equal(st.json.rezerwacja.platnosc.url, r.json.redirectUrl, "przycisk „Przejdź do płatności” prowadzi do płatności");

  let free = await h.get(env.base, `/api/terminy?usluga=myjnia-reczna&dzien=${slot.date}`);
  assert.ok(!free.json.terminy.some((t) => t.godzina === slot.time), "termin wstrzymany w czasie czytania strony");
  const c = await h.post(env.base, "/api/platnosc/anuluj", { id: r.json.bookingId });
  assert.equal(c.status, 200);
  free = await h.get(env.base, `/api/terminy?usluga=myjnia-reczna&dzien=${slot.date}`);
  assert.ok(free.json.terminy.some((t) => t.godzina === slot.time), "po rezygnacji termin wrócił do puli");
  const after = await h.get(env.base, `/api/platnosc/status?id=${r.json.bookingId}`);
  assert.equal(after.json.rezerwacja.status, "expired");
  assert.equal(after.json.rezerwacja.platnosc.url, null, "po rezygnacji nie da się już zapłacić");

  // formularz bez JS (zwykły POST) też trafia na stronę zaliczki
  const form = await fetch(env.base + "/api/zapis", { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "10.1.2.3" },
    body: new URLSearchParams({ ...h.bookingBody("myjnia-reczna", slot), zgoda: "tak" }) });
  assert.equal(form.status, 303);
  assert.match(form.headers.get("location"), /^\/zaliczka\?id=/);
});

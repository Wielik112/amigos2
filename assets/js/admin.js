/* Amigos – panel rezerwacji (bez zależności). Wszystkie daty wyświetlane w Europe/Warsaw. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const TZ = "Europe/Warsaw";

  /* ---------- Narzędzia ---------- */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ymdOf = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
  const today = () => ymdOf(new Date());
  const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dayFmt = (ymd, opts) => new Date(ymd + "T12:00:00Z").toLocaleDateString("pl-PL", { timeZone: "UTC", ...opts });
  const shortDay = (ymd) => dayFmt(ymd, { weekday: "short", day: "numeric", month: "2-digit" });
  const longDay = (ymd) => dayFmt(ymd, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const dateTime = (iso) => iso ? new Date(iso).toLocaleString("pl-PL", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }) : "";
  const zl = (gr) => (gr / 100).toLocaleString("pl-PL", { style: "currency", currency: "PLN" });
  const phoneFmt = (p) => String(p || "").replace(/^\+48(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3");
  const toMin = (hm) => { const [h, m] = String(hm).split(":").map(Number); return h * 60 + m; };
  const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const range = (a, b) => (a ? `${a}${b ? "–" + b : ""}` : "");

  const STATUS = { pending_payment: "Czeka na płatność", confirmed: "Potwierdzona", expired: "Wygasła", cancelled: "Anulowana" };
  const PAY = { pending: "Oczekuje", succeeded: "Opłacona", failed: "Nieudana", expired: "Wygasła", refunded: "Zwrócona" };
  const LABELS = { pojazd: "Pojazd", badanie: "Badanie", pakiet: "Pakiet", zakres: "Zakres", dodatkowo: "Dodatkowo", sprawa: "Sprawa",
    ubezpieczenie: "Ubezpieczenie", polisa: "Polisa", data: "Kiedy oddzwonić", pora: "Pora dnia", marka: "Marka i model",
    rejestracja: "Nr rejestracyjny", opis: "Opis", problem: "Opis problemu" };
  const DAYS = ["Poniedziałek", "Wtorek", "Środa", "Czwartek", "Piątek", "Sobota", "Niedziela"];
  const pill = (key, label) => `<span class="pill pill--${esc(key)}">${esc(label)}</span>`;

  class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  async function api(path, opts = {}) {
    const res = await fetch("/api/admin/" + path, {
      method: opts.method || "GET",
      headers: { Accept: "application/json", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "login") { showLogin(); throw new ApiError(401, json.error || "Zaloguj się."); }
    if (!res.ok || json.ok === false) throw new ApiError(res.status, json.error || "Coś poszło nie tak. Spróbuj ponownie.");
    return json;
  }

  const toast = (title, text, onClick) => {
    const t = document.createElement("div");
    t.className = "adm-toast";
    t.innerHTML = `<b>${esc(title)}</b>${text ? esc(text) : ""}`;
    t.addEventListener("click", () => { t.remove(); onClick && onClick(); });
    $("[data-toasts]").append(t);
    setTimeout(() => t.remove(), 8000);
  };
  const say = (el, text, err) => { if (!el) return; el.textContent = text || ""; el.classList.toggle("is-err", !!err); };
  const showMsg = (el, text) => { el.textContent = text; el.hidden = !text; };

  /* ---------- Widoki: logowanie / aplikacja ---------- */
  const state = { services: [], resources: [], tab: "", panel: "rezerwacje", day: today(), graf: null, lastNotif: null, timer: null };
  const slotServices = () => state.services.filter((s) => s.terminy);
  const svcById = (id) => state.services.find((s) => s.id === Number(id));

  function showLogin() {
    clearInterval(state.timer);
    $("[data-view=app]").hidden = true;
    $("[data-view=login]").hidden = false;
    setTimeout(() => $("#l-login").focus(), 0);
  }

  const loginForm = $("[data-login]");
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("[data-login-msg]");
    msg.hidden = true;
    const btn = $("button[type=submit]", loginForm);
    btn.disabled = true;
    try {
      await api("login", { method: "POST", body: { login: loginForm.login.value, haslo: loginForm.haslo.value } });
      loginForm.haslo.value = "";
      await start();
    } catch (err) {
      showMsg(msg, err.message);
    } finally { btn.disabled = false; }
  });

  $("[data-logout]").addEventListener("click", async () => {
    await api("logout", { method: "POST" }).catch(() => {});
    showLogin();
  });

  async function loadMeta() {
    const [{ uslugi }, { stanowiska }] = await Promise.all([api("uslugi"), api("stanowiska")]);
    state.services = uslugi;
    state.resources = stanowiska;
  }

  async function start() {
    const me = await api("me");
    $("[data-user]").textContent = me.admin;
    $("[data-mode]").hidden = me.trybPlatnosci !== "mock";
    $("[data-view=login]").hidden = true;
    $("[data-view=app]").hidden = false;
    await loadMeta();
    renderTabs();
    renderGrafSelect();
    route();
    pollNotifications(true);
    clearInterval(state.timer);
    state.timer = setInterval(() => pollNotifications(false), 20000);
  }

  /* ---------- Nawigacja ---------- */
  const PANELS = ["rezerwacje", "kalendarz", "grafik", "uslugi"];
  function route() {
    const p = (location.hash || "#rezerwacje").slice(1);
    state.panel = PANELS.includes(p) ? p : "rezerwacje";
    $$("[data-panel]").forEach((s) => { s.hidden = s.dataset.panel !== state.panel; });
    $$("[data-nav]").forEach((a) => { if (a.dataset.nav === state.panel) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    refreshPanel();
  }
  function refreshPanel() {
    if (state.panel === "rezerwacje") loadBookings();
    if (state.panel === "kalendarz") loadDay();
    if (state.panel === "grafik") loadSchedule();
    if (state.panel === "uslugi") renderServices();
  }
  window.addEventListener("hashchange", route);

  /* ---------- Rezerwacje ---------- */
  const filters = $("[data-filters]");
  const resetFilters = () => { filters.od.value = today(); filters.do.value = ""; filters.status.value = ""; filters.szukaj.value = ""; };
  resetFilters();

  function renderTabs() {
    const box = $("[data-svc-tabs]");
    const tabs = [{ slug: "", nazwa: "Wszystkie" }, ...state.services];
    box.innerHTML = tabs.map((s) => `<button class="tab" type="button" role="tab" aria-selected="${s.slug === state.tab}" data-tab="${esc(s.slug)}">${esc(s.nazwa)}</button>`).join("");
    $$("[data-tab]", box).forEach((b) => b.addEventListener("click", () => {
      state.tab = b.dataset.tab;
      $$("[data-tab]", box).forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      loadBookings();
    }));
  }

  filters.addEventListener("submit", (e) => { e.preventDefault(); loadBookings(); });
  $("[data-upcoming]").addEventListener("click", () => { resetFilters(); loadBookings(); });

  const whenCell = (r) => {
    if (r.kontakt) {
      const d = r.details || {};
      return `<b>Prośba o kontakt</b><small>${d.data ? esc(shortDay(d.data)) : "jak najszybciej"}${d.pora && d.pora !== "Obojętnie" ? ", " + esc(d.pora.toLowerCase()) : ""} · zgłoszono ${esc(dateTime(r.utworzono))}</small>`;
    }
    return `<b>${esc(shortDay(r.data))}, ${esc(range(r.godzina, r.godzinaDo))}</b>${r.stanowisko ? `<small>${esc(r.stanowisko)}</small>` : ""}`;
  };
  const payCell = (p) => (p ? `${pill(p.status, PAY[p.status] || p.status)}<small>${esc(zl(p.kwota))}${p.dostawca === "mock" ? " · test" : ""}</small>` : '<small>bez zaliczki</small>');
  const srcTag = (r) => (r.zrodlo === "telefon" ? ' <span class="pill">telefon</span>' : "");

  async function loadBookings() {
    const q = new URLSearchParams();
    if (state.tab) q.set("usluga", state.tab);
    for (const k of ["od", "do", "status", "szukaj"]) if (filters[k].value) q.set(k, filters[k].value.trim());
    const tbody = $("[data-bookings]");
    let list;
    try { ({ rezerwacje: list } = await api("rezerwacje?" + q)); } catch (e) { if (e.status !== 401) toast("Błąd", e.message); return; }
    tbody.innerHTML = list.map((r) => `<tr tabindex="0" data-id="${esc(r.id)}">
      <td>${whenCell(r)}</td><td>${esc(r.uslugaNazwa)}</td>
      <td><b>${esc(r.klient)}</b>${srcTag(r)}${r.email ? `<small>${esc(r.email)}</small>` : ""}</td>
      <td><a href="tel:${esc(r.telefon)}">${esc(phoneFmt(r.telefon))}</a></td>
      <td>${pill(r.status, STATUS[r.status] || r.status)}</td><td>${payCell(r.platnosc)}</td></tr>`).join("");
    $("[data-bookings-empty]").hidden = list.length > 0;
    $$("tr[data-id]", tbody).forEach((tr) => {
      const open = (e) => { if (e.target.closest("a")) return; openBooking(tr.dataset.id); };
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); } });
    });
  }

  /* ---------- Szczegóły i anulowanie ---------- */
  const dlgB = $("[data-dlg-booking]");
  const dlgC = $("[data-dlg-cancel]");
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  let current = null;

  const dl = (rows) => `<dl>${rows.filter((r) => r[1] !== null && r[1] !== undefined && r[1] !== "")
    .map(([k, v, raw]) => `<dt>${esc(k)}</dt><dd>${raw ? v : esc(v)}</dd>`).join("")}</dl>`;

  async function openBooking(id) {
    let r;
    try { ({ rezerwacja: r } = await api("rezerwacje/" + id)); } catch (e) { if (e.status !== 401) toast("Błąd", e.message); return; }
    current = r;
    $("[data-b-title]").textContent = `${r.uslugaNazwa}: ${r.klient}`;
    const d = r.details || {};
    const detailRows = Object.keys(d).map((k) => [LABELS[k] || k, Array.isArray(d[k]) ? d[k].join(", ") : k === "data" ? longDay(d[k]) : d[k]]);
    const pays = r.platnosci.map((p) => `<li>${pill(p.status, PAY[p.status] || p.status)} ${esc(zl(p.kwota))} · ${p.dostawca === "stripe" ? "Stripe" : "płatność testowa"}${p.ref ? ` · <small>${esc(p.ref)}</small>` : ""} · ${esc(dateTime(p.zmieniono))}</li>`).join("");
    $("[data-b-body]").innerHTML = `
      ${dl([
        ["Status", pill(r.status, STATUS[r.status] || r.status), true],
        ["Termin", r.kontakt ? "prośba o kontakt (bez terminu)" : `${longDay(r.data)}, ${range(r.godzina, r.godzinaDo)}`],
        ["Stanowisko", r.stanowisko],
        ["Klient", r.klient],
        ["Telefon", `<a href="tel:${esc(r.telefon)}">${esc(phoneFmt(r.telefon))}</a>`, true],
        ["E-mail", r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : "", true],
        ...detailRows,
        ["Notatka", r.notatki],
      ])}
      <h3>Historia</h3>
      ${dl([
        ["Źródło", r.zrodlo === "telefon" ? "dodana w panelu" : "rezerwacja online"],
        ["Utworzono", dateTime(r.utworzono)],
        ["Zgoda RODO", r.zrodlo === "telefon" ? "" : dateTime(r.zgoda)],
        ["Potwierdzono", dateTime(r.potwierdzono)],
        ["Hold do", r.status === "pending_payment" ? dateTime(r.holdDo) : ""],
        ["Anulowano", r.anulowano ? `${dateTime(r.anulowano)} (${r.anulowal || "?"})` : ""],
        ["Powód anulowania", r.powod],
        ["Płatności", pays ? `<ul>${pays}</ul>` : "", true],
      ])}`;
    $("[data-b-cancel]").hidden = !(r.status === "confirmed" || r.status === "pending_payment");
    $("[data-b-move]").hidden = !(r.status === "confirmed" && !r.kontakt);
    if (!dlgB.open) dlgB.showModal();
  }

  $("[data-b-cancel]").addEventListener("click", () => {
    if (!current) return;
    const paid = current.platnosci.find((p) => p.id === current.aktywnaPlatnosc && p.status === "succeeded");
    $("[data-c-who]").textContent = `${current.uslugaNazwa}, ${current.kontakt ? "prośba o kontakt" : longDay(current.data) + ", " + range(current.godzina, current.godzinaDo)} – ${current.klient}. Termin wróci do puli wolnych godzin.`;
    const note = $("[data-c-refund]");
    note.hidden = !paid;
    if (paid) note.textContent = paid.dostawca === "stripe"
      ? `Zaliczka ${zl(paid.kwota)} została opłacona. Zwrot trzeba na razie zrobić ręcznie w panelu Stripe.`
      : `Zaliczka ${zl(paid.kwota)} (płatność testowa) zostanie oznaczona jako zwrócona.`;
    $("[data-c-msg]").hidden = true;
    $("#c-reason").value = "";
    dlgC.showModal();
  });

  $("[data-cancel-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("button[type=submit]", e.target);
    btn.disabled = true;
    try {
      const out = await api(`rezerwacje/${current.id}/anuluj`, { method: "POST", body: { powod: $("#c-reason").value } });
      dlgC.close();
      toast("Rezerwacja anulowana", out.zwrot ? " " + out.zwrot.message : " Termin wrócił do puli.");
      openBooking(current.id);
      refreshPanel();
    } catch (err) {
      showMsg($("[data-c-msg]"), err.message);
    } finally { btn.disabled = false; }
  });

  /* ---------- Przełożenie (klient zadzwonił) ---------- */
  const dlgM = $("[data-dlg-move]");
  const moveForm = $("[data-move-form]");
  let moveSeq = 0;
  async function loadMoveTimes() {
    const free = moveForm.pozaGrafikiem.checked;
    $("[data-m-slot]").hidden = free;
    $("[data-m-free]").hidden = !free;
    if (free || !current) return;
    const sel = moveForm.godzina, my = ++moveSeq;
    sel.innerHTML = "<option>Sprawdzam…</option>";
    sel.disabled = true;
    const q = new URLSearchParams({ usluga: current.uslugaId, dzien: moveForm.data.value, czas: moveForm.czas.value || "", bez: current.id });
    if (moveForm.stanowisko.value) q.set("stanowisko", moveForm.stanowisko.value);
    let r;
    try { r = await api("wolne?" + q); } catch (e) { sel.innerHTML = `<option value="">${esc(e.message)}</option>`; return; }
    if (my !== moveSeq) return;
    sel.disabled = false;
    if (!r.terminy.length) { sel.innerHTML = `<option value="">${r.zamkniete ? "Zamknięte – " + esc(r.zamkniete) : "Brak wolnego miejsca tego dnia"}</option>`; return; }
    sel.innerHTML = r.terminy.map((t) => `<option value="${t.godzina}">${t.godzina}–${t.do}</option>`).join("");
    if (r.terminy.some((t) => t.godzina === current.godzina)) sel.value = current.godzina;
  }
  $("[data-b-move]").addEventListener("click", () => {
    if (!current) return;
    moveForm.reset();
    showMsg($("[data-m-msg]"), "");
    $("[data-m-who]").textContent = `${current.uslugaNazwa} – ${current.klient}. Teraz: ${longDay(current.data)}, ${range(current.godzina, current.godzinaDo)}${current.stanowisko ? " (" + current.stanowisko + ")" : ""}.`;
    moveForm.data.value = current.data;
    moveForm.czas.value = toMin(current.godzinaDo) - toMin(current.godzina);
    moveForm.godzinaDowolna.value = current.godzina;
    const s = svcById(current.uslugaId);
    const list = state.resources.filter((r) => s && s.stanowiska.includes(r.id) && r.aktywne);
    moveForm.stanowisko.innerHTML = `<option value="">Dowolne wolne</option>` + list.map((r) => `<option value="${r.id}">${esc(r.nazwa)}</option>`).join("");
    loadMoveTimes();
    dlgM.showModal();
  });
  ["data", "czas", "stanowisko", "pozaGrafikiem"].forEach((n) => moveForm[n].addEventListener("change", loadMoveTimes));
  moveForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("[data-m-msg]");
    showMsg(msg, "");
    const free = moveForm.pozaGrafikiem.checked;
    const godzina = free ? moveForm.godzinaDowolna.value : moveForm.godzina.value;
    if (!godzina) { showMsg(msg, "Wybierz godzinę."); return; }
    const btn = $("button[type=submit]", moveForm);
    btn.disabled = true;
    try {
      const { rezerwacja: r } = await api(`rezerwacje/${current.id}/przeloz`, { method: "POST", body: {
        data: moveForm.data.value, godzina, czas: Number(moveForm.czas.value), pozaGrafikiem: free,
        stanowisko: moveForm.stanowisko.value ? Number(moveForm.stanowisko.value) : null } });
      dlgM.close();
      toast("Wizyta przełożona", ` ${r.klient}: ${shortDay(r.data)} ${range(r.godzina, r.godzinaDo)} · ${r.stanowisko}`);
      openBooking(r.id);
      refreshPanel();
    } catch (err) {
      showMsg(msg, err.message);
      if (err.status === 409) loadMoveTimes();
    } finally { btn.disabled = false; }
  });

  /* ---------- Kalendarz dnia ---------- */
  const PPM = 1.4;   // pikseli na minutę
  $$("[data-day]").forEach((b) => b.addEventListener("click", () => { state.day = addDays(state.day, Number(b.dataset.day)); loadDay(); }));
  $("[data-day-today]").addEventListener("click", () => { state.day = today(); loadDay(); });
  $("[data-day-pick]").addEventListener("change", (e) => { if (e.target.value) { state.day = e.target.value; loadDay(); } });

  async function loadDay() {
    let cal;
    try { cal = await api("kalendarz?dzien=" + state.day); } catch (e) { if (e.status !== 401) toast("Błąd", e.message); return; }
    $("[data-day-label]").textContent = longDay(cal.dzien) + (cal.dzien === today() ? " (dziś)" : "");
    $("[data-day-pick]").value = cal.dzien;
    const closed = Object.entries(cal.zamkniete).map(([id, why]) => `${(svcById(id) || {}).nazwa}: ${why}`);
    const note = $("[data-day-note]");
    note.hidden = !closed.length && !cal.swieto;
    note.textContent = cal.swieto ? `${cal.swieto}. ` : "";
    if (closed.length) note.textContent += "Zamknięte – " + closed.join(" · ");
    renderCalendar(cal);
  }

  function renderCalendar(cal) {
    const box = $("[data-cal]");
    const open = toMin(cal.od), close = toMin(cal.do);
    const height = (close - open) * PPM;
    const res = cal.stanowiska.filter((r) => r.aktywne || cal.rezerwacje.some((b) => b.stanowisko === r.id));
    const top = (hm) => (toMin(hm) - open) * PPM;
    let hours = "";
    for (let m = open; m <= close; m += 60) hours += `<div class="adm-cal__h" data-y="${(m - open) * PPM}">${fmtMin(m)}</div>`;
    const lines = Array.from({ length: (close - open) / 30 + 1 }, (_, i) => `<i data-y="${i * 30 * PPM}"${i % 2 ? ' class="is-half"' : ""}></i>`).join("");
    const cols = res.map((r) => {
      // godziny pracy stanowiska = suma godzin usług, które obsługuje
      const win = r.uslugi.flatMap((s) => cal.godzinyPracy[s] || []);
      const on = win.map(([a, b]) => `<div class="adm-cal__on" data-y="${top(a)}" data-h="${(toMin(b) - toMin(a)) * PPM}"></div>`).join("");
      const bl = cal.blokady.filter((t) => t.stanowisko === r.id || (t.usluga && r.uslugi.includes(t.usluga))).map((t) => {
        const a = t.godzina, b = t.godzinaDo === "00:00" ? fmtMin(24 * 60) : t.godzinaDo;
        return `<button type="button" class="adm-ev adm-ev--block" data-block="${t.id}" data-y="${Math.max(0, top(a))}" data-h="${Math.max(18, (Math.min(close, toMin(b)) - Math.max(open, toMin(a))) * PPM)}"
          title="Blokada ${esc(range(a, b))}${t.powod ? " – " + esc(t.powod) : ""}"><b>Blokada</b><small>${esc(t.powod || range(a, b))}</small></button>`;
      }).join("");
      const ev = cal.rezerwacje.filter((b) => b.stanowisko === r.id).map((b) => {
        const len = toMin(b.godzinaDo) - toMin(b.godzina);
        return `<button type="button" class="adm-ev adm-ev--${b.status}" data-booking="${esc(b.id)}" data-y="${top(b.godzina)}" data-h="${Math.max(20, len * PPM)}" data-buf="${b.zapasMin * PPM}"
          title="${esc(range(b.godzina, b.godzinaDo))} ${esc(b.uslugaNazwa)} – ${esc(b.klient)}"><b>${esc(range(b.godzina, b.godzinaDo))} ${esc(b.klient)}</b><small>${esc(b.uslugaNazwa)}${b.zrodlo === "telefon" ? " · telefon" : ""}${b.status === "pending_payment" ? " · czeka na płatność" : ""}</small></button>`;
      }).join("");
      return `<div class="adm-cal__col"><div class="adm-cal__head">${esc(r.nazwa)}${r.aktywne ? "" : " <small>(wyłączone)</small>"}</div>
        <div class="adm-cal__body" data-res="${r.id}" data-hgt="${height}">${lines}${on}${bl}${ev}</div></div>`;
    }).join("");
    box.style.setProperty("--cols", res.length);
    box.innerHTML = `<div class="adm-cal__col adm-cal__col--time"><div class="adm-cal__head"></div><div class="adm-cal__body" data-hgt="${height}">${hours}</div></div>${cols}`;
    // pozycje przez CSSOM – CSP strony nie pozwala na atrybuty style w HTML
    $$("[data-y],[data-hgt]", box).forEach((el) => {
      const d = el.dataset;
      if (d.y !== undefined) el.style.setProperty("--y", d.y + "px");
      if (d.h !== undefined) el.style.setProperty("--h", d.h + "px");
      if (d.buf !== undefined) el.style.setProperty("--buf", d.buf + "px");
      if (d.hgt !== undefined) el.style.setProperty("--hgt", d.hgt + "px");
    });

    $$("[data-booking]", box).forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); openBooking(b.dataset.booking); }));
    $$("[data-block]", box).forEach((b) => b.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Usunąć tę blokadę? Ten czas znów będzie dostępny do rezerwacji.")) return;
      try { await api("blokady/" + b.dataset.block, { method: "DELETE" }); loadDay(); } catch (err) { toast("Błąd", err.message); }
    }));
    $$("[data-res]", box).forEach((col) => col.addEventListener("click", (e) => {
      const y = e.clientY - col.getBoundingClientRect().top;
      const m = Math.floor((open + y / PPM) / 15) * 15;
      const r = res.find((x) => String(x.id) === col.dataset.res);
      const svc = r && r.uslugi.map(svcById).find((s) => s && s.terminy);
      openAdd({ usluga: svc && svc.id, data: state.day, godzina: fmtMin(m), stanowisko: r && r.id });
    }));
  }

  /* ---------- Nowa rezerwacja (z telefonu) ---------- */
  const dlgA = $("[data-dlg-add]");
  const addForm = $("[data-add-form]");
  const typical = (s) => {
    // typowy czas: pierwsza opcja każdego pola wyboru (np. „Osobowy” + „Okresowe”)
    let t = s.czasBazowy || 0, min = t, max = t;
    for (const f of s.pola) {
      const vals = f.opcje.map((o) => Number((s.czasy[f.nazwa] || {})[o]) || 0);
      if (f.typ === "checks") { max += vals.reduce((a, b) => a + b, 0); continue; }
      t += vals[0] || 0; min += Math.min(...vals); max += Math.max(...vals);
    }
    return { t: Math.max(10, t), min: Math.max(10, min), max: Math.max(10, max) };
  };
  function fillAddResources(pref) {
    const s = svcById(addForm.usluga.value);
    const list = state.resources.filter((r) => s && s.stanowiska.includes(r.id) && r.aktywne);
    addForm.stanowisko.innerHTML = `<option value="">Dowolne wolne</option>` + list.map((r) => `<option value="${r.id}">${esc(r.nazwa)}</option>`).join("");
    if (pref && list.some((r) => r.id === Number(pref))) addForm.stanowisko.value = String(pref);
  }
  function syncLen() {
    const s = svcById(addForm.usluga.value);
    if (!s) return;
    const t = typical(s);
    addForm.czas.value = t.t;
    $("[data-a-len-hint]").textContent = t.min === t.max ? "" : `Zwykle ${t.min}–${t.max} min (zależy od zakresu usługi).`;
  }
  let addSeq = 0, addPref = null;
  async function loadAddTimes() {
    const sel = addForm.godzina;
    const free = addForm.pozaGrafikiem.checked;
    $("[data-a-slot]").hidden = free;
    $("[data-a-free]").hidden = !free;
    if (free) { if (addPref) addForm.godzinaDowolna.value = addPref; return; }
    if (!addForm.usluga.value || !addForm.data.value) return;
    const my = ++addSeq;
    sel.innerHTML = "<option>Sprawdzam…</option>";
    sel.disabled = true;
    const q = new URLSearchParams({ usluga: addForm.usluga.value, dzien: addForm.data.value, czas: addForm.czas.value || "" });
    if (addForm.stanowisko.value) q.set("stanowisko", addForm.stanowisko.value);
    let r;
    try { r = await api("wolne?" + q); } catch (e) { sel.innerHTML = `<option value="">${esc(e.message)}</option>`; return; }
    if (my !== addSeq) return;
    sel.disabled = false;
    if (!r.terminy.length) { sel.innerHTML = `<option value="">${r.zamkniete ? "Zamknięte – " + esc(r.zamkniete) : "Brak wolnego miejsca tego dnia"}</option>`; return; }
    sel.innerHTML = r.terminy.map((t) => `<option value="${t.godzina}">${t.godzina}–${t.do}${t.wolne > 1 ? ` (wolne: ${t.wolne})` : ""}</option>`).join("");
    if (addPref) {
      // z kliknięcia w kalendarzu: najbliższa wolna godzina od klikniętej
      const hit = r.terminy.find((t) => t.godzina >= addPref) || r.terminy[r.terminy.length - 1];
      sel.value = hit.godzina;
    }
  }
  function openAdd(pre = {}) {
    addForm.reset();
    showMsg($("[data-a-msg]"), "");
    addForm.usluga.innerHTML = slotServices().map((s) => `<option value="${s.id}">${esc(s.nazwa)}</option>`).join("");
    if (pre.usluga) addForm.usluga.value = String(pre.usluga);
    addForm.data.value = pre.data || state.day || today();
    addPref = pre.godzina || null;
    fillAddResources(pre.stanowisko);
    syncLen();
    loadAddTimes();
    dlgA.showModal();
    setTimeout(() => addForm.imie.focus(), 0);
  }
  $$("[data-add-booking]").forEach((b) => b.addEventListener("click", () => openAdd({ data: state.panel === "kalendarz" ? state.day : today() })));
  addForm.usluga.addEventListener("change", () => { fillAddResources(); syncLen(); loadAddTimes(); });
  ["data", "stanowisko"].forEach((n) => addForm[n].addEventListener("change", loadAddTimes));
  addForm.czas.addEventListener("change", loadAddTimes);
  addForm.pozaGrafikiem.addEventListener("change", loadAddTimes);
  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("[data-a-msg]");
    showMsg(msg, "");
    const free = addForm.pozaGrafikiem.checked;
    const godzina = free ? addForm.godzinaDowolna.value : addForm.godzina.value;
    if (!godzina) { showMsg(msg, "Wybierz godzinę."); return; }
    const btn = $("button[type=submit]", addForm);
    btn.disabled = true;
    try {
      const { rezerwacja: r } = await api("rezerwacje", { method: "POST", body: {
        usluga: Number(addForm.usluga.value), data: addForm.data.value, godzina, czas: Number(addForm.czas.value),
        stanowisko: addForm.stanowisko.value ? Number(addForm.stanowisko.value) : null, pozaGrafikiem: free,
        imie: addForm.imie.value, telefon: addForm.telefon.value, notatka: addForm.notatka.value,
      } });
      dlgA.close();
      toast("Rezerwacja zapisana", ` ${r.klient}, ${shortDay(r.data)} ${range(r.godzina, r.godzinaDo)} · ${r.stanowisko}`, () => openBooking(r.id));
      refreshPanel();
    } catch (err) {
      showMsg(msg, err.message);
      if (err.status === 409) loadAddTimes();
    } finally { btn.disabled = false; }
  });

  /* ---------- Blokada czasu ---------- */
  const dlgK = $("[data-dlg-block]");
  const blkForm = $("[data-block-form]");
  const syncBlk = () => { $("[data-k-hours]").hidden = blkForm.caly.checked; };
  blkForm.caly.addEventListener("change", syncBlk);
  function openBlock(pre = {}) {
    blkForm.reset();
    showMsg($("[data-k-msg]"), "");
    blkForm.co.innerHTML = `<optgroup label="Cała usługa">${slotServices().map((s) => `<option value="u${s.id}">${esc(s.nazwa)}</option>`).join("")}</optgroup>
      <optgroup label="Jedno stanowisko">${state.resources.filter((r) => r.aktywne).map((r) => `<option value="s${r.id}">${esc(r.nazwa)}</option>`).join("")}</optgroup>`;
    if (pre.usluga) blkForm.co.value = "u" + pre.usluga;
    blkForm.dzien.value = pre.dzien || state.day || today();
    syncBlk();
    dlgK.showModal();
  }
  $$("[data-add-block]").forEach((b) => b.addEventListener("click", () => openBlock()));
  blkForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = blkForm.co.value;
    const btn = $("button[type=submit]", blkForm);
    btn.disabled = true;
    try {
      const out = await api("blokady", { method: "POST", body: {
        usluga: v[0] === "u" ? Number(v.slice(1)) : null, stanowisko: v[0] === "s" ? Number(v.slice(1)) : null,
        dzien: blkForm.dzien.value, caly: blkForm.caly.checked, od: blkForm.od.value, do: blkForm.do.value, powod: blkForm.powod.value,
      } });
      dlgK.close();
      toast("Czas zablokowany", out.kolizje ? ` Uwaga: w tym czasie są już umówione wizyty (${out.kolizje}) – zostają, przełóż je ręcznie.` : " Nikt nie zarezerwuje go online.");
      refreshPanel();
    } catch (err) { showMsg($("[data-k-msg]"), err.message); } finally { btn.disabled = false; }
  });

  /* ---------- Grafik ---------- */
  const grafSel = $("#g-svc");
  function renderGrafSelect() {
    const list = slotServices();
    grafSel.innerHTML = list.map((s) => `<option value="${s.id}">${esc(s.nazwa)}</option>`).join("");
    state.graf = state.graf && list.some((s) => s.id === state.graf) ? state.graf : (list[0] || {}).id;
    grafSel.value = String(state.graf);
  }
  grafSel.addEventListener("change", () => { state.graf = Number(grafSel.value); loadSchedule(); });

  const hoursForm = $("[data-hours]");
  const rulesForm = $("[data-rules]");
  const excForm = $("[data-exc-form]");

  async function loadSchedule() {
    if (!state.graf) return;
    let g;
    try { g = await api("grafik/" + state.graf); } catch (e) { if (e.status !== 401) toast("Błąd", e.message); return; }
    renderHours(g.godziny);
    const s = svcById(state.graf);
    rulesForm.zapas.value = s.zapas;
    rulesForm.krok.value = String(s.krok);
    rulesForm.wyprzedzenie.value = s.wyprzedzenie;
    rulesForm.horyzont.value = s.horyzont;
    rulesForm.swietaZamkniete.checked = s.swietaZamkniete;
    say($(".adm-msg", hoursForm), ""); say($(".adm-msg", rulesForm), "");

    $("[data-exc-list]").innerHTML = g.wyjatki.length ? g.wyjatki.map((x) => `<li><span><b>${esc(longDay(x.dzien))}</b>
        <small>${x.zamkniete ? "zamknięte" : "otwarte " + esc(range(x.od, x.do))}${x.wszystkie ? " · wszystkie usługi" : ""}${x.notatka ? " · " + esc(x.notatka) : ""}</small></span>
        <button class="adm-link" type="button" data-del-exc="${x.id}">Usuń</button></li>`).join("") : '<li class="adm-empty-li">Brak – działa zwykły grafik.</li>';
    $("[data-hol-list]").innerHTML = g.swieta.map((h) => {
      const opened = g.wyjatki.find((x) => x.dzien === h.dzien && !x.zamkniete);
      return `<li><span><b>${esc(longDay(h.dzien))}</b><small>${esc(h.nazwa)}${!s.swietaZamkniete ? " · otwarte (święta nie zamykają tej usługi)" : opened ? " · otwarte wyjątkowo " + esc(range(opened.od, opened.do)) : ""}</small></span></li>`;
    }).join("");
    $("[data-blk-list]").innerHTML = g.blokady.length ? g.blokady.map((t) => `<li><span><b>${esc(longDay(t.dzien))}, ${esc(t.dzienDo !== t.dzien ? "cały dzień" : range(t.od, t.do))}</b>
        <small>${esc(t.stanowisko || "cała usługa")}${t.powod ? " · " + esc(t.powod) : ""}</small></span>
        <button class="adm-link" type="button" data-del-blk="${t.id}">Usuń</button></li>`).join("") : '<li class="adm-empty-li">Brak blokad. Dodasz je w Kalendarzu („Zablokuj czas”).</li>';
    $$("[data-del-exc]").forEach((b) => b.addEventListener("click", async () => { await api("wyjatki/" + b.dataset.delExc, { method: "DELETE" }).catch((e) => toast("Błąd", e.message)); loadSchedule(); }));
    $$("[data-del-blk]").forEach((b) => b.addEventListener("click", async () => { await api("blokady/" + b.dataset.delBlk, { method: "DELETE" }).catch((e) => toast("Błąd", e.message)); loadSchedule(); }));
  }

  function renderHours(rows) {
    $("[data-hours-rows]").innerHTML = DAYS.map((name, i) => {
      const d = i + 1;
      const day = rows.filter((r) => r.dzien === d).sort((a, b) => (a.od < b.od ? -1 : 1));
      const open = day.length > 0;
      const first = day[0] || { od: "08:00", do: "16:00" }, last = day[day.length - 1] || first;
      const brk = day.length > 1 ? [day[0].do, day[1].od] : ["", ""];
      return `<tr data-d="${d}"${open ? "" : ' class="is-off"'}><th>${name}</th>
        <td><label class="check"><input type="checkbox" data-k="open"${open ? " checked" : ""}><span class="sr">Otwarte</span></label></td>
        <td><input type="time" data-k="od" value="${first.od}" aria-label="${name} od"></td><td><input type="time" data-k="do" value="${last.do}" aria-label="${name} do"></td>
        <td><input type="time" data-k="bod" value="${brk[0]}" aria-label="${name} przerwa od"></td><td><input type="time" data-k="bdo" value="${brk[1]}" aria-label="${name} przerwa do"></td></tr>`;
    }).join("");
    $$("[data-hours-rows] tr").forEach((tr) => $("[data-k=open]", tr).addEventListener("change", (e) => tr.classList.toggle("is-off", !e.target.checked)));
  }

  hoursForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $(".adm-msg", hoursForm);
    const godziny = [];
    for (const tr of $$("[data-hours-rows] tr")) {
      if (!$("[data-k=open]", tr).checked) continue;
      const v = (k) => $(`[data-k=${k}]`, tr).value;
      const d = Number(tr.dataset.d);
      if (v("bod") && v("bdo")) { godziny.push({ dzien: d, od: v("od"), do: v("bod") }, { dzien: d, od: v("bdo"), do: v("do") }); }
      else godziny.push({ dzien: d, od: v("od"), do: v("do") });
    }
    try { await api(`grafik/${state.graf}/godziny`, { method: "PUT", body: { godziny } }); say(msg, "Zapisano."); }
    catch (err) { say(msg, err.message, true); }
  });

  rulesForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $(".adm-msg", rulesForm);
    try {
      const { usluga } = await api("uslugi/" + state.graf, { method: "PATCH", body: {
        zapas: Number(rulesForm.zapas.value), krok: Number(rulesForm.krok.value), wyprzedzenie: Number(rulesForm.wyprzedzenie.value),
        horyzont: Number(rulesForm.horyzont.value), swietaZamkniete: rulesForm.swietaZamkniete.checked } });
      state.services = state.services.map((s) => (s.id === usluga.id ? usluga : s));
      say(msg, "Zapisano.");
      loadSchedule();
    } catch (err) { say(msg, err.message, true); }
  });

  const syncExc = () => { $("[data-exc-hours]").hidden = excForm.zamkniete.checked; };
  excForm.zamkniete.addEventListener("change", syncExc);
  excForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $(".adm-msg", excForm);
    try {
      const out = await api("wyjatki", { method: "POST", body: {
        usluga: state.graf, wszystkie: excForm.zakres.value === "wszystkie", dzien: excForm.dzien.value,
        zamkniete: excForm.zamkniete.checked, od: excForm.od.value, do: excForm.do.value, notatka: excForm.notatka.value } });
      say(msg, out.kolizje ? `Zapisano. Uwaga: tego dnia są już umówione wizyty (${out.kolizje}) – zostają, przełóż je ręcznie.` : "Zapisano.", !!out.kolizje);
      excForm.notatka.value = "";
      loadSchedule();
    } catch (err) { say(msg, err.message, true); }
  });
  syncExc();

  /* ---------- Usługi i stanowiska ---------- */
  function renderServices() {
    const box = $("[data-services]");
    box.innerHTML = state.services.map((s) => {
      const res = state.resources.map((r) => `<label class="chip"><input type="checkbox" name="stanowiska" value="${r.id}"${s.stanowiska.includes(r.id) ? " checked" : ""}><span>${esc(r.nazwa)}</span></label>`).join("");
      const dur = s.pola.map((f) => `<tr class="adm-dur__h"><th colspan="2">${esc(LABELS[f.nazwa] || f.nazwa)}${f.typ === "checks" ? " <small>(dolicza się za każdą zaznaczoną)</small>" : ""}</th></tr>` +
        f.opcje.map((o) => `<tr><td>${esc(o)}</td><td><input type="number" min="0" max="480" step="5" data-f="${esc(f.nazwa)}" data-o="${esc(o)}" value="${Number((s.czasy[f.nazwa] || {})[o]) || 0}" aria-label="${esc(o)} – minuty"> min</td></tr>`).join("")).join("");
      const t = typical(s);
      return `<form class="bform adm-card adm-svc" data-svc="${s.id}" novalidate>
      <div class="adm-svc__head"><div><h2>${esc(s.nazwa)}</h2><p>${s.terminy ? `Wizyta: zwykle ${t.min === t.max ? t.t : t.min + "–" + t.max} min` : "Prośba o kontakt – bez terminów"}</p></div>
      <div class="fld"><label class="check"><input type="checkbox" name="aktywna"${s.aktywna ? " checked" : ""}><span>Aktywna online</span></label></div></div>
      <div class="row2">
        <div class="fld"><label for="s${s.id}-z">Kwota zaliczki (zł)</label><input id="s${s.id}-z" type="number" name="zaliczka" min="0" max="10000" step="0.01" value="${(s.zaliczka / 100).toFixed(2)}"></div>
        <div class="fld adm-pad"><label class="check"><input type="checkbox" name="zaliczkaWymagana"${s.zaliczkaWymagana ? " checked" : ""}><span>Wymagaj zaliczki</span></label></div>
      </div>
      ${s.terminy ? `<fieldset class="fld"><legend>Stanowiska</legend><div class="chips">${res}</div></fieldset>
      <details class="adm-dur"><summary>Czas trwania wizyty</summary>
        <p class="fld__hint">Czas = czas bazowy + minuty za wybrane opcje. Klient widzi tylko godziny, w których cała wizyta się mieści.</p>
        <div class="fld"><label for="s${s.id}-b">Czas bazowy (min)</label><input id="s${s.id}-b" type="number" name="czasBazowy" min="0" max="480" step="5" value="${s.czasBazowy}"></div>
        <table class="adm-dur__t">${dur}</table>
        <button class="adm-link" type="button" data-reset-dur>Przywróć domyślne czasy</button>
      </details>` : ""}
      <div class="adm-actions"><button class="btn btn--blue" type="submit">Zapisz</button><p class="adm-msg" aria-live="polite"></p></div>
    </form>`;
    }).join("");

    $$("[data-svc]", box).forEach((f) => {
      const id = Number(f.dataset.svc);
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const msg = $(".adm-msg", f);
        const body = { aktywna: f.aktywna.checked, zaliczkaWymagana: f.zaliczkaWymagana.checked,
          zaliczka: Math.round(Number(String(f.zaliczka.value).replace(",", ".")) * 100) };
        if (f.czasBazowy) {
          body.czasBazowy = Number(f.czasBazowy.value);
          body.stanowiska = $$('input[name="stanowiska"]:checked', f).map((i) => Number(i.value));
          body.czasy = {};
          $$("[data-f]", f).forEach((i) => { (body.czasy[i.dataset.f] = body.czasy[i.dataset.f] || {})[i.dataset.o] = Number(i.value) || 0; });
        }
        try {
          const { usluga } = await api("uslugi/" + id, { method: "PATCH", body });
          state.services = state.services.map((s) => (s.id === usluga.id ? usluga : s));
          say(msg, "Zapisano.");
          const t = typical(usluga);
          const p = $(".adm-svc__head p", f);
          if (usluga.terminy) p.textContent = `Wizyta: zwykle ${t.min === t.max ? t.t : t.min + "–" + t.max} min`;
        } catch (err) { say(msg, err.message, true); }
      });
      const reset = $("[data-reset-dur]", f);
      reset && reset.addEventListener("click", async () => {
        if (!confirm("Przywrócić domyślne czasy z pliku ustawień? Obecne czasy tej usługi zostaną zastąpione.")) return;
        try {
          const { usluga } = await api(`uslugi/${id}/domyslne-czasy`, { method: "POST" });
          state.services = state.services.map((s) => (s.id === usluga.id ? usluga : s));
          renderServices();
          toast("Przywrócono domyślne czasy", " " + usluga.nazwa);
        } catch (err) { toast("Błąd", err.message); }
      });
    });
    renderResources();
  }

  function renderResources() {
    $("[data-res-list]").innerHTML = state.resources.map((r) => `<li data-res-id="${r.id}"><form class="bform adm-res" novalidate>
      <input type="text" name="nazwa" value="${esc(r.nazwa)}" maxlength="60" aria-label="Nazwa stanowiska">
      <label class="check"><input type="checkbox" name="aktywne"${r.aktywne ? " checked" : ""}><span>aktywne</span></label>
      <small>${esc(r.uslugi.map((id) => (svcById(id) || {}).nazwa).filter(Boolean).join(", ") || "nie przypisane do usługi")}</small>
      <button class="btn btn--ghost" type="submit">Zapisz</button><button class="adm-link" type="button" data-del-res>Usuń</button></form></li>`).join("");
    $$("[data-res-id]").forEach((li) => {
      const id = li.dataset.resId, f = $("form", li);
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        try { ({ stanowiska: state.resources } = await api("stanowiska/" + id, { method: "PATCH", body: { nazwa: f.nazwa.value, aktywne: f.aktywne.checked } })); toast("Zapisano stanowisko", " " + f.nazwa.value); }
        catch (err) { toast("Błąd", err.message); }
      });
      $("[data-del-res]", li).addEventListener("click", async () => {
        if (!confirm("Usunąć to stanowisko?")) return;
        try { ({ stanowiska: state.resources } = await api("stanowiska/" + id, { method: "DELETE" })); await loadMeta(); renderServices(); }
        catch (err) { toast("Nie usunięto", " " + err.message); }
      });
    });
    $("[data-res-svcs]").innerHTML = slotServices().map((s) => `<label class="chip"><input type="checkbox" name="uslugi" value="${s.id}"><span>${esc(s.nazwa)}</span></label>`).join("");
  }

  $("[data-res-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, msg = $(".adm-msg", f);
    try {
      await api("stanowiska", { method: "POST", body: { nazwa: f.nazwa.value, uslugi: $$('input[name="uslugi"]:checked', f).map((i) => Number(i.value)) } });
      f.reset();
      await loadMeta();
      renderServices();
      say($(".adm-msg", $("[data-res-form]")), "Dodano.");
    } catch (err) { say(msg, err.message, true); }
  });

  /* ---------- Powiadomienia (polling co 20 s) ---------- */
  const bell = $("[data-bell]");
  const pop = $("[data-bell-pop]");
  bell.addEventListener("click", () => {
    pop.hidden = !pop.hidden;
    bell.setAttribute("aria-expanded", String(!pop.hidden));
  });
  document.addEventListener("click", (e) => { if (!pop.hidden && !e.target.closest(".adm-bell")) { pop.hidden = true; bell.setAttribute("aria-expanded", "false"); } });
  $("[data-bell-all]").addEventListener("click", async () => renderNotifications(await api("powiadomienia/przeczytane", { method: "POST", body: { wszystkie: true } })));

  const NOTIF = { booking_confirmed: "Nowa rezerwacja", booking_cancelled: "Rezerwacja anulowana" };
  function renderNotifications(n) {
    const badge = $("[data-bell-n]");
    badge.hidden = !n.nieprzeczytane;
    badge.textContent = n.nieprzeczytane > 99 ? "99+" : String(n.nieprzeczytane);
    bell.setAttribute("aria-label", n.nieprzeczytane ? `Powiadomienia: ${n.nieprzeczytane} nieprzeczytanych` : "Powiadomienia");
    const list = $("[data-bell-list]");
    list.innerHTML = n.lista.length ? n.lista.map((x) => `<li class="${x.przeczytane ? "" : "is-unread"}"><button type="button" data-n="${esc(x.id)}" data-b="${esc(x.rezerwacja)}">
        <b>${esc(NOTIF[x.typ] || x.typ)}: ${esc(x.usluga)}</b><span>${esc(x.klient)}${x.data ? " · " + esc(shortDay(x.data)) + ", " + esc(x.godzina) : ""}</span><small>${esc(dateTime(x.utworzono))}</small></button></li>`).join("")
      : '<li class="adm-pop__empty">Brak powiadomień.</li>';
    $$("[data-n]", list).forEach((b) => b.addEventListener("click", async () => {
      pop.hidden = true;
      api("powiadomienia/przeczytane", { method: "POST", body: { ids: [Number(b.dataset.n)] } }).then(renderNotifications).catch(() => {});
      openBooking(b.dataset.b);
    }));
  }

  async function pollNotifications(first) {
    let n;
    try { n = await api("powiadomienia"); } catch (e) { return; }
    renderNotifications(n);
    const newest = n.lista.reduce((m, x) => Math.max(m, Number(x.id)), 0);
    if (!first && state.lastNotif !== null) {
      n.lista.filter((x) => Number(x.id) > state.lastNotif && !x.przeczytane).reverse().forEach((x) => {
        toast(`${NOTIF[x.typ] || x.typ}: ${x.usluga}`, ` ${x.klient}${x.data ? ", " + shortDay(x.data) + " " + x.godzina : ""}`, () => openBooking(x.rezerwacja));
      });
      if (newest > state.lastNotif && (state.panel === "rezerwacje" || state.panel === "kalendarz")) refreshPanel();
    }
    state.lastNotif = Math.max(state.lastNotif || 0, newest);
  }

  /* ---------- Start ---------- */
  start().catch((e) => { if (e.status !== 401) { showLogin(); showMsg($("[data-login-msg]"), e.message); } });
})();

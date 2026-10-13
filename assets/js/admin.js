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
  const dow = (ymd) => new Date(ymd + "T12:00:00Z").getUTCDay();
  const mondayOf = (ymd) => addDays(ymd, -((dow(ymd) + 6) % 7));
  const dayFmt = (ymd, opts) => new Date(ymd + "T12:00:00Z").toLocaleDateString("pl-PL", { timeZone: "UTC", ...opts });
  const shortDay = (ymd) => dayFmt(ymd, { weekday: "short", day: "numeric", month: "2-digit" });
  const longDay = (ymd) => dayFmt(ymd, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const dateTime = (iso) => iso ? new Date(iso).toLocaleString("pl-PL", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }) : "";
  const zl = (gr) => (gr / 100).toLocaleString("pl-PL", { style: "currency", currency: "PLN" });
  const phoneFmt = (p) => String(p || "").replace(/^\+48(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3");

  const STATUS = { pending_payment: "Czeka na płatność", confirmed: "Potwierdzona", expired: "Wygasła", cancelled: "Anulowana" };
  const PAY = { pending: "Oczekuje", succeeded: "Opłacona", failed: "Nieudana", expired: "Wygasła", refunded: "Zwrócona" };
  const LABELS = { pojazd: "Pojazd", badanie: "Badanie", pakiet: "Pakiet", zakres: "Zakres", dodatkowo: "Dodatkowo", sprawa: "Sprawa",
    ubezpieczenie: "Ubezpieczenie", polisa: "Polisa", data: "Kiedy oddzwonić", pora: "Pora dnia", marka: "Marka i model",
    rejestracja: "Nr rejestracyjny", opis: "Opis", problem: "Opis problemu" };
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

  /* ---------- Widoki: logowanie / aplikacja ---------- */
  const state = { services: [], tab: "", panel: "rezerwacje", week: mondayOf(today()), graf: null, selected: new Set(), slots: [], lastNotif: null, timer: null };

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
      msg.textContent = err.message;
      msg.hidden = false;
    } finally { btn.disabled = false; }
  });

  $("[data-logout]").addEventListener("click", async () => {
    await api("logout", { method: "POST" }).catch(() => {});
    showLogin();
  });

  async function start() {
    const me = await api("me");
    $("[data-user]").textContent = me.admin;
    $("[data-mode]").hidden = me.trybPlatnosci !== "mock";
    $("[data-view=login]").hidden = true;
    $("[data-view=app]").hidden = false;
    const { uslugi } = await api("uslugi");
    state.services = uslugi;
    renderTabs();
    renderGrafSelect();
    route();
    pollNotifications(true);
    clearInterval(state.timer);
    state.timer = setInterval(() => pollNotifications(false), 20000);
  }

  /* ---------- Nawigacja ---------- */
  function route() {
    const p = (location.hash || "#rezerwacje").slice(1);
    state.panel = ["rezerwacje", "grafik", "uslugi"].includes(p) ? p : "rezerwacje";
    $$("[data-panel]").forEach((s) => { s.hidden = s.dataset.panel !== state.panel; });
    $$("[data-nav]").forEach((a) => { if (a.dataset.nav === state.panel) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    if (state.panel === "rezerwacje") loadBookings();
    if (state.panel === "grafik") loadWeek();
    if (state.panel === "uslugi") renderServices();
  }
  window.addEventListener("hashchange", route);

  /* ---------- Rezerwacje ---------- */
  const filters = $("[data-filters]");
  const resetFilters = () => { filters.od.value = today(); filters.do.value = ""; filters.status.value = ""; };
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
    return `<b>${esc(shortDay(r.data))}, ${esc(r.godzina)}</b>`;
  };
  const payCell = (p) => (p ? `${pill(p.status, PAY[p.status] || p.status)}<small>${esc(zl(p.kwota))}${p.dostawca === "mock" ? " · test" : ""}</small>` : '<small>bez zaliczki</small>');

  async function loadBookings() {
    const q = new URLSearchParams();
    if (state.tab) q.set("usluga", state.tab);
    if (filters.od.value) q.set("od", filters.od.value);
    if (filters.do.value) q.set("do", filters.do.value);
    if (filters.status.value) q.set("status", filters.status.value);
    const tbody = $("[data-bookings]");
    let list;
    try { ({ rezerwacje: list } = await api("rezerwacje?" + q)); } catch (e) { if (e.status !== 401) toast("Błąd", e.message); return; }
    tbody.innerHTML = list.map((r) => `<tr tabindex="0" data-id="${esc(r.id)}">
      <td>${whenCell(r)}</td><td>${esc(r.uslugaNazwa)}</td>
      <td><b>${esc(r.klient)}</b>${r.email ? `<small>${esc(r.email)}</small>` : ""}</td>
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
        ["Termin", r.kontakt ? "prośba o kontakt (bez terminu)" : `${longDay(r.data)}, ${r.godzina}–${r.godzinaDo}`],
        ["Klient", r.klient],
        ["Telefon", `<a href="tel:${esc(r.telefon)}">${esc(phoneFmt(r.telefon))}</a>`, true],
        ["E-mail", r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : "", true],
        ...detailRows,
      ])}
      <h3>Historia</h3>
      ${dl([
        ["Utworzono", dateTime(r.utworzono)],
        ["Zgoda RODO", dateTime(r.zgoda)],
        ["Potwierdzono", dateTime(r.potwierdzono)],
        ["Hold do", r.status === "pending_payment" ? dateTime(r.holdDo) : ""],
        ["Anulowano", r.anulowano ? `${dateTime(r.anulowano)} (${r.anulowal || "?"})` : ""],
        ["Powód anulowania", r.powod],
        ["Płatności", pays ? `<ul>${pays}</ul>` : "", true],
      ])}`;
    $("[data-b-cancel]").hidden = !(r.status === "confirmed" || r.status === "pending_payment");
    if (!dlgB.open) dlgB.showModal();
  }

  $("[data-b-cancel]").addEventListener("click", () => {
    if (!current) return;
    const paid = current.platnosci.find((p) => p.id === current.aktywnaPlatnosc && p.status === "succeeded");
    $("[data-c-who]").textContent = `${current.uslugaNazwa}, ${current.kontakt ? "prośba o kontakt" : longDay(current.data) + ", " + current.godzina} – ${current.klient}. Termin wróci do puli wolnych godzin.`;
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
      if (state.panel === "rezerwacje") loadBookings();
      if (state.panel === "grafik") loadWeek();
    } catch (err) {
      const m = $("[data-c-msg]"); m.textContent = err.message; m.hidden = false;
    } finally { btn.disabled = false; }
  });

  /* ---------- Grafik ---------- */
  const grafSel = $("#g-svc");
  function renderGrafSelect() {
    const withSlots = state.services.filter((s) => s.terminy);
    grafSel.innerHTML = withSlots.map((s) => `<option value="${s.id}">${esc(s.nazwa)}</option>`).join("");
    state.graf = state.graf && withSlots.some((s) => s.id === state.graf) ? state.graf : (withSlots[0] || {}).id;
    grafSel.value = String(state.graf);
    syncGenDefaults();
  }
  grafSel.addEventListener("change", () => { state.graf = Number(grafSel.value); state.selected.clear(); syncGenDefaults(); loadWeek(); });
  $$("[data-week]").forEach((b) => b.addEventListener("click", () => {
    state.week = addDays(state.week, 7 * Number(b.dataset.week));
    state.selected.clear();
    loadWeek();
  }));

  async function loadWeek() {
    if (!state.graf) return;
    const from = state.week;
    $("[data-week-label]").textContent = `${dayFmt(from, { day: "numeric", month: "short" })} – ${dayFmt(addDays(from, 6), { day: "numeric", month: "short", year: "numeric" })}`;
    try { ({ sloty: state.slots } = await api(`sloty?usluga=${state.graf}&od=${from}&dni=7`)); } catch (e) { if (e.status !== 401) toast("Błąd", e.message); return; }
    renderWeek();
  }

  function renderWeek() {
    const grid = $("[data-week-grid]");
    const t = today();
    let html = "";
    for (let i = 0; i < 7; i++) {
      const day = addDays(state.week, i);
      const slots = state.slots.filter((s) => s.data === day);
      const allBlocked = slots.length && slots.every((s) => s.zablokowany);
      html += `<div class="adm-day"><div class="adm-day__h${day === t ? " is-today" : ""}"><b>${esc(dayFmt(day, { weekday: "short" }))}</b>${esc(dayFmt(day, { day: "numeric", month: "2-digit" }))}
        ${slots.length ? `<button class="adm-link" type="button" data-day="${day}" data-block="${allBlocked ? "0" : "1"}">${allBlocked ? "Odblokuj dzień" : "Zablokuj dzień"}</button>` : ""}</div>
        ${slots.length ? slots.map((s) => {
          const cls = [s.zablokowany && "is-blocked", s.potwierdzone && "is-booked", !s.potwierdzone && s.wstrzymane && "is-held", s.przeszly && "is-past"].filter(Boolean).join(" ");
          const used = s.potwierdzone + s.wstrzymane;
          return `<button class="adm-slot ${cls}" type="button" data-slot="${s.id}" aria-pressed="${state.selected.has(s.id)}"
            title="${esc(s.godzina)}–${esc(s.godzinaDo)} · zajęte ${used}/${s.pojemnosc}${s.zablokowany ? " · zablokowany" : ""}">${esc(s.godzina)}<small>${used}/${s.pojemnosc}</small></button>`;
        }).join("") : '<p class="adm-day__none">brak slotów</p>'}</div>`;
    }
    grid.innerHTML = html;
    $$("[data-slot]", grid).forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.slot;
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      b.setAttribute("aria-pressed", String(state.selected.has(id)));
      renderSel();
    }));
    $$("[data-day]", grid).forEach((b) => b.addEventListener("click", async () => {
      try {
        await api("sloty/blokada", { method: "POST", body: { usluga: state.graf, dzien: b.dataset.day, zablokuj: b.dataset.block === "1" } });
        loadWeek();
      } catch (e) { toast("Błąd", e.message); }
    }));
    renderSel();
  }

  function renderSel() {
    const bar = $("[data-sel]");
    const n = state.selected.size;
    bar.hidden = !n;
    $("[data-sel-n]").textContent = n === 1 ? "Zaznaczono 1 slot" : `Zaznaczono slotów: ${n}`;
  }

  $$("[data-sel-act]").forEach((b) => b.addEventListener("click", async () => {
    const act = b.dataset.selAct;
    const ids = [...state.selected];
    if (act === "clear") { state.selected.clear(); renderWeek(); return; }
    try {
      if (act === "block" || act === "unblock") {
        await api("sloty/blokada", { method: "POST", body: { ids, zablokuj: act === "block" } });
      } else if (act === "delete") {
        if (!confirm(`Usunąć zaznaczone sloty (${ids.length})? Sloty z rezerwacjami zostaną – można je tylko zablokować.`)) return;
        const errors = [];
        for (const id of ids) await api("sloty/" + id, { method: "DELETE" }).catch((e) => errors.push(e.message));
        if (errors.length) toast(`Nie usunięto slotów: ${errors.length}`, " " + errors[0]);
      }
      state.selected.clear();
      loadWeek();
    } catch (e) { toast("Błąd", e.message); }
  }));

  const gen = $("[data-gen]");
  function syncGenDefaults() {
    const s = state.services.find((x) => x.id === state.graf);
    if (s) gen.dlugosc.value = s.dlugoscSlotu;
    if (!gen.od.value) gen.od.value = today();
    if (!gen.do.value) gen.do.value = addDays(today(), 13);
  }
  gen.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("[data-gen-msg]");
    msg.classList.remove("is-err");
    msg.textContent = "";
    const btn = $("button[type=submit]", gen);
    btn.disabled = true;
    try {
      const out = await api("sloty/generuj", { method: "POST", body: {
        usluga: state.graf, od: gen.od.value, do: gen.do.value, dni: $$('input[name="dni"]:checked', gen).map((i) => Number(i.value)),
        godzinaOd: gen.godzinaOd.value, godzinaDo: gen.godzinaDo.value, dlugosc: Number(gen.dlugosc.value), pojemnosc: Number(gen.pojemnosc.value),
      } });
      msg.textContent = out.utworzono ? `Dodano slotów: ${out.utworzono}.` : "Nie dodano nowych slotów – w tym zakresie już istnieją.";
      if (gen.od.value) state.week = mondayOf(gen.od.value < today() ? today() : gen.od.value);
      loadWeek();
    } catch (err) {
      msg.textContent = err.message;
      msg.classList.add("is-err");
    } finally { btn.disabled = false; }
  });

  /* ---------- Ustawienia usług ---------- */
  function renderServices() {
    const box = $("[data-services]");
    box.innerHTML = state.services.map((s) => `<form class="bform adm-card adm-svc" data-svc="${s.id}" novalidate>
      <div class="adm-svc__head"><div><h2>${esc(s.nazwa)}</h2><p>${s.terminy ? "Rezerwacja terminu" : "Prośba o kontakt – bez terminów"}</p></div>
      <div class="fld"><label class="check"><input type="checkbox" name="aktywna"${s.aktywna ? " checked" : ""}><span>Aktywna online</span></label></div></div>
      <div class="row2">
        <div class="fld"><label for="s${s.id}-z">Kwota zaliczki (zł)</label><input id="s${s.id}-z" type="number" name="zaliczka" min="0" max="10000" step="0.01" value="${(s.zaliczka / 100).toFixed(2)}"></div>
        <div class="fld"><label for="s${s.id}-d">Długość slotu (min)</label><input id="s${s.id}-d" type="number" name="dlugoscSlotu" min="5" max="480" step="5" value="${s.dlugoscSlotu}"${s.terminy ? "" : " disabled"}></div>
      </div>
      <div class="fld"><label class="check"><input type="checkbox" name="zaliczkaWymagana"${s.zaliczkaWymagana ? " checked" : ""}><span>Wymagaj zaliczki przy rezerwacji</span></label></div>
      ${s.terminy ? '<p class="fld__hint">Nowa długość slotu dotyczy slotów dodanych od teraz – istniejące zostają bez zmian.</p>' : ""}
      <div class="adm-actions"><button class="btn btn--blue" type="submit">Zapisz</button><p class="adm-msg" aria-live="polite"></p></div>
    </form>`).join("");
    $$("[data-svc]", box).forEach((f) => f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $(".adm-msg", f);
      msg.classList.remove("is-err");
      msg.textContent = "";
      const body = {
        aktywna: f.aktywna.checked, zaliczkaWymagana: f.zaliczkaWymagana.checked,
        zaliczka: Math.round(Number(String(f.zaliczka.value).replace(",", ".")) * 100),
      };
      if (!f.dlugoscSlotu.disabled) body.dlugoscSlotu = Number(f.dlugoscSlotu.value);
      try {
        const { usluga } = await api("uslugi/" + f.dataset.svc, { method: "PATCH", body });
        state.services = state.services.map((s) => (s.id === usluga.id ? usluga : s));
        msg.textContent = "Zapisano.";
        syncGenDefaults();
      } catch (err) {
        msg.textContent = err.message;
        msg.classList.add("is-err");
        const { uslugi } = await api("uslugi").catch(() => ({ uslugi: state.services }));
        state.services = uslugi;
      }
    }));
  }

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
      if (newest > state.lastNotif && state.panel === "rezerwacje") loadBookings();
    }
    state.lastNotif = Math.max(state.lastNotif || 0, newest);
  }

  /* ---------- Start ---------- */
  start().catch((e) => { if (e.status !== 401) { showLogin(); const m = $("[data-login-msg]"); m.textContent = e.message; m.hidden = false; } });
})();

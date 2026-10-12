/* Amigos Staweccy – skrypty strony (bez zależności) */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const body = document.body;

  /* ---------- Czas w Polsce (niezależnie od strefy urządzenia) ---------- */
  const nowPL = () => {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(new Date());
    const g = (t) => (p.find((x) => x.type === t) || {}).value;
    const ymd = `${g("year")}-${g("month")}-${g("day")}`;
    return { ymd, minutes: +g("hour") * 60 + +g("minute"), dow: new Date(ymd + "T12:00:00Z").getUTCDay() };
  };
  const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dowOf = (ymd) => new Date(ymd + "T12:00:00Z").getUTCDay();
  const plDate = (ymd) => new Date(ymd + "T12:00:00Z").toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

  let HOURS = {};
  try { HOURS = JSON.parse(body.dataset.hours || "{}"); } catch (e) { HOURS = {}; }
  const SLOT = +body.dataset.slot || 30;
  const AHEAD = +body.dataset.ahead || 60;
  const now = nowPL();

  /* ---------- Nagłówek i menu ---------- */
  const hdr = $("[data-hdr]");
  const mbar = $("[data-mbar]");
  const onScroll = () => {
    const y = window.scrollY;
    hdr && hdr.classList.toggle("is-scrolled", y > 8);
    mbar && mbar.classList.toggle("is-on", y > 420);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const burger = $("[data-burger]");
  const nav = $("#nav");
  const setMenu = (open) => {
    if (!burger || !nav) return;
    burger.setAttribute("aria-expanded", String(open));
    burger.setAttribute("aria-label", open ? "Zamknij menu" : "Otwórz menu");
    nav.classList.toggle("is-open", open);
    document.documentElement.style.overflow = open ? "hidden" : "";
  };
  burger && burger.addEventListener("click", () => setMenu(burger.getAttribute("aria-expanded") !== "true"));
  nav && nav.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });
  window.matchMedia("(min-width: 1021px)").addEventListener("change", (m) => m.matches && setMenu(false));

  /* ---------- Rok, promocje, dzisiejszy dzień, status otwarcia ---------- */
  $$("[data-year]").forEach((el) => (el.textContent = now.ymd.slice(0, 4)));
  $$("[data-until]").forEach((el) => { el.hidden = now.ymd > el.dataset.until; });
  $$(`tr[data-day="${now.dow}"]`).forEach((tr) => tr.classList.add("is-today"));

  $$("[data-open-status]").forEach((el) => {
    const txt = $("[data-open-text]", el);
    const today = HOURS[now.dow];
    if (today && now.minutes >= toMin(today[0]) && now.minutes < toMin(today[1])) {
      el.classList.add("is-open");
      txt.textContent = `Otwarte teraz, do ${today[1]}`;
    } else {
      el.classList.add("is-closed");
      let next = null;
      for (let i = 0; i < 8 && !next; i++) {
        const d = (now.dow + i) % 7, h = HOURS[d];
        if (h && (i > 0 || now.minutes < toMin(h[0]))) next = { i, d, h };
      }
      const names = ["w niedzielę", "w poniedziałek", "we wtorek", "w środę", "w czwartek", "w piątek", "w sobotę"];
      txt.textContent = next
        ? `Teraz zamknięte, otwieramy ${next.i === 0 ? "dziś" : next.i === 1 ? "jutro" : names[next.d]} o ${next.h[0]}`
        : "Teraz zamknięte";
    }
  });

  /* ---------- Mapa ładowana po kliknięciu (szybkość + prywatność) ---------- */
  $$("[data-map]").forEach((box) => {
    const btn = $(".map__btn", box);
    btn && btn.addEventListener("click", () => {
      const f = document.createElement("iframe");
      f.src = box.dataset.map;
      f.title = "Mapa dojazdu do Amigos Staweccy";
      f.loading = "lazy";
      f.referrerPolicy = "no-referrer-when-downgrade";
      f.allowFullscreen = true;
      box.replaceChildren(f);
    });
  });

  /* ---------- Zakładki rezerwacji ---------- */
  $$("[data-tabs]").forEach((root) => {
    const tabs = $$('[role="tab"]', root);
    const select = (tab, focus) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        const p = document.getElementById(t.getAttribute("aria-controls"));
        if (p) p.hidden = !on;
      });
      if (focus) tab.focus();
      tab.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    };
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => {
        select(t);
        const url = new URL(location.href);
        url.searchParams.set("usluga", t.dataset.tab);
        history.replaceState(null, "", url.pathname + url.search + url.hash);
      });
      t.addEventListener("keydown", (e) => {
        let n = null;
        if (e.key === "ArrowRight") n = tabs[(i + 1) % tabs.length];
        if (e.key === "ArrowLeft") n = tabs[(i - 1 + tabs.length) % tabs.length];
        if (e.key === "Home") n = tabs[0];
        if (e.key === "End") n = tabs[tabs.length - 1];
        if (n) { e.preventDefault(); select(n, true); }
      });
    });
    const want = new URLSearchParams(location.search).get("usluga");
    const pre = want && tabs.find((t) => t.dataset.tab === want);
    if (pre) {
      select(pre);
      if (location.pathname === "/" || location.pathname === "/index.html") {
        requestAnimationFrame(() => root.scrollIntoView({ block: "start" }));
      }
    }
  });
  // Linki "Umów" na stronie głównej przełączają zakładkę bez przeładowania
  $$('a[href^="/rezerwacja?usluga="]').forEach((a) => {
    a.addEventListener("click", (e) => {
      const tabsRoot = $("[data-tabs]");
      if (!tabsRoot) return;
      const slug = new URL(a.href).searchParams.get("usluga");
      const tab = $(`[data-tab="${slug}"]`, tabsRoot);
      if (!tab) return;
      e.preventDefault();
      tab.click();
      tabsRoot.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    });
  });

  /* ---------- Formularze ---------- */
  const PHONE_RE = /^(\+?48)?\d{9}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const MSG = {
    req: "To pole jest wymagane.",
    chips: "Wybierz jedną z opcji.",
    phone: "Podaj 9-cyfrowy numer telefonu, np. 600 100 200.",
    email: "Sprawdź adres e-mail – brakuje @ albo domeny.",
    name: "Podaj imię (co najmniej 2 litery).",
    date: "Wybierz dzień, w którym jesteśmy otwarci.",
    past: "Ten dzień już minął – wybierz późniejszy.",
    far: `Rezerwujemy maksymalnie ${AHEAD} dni do przodu.`,
    sunday: "W niedzielę jesteśmy zamknięci – wybierz inny dzień.",
    consent: "Zaznacz zgodę, żebyśmy mogli oddzwonić.",
  };

  const slotsFor = (ymd) => {
    const h = HOURS[dowOf(ymd)];
    if (!h) return [];
    let start = toMin(h[0]);
    const end = toMin(h[1]) - SLOT;
    if (ymd === now.ymd) start = Math.max(start, Math.ceil((now.minutes + 60) / SLOT) * SLOT);
    const out = [];
    for (let m = start; m <= end; m += SLOT) out.push(fmt(m));
    return out;
  };

  const setErr = (wrap, msg) => {
    if (!wrap) return;
    const p = $(".fld__err", wrap);
    if (p) p.textContent = msg || "";
    $$("input,select,textarea", wrap).forEach((i) => i.type !== "radio" && i.type !== "checkbox" && i.setAttribute("aria-invalid", msg ? "true" : "false"));
    wrap.toggleAttribute("data-invalid", !!msg);
  };

  $$("[data-form]").forEach((form) => {
    const ts = $("[data-ts]", form);
    if (ts) ts.value = String(Date.now());

    // Daty: od dziś do +AHEAD dni
    $$("[data-date]", form).forEach((inp) => {
      inp.min = now.ymd;
      inp.max = addDays(now.ymd, AHEAD);
    });

    const dateInp = $("[data-date]:not([data-optional])", form);
    const slotSel = $("[data-slots]", form);
    const fillSlots = () => {
      if (!dateInp || !slotSel) return;
      const v = dateInp.value;
      const prev = slotSel.value;
      slotSel.replaceChildren();
      const add = (val, label) => { const o = document.createElement("option"); o.value = val; o.textContent = label; slotSel.append(o); return o; };
      if (!v) { add("", "Najpierw wybierz dzień"); slotSel.disabled = true; return; }
      const list = slotsFor(v);
      if (!list.length) {
        add("", dowOf(v) === 0 ? "Niedziela – zamknięte" : "Brak wolnych godzin tego dnia");
        slotSel.disabled = true;
        return;
      }
      slotSel.disabled = false;
      add("", "Wybierz godzinę");
      list.forEach((t) => add(t, t));
      if (list.includes(prev)) slotSel.value = prev;
    };
    dateInp && dateInp.addEventListener("change", () => { fillSlots(); validateDate(dateInp); });

    const validateDate = (inp) => {
      const wrap = inp.closest(".fld");
      const v = inp.value;
      if (!v) { setErr(wrap, inp.required ? MSG.date : ""); return !inp.required; }
      if (v < now.ymd) { setErr(wrap, MSG.past); return false; }
      if (v > addDays(now.ymd, AHEAD)) { setErr(wrap, MSG.far); return false; }
      if (!HOURS[dowOf(v)]) { setErr(wrap, MSG.sunday); return false; }
      if (!inp.hasAttribute("data-optional") && !slotsFor(v).length) { setErr(wrap, "Dziś nie zdążymy – wybierz jutro lub kolejny dzień."); return false; }
      setErr(wrap, "");
      return true;
    };

    // Numer rejestracyjny wielkimi literami, telefon tylko cyfry/spacje/+
    $$("[data-upper]", form).forEach((i) => i.addEventListener("input", () => { i.value = i.value.toUpperCase(); }));
    const phone = $('input[name="telefon"]', form);
    phone && phone.addEventListener("input", () => { phone.value = phone.value.replace(/[^\d+ ()-]/g, ""); });

    const checkField = (el) => {
      const wrap = el.closest(".fld");
      const v = (el.value || "").trim();
      if (el.name === "imie") { setErr(wrap, v.length >= 2 ? "" : v ? MSG.name : MSG.req); return v.length >= 2; }
      if (el.name === "telefon") {
        const d = v.replace(/[\s()-]/g, "");
        const ok = PHONE_RE.test(d);
        setErr(wrap, ok ? "" : v ? MSG.phone : MSG.req); return ok;
      }
      if (el.name === "email") { const ok = !v || EMAIL_RE.test(v); setErr(wrap, ok ? "" : MSG.email); return ok; }
      if (el.matches("[data-date]")) return validateDate(el);
      if (el.matches("[data-slots]")) { setErr(wrap, el.value ? "" : "Wybierz godzinę."); return !!el.value; }
      if (el.name === "zgoda") { setErr(wrap, el.checked ? "" : MSG.consent); return el.checked; }
      return true;
    };

    // Walidacja „na żywo” dopiero po pierwszym opuszczeniu pola
    $$("input:not([type=radio]):not([type=checkbox]):not([type=hidden]),select,textarea", form).forEach((el) => {
      el.addEventListener("blur", () => { if (el.value) { el.dataset.touched = "1"; checkField(el); } });
      el.addEventListener("input", () => { if (el.dataset.touched) checkField(el); });
    });
    $$('input[type="radio"]', form).forEach((r) => r.addEventListener("change", () => setErr(r.closest(".fld"), "")));
    const consent = $('input[name="zgoda"]', form);
    consent && consent.addEventListener("change", () => checkField(consent));

    const validate = () => {
      let ok = true;
      let first = null;
      const fail = (el) => { ok = false; first = first || el; };
      // grupy radio (wymagane)
      $$("fieldset.fld", form).forEach((fs) => {
        const req = $('input[type="radio"][required]', fs);
        if (!req) return;
        const picked = $('input[type="radio"]:checked', fs);
        setErr(fs, picked ? "" : MSG.chips);
        if (!picked) fail(req);
      });
      if (dateInp && !validateDate(dateInp)) fail(dateInp);
      if (slotSel && slotSel.required && !(dateInp && !dateInp.value)) {
        if (!slotSel.value) { setErr(slotSel.closest(".fld"), "Wybierz godzinę."); fail(slotSel); }
      }
      $$("[data-date][data-optional]", form).forEach((i) => { if (!validateDate(i)) fail(i); });
      ["imie", "telefon", "email"].forEach((n) => { const el = $(`[name="${n}"]`, form); if (el && !checkField(el)) fail(el); });
      if (consent && !checkField(consent)) fail(consent);
      if (first) {
        first.focus({ preventScroll: true });
        first.closest(".fld").scrollIntoView({ block: "center", behavior: "smooth" });
      }
      return ok;
    };

    const msgBox = $(".bform__msg", form);
    const btn = $('button[type="submit"]', form);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (msgBox) msgBox.hidden = true;
      if (!validate()) return;

      const fd = new FormData(form);
      const data = {};
      fd.forEach((v, k) => {
        if (k.endsWith("[]")) { const kk = k.slice(0, -2); (data[kk] = data[kk] || []).push(v); }
        else data[k] = typeof v === "string" ? v.trim() : v;
      });
      data.zgoda = !!(consent && consent.checked);

      const label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spin" aria-hidden="true"></span><span>Wysyłanie…</span>';
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const res = await fetch(form.action, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(data),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) throw new Error(json.error || "Nie udało się wysłać zgłoszenia.");
        btn.disabled = false;
        btn.innerHTML = label;
        showDone(form, data);
      } catch (err) {
        const ph = form.dataset.phone;
        if (msgBox) {
          msgBox.textContent = `${err.name === "AbortError" ? "Serwer nie odpowiada." : err.message} Spróbuj ponownie albo zadzwoń: ${ph}.`;
          msgBox.hidden = false;
        }
        btn.disabled = false;
        btn.innerHTML = label;
      }
    });
  });

  function showDone(form, d) {
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const rows = [];
    if (d.data) rows.push(["Termin", `${plDate(d.data)}${d.godzina ? ", " + d.godzina : ""}${d.pora && d.pora !== "Obojętnie" ? ", " + d.pora.toLowerCase() : ""}`]);
    rows.push(["Telefon", d.telefon]);
    if (d.email) rows.push(["E-mail", d.email]);
    const box = document.createElement("div");
    box.className = "done";
    box.setAttribute("tabindex", "-1");
    box.innerHTML = `
      <div class="done__ic"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></div>
      <h3>${esc(form.dataset.done || "Zgłoszenie wysłane")}</h3>
      <p>Dziękujemy${d.imie ? ", " + esc(d.imie) : ""}! Oddzwonimy, żeby potwierdzić szczegóły – zwykle tego samego dnia w godzinach pracy.</p>
      <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      <button type="button" class="btn btn--ghost">Wyślij kolejne zgłoszenie</button>`;
    form.hidden = true;
    form.after(box);
    box.focus({ preventScroll: true });
    box.scrollIntoView({ block: "center", behavior: "smooth" });
    $("button", box).addEventListener("click", () => {
      form.reset();
      $$("[data-slots]", form).forEach((s) => { s.replaceChildren(new Option("Najpierw wybierz dzień", "")); s.disabled = true; });
      const ts = $("[data-ts]", form); if (ts) ts.value = String(Date.now());
      box.remove();
      form.hidden = false;
    });
  }
})();

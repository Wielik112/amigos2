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
  const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dowOf = (ymd) => new Date(ymd + "T12:00:00Z").getUTCDay();
  const plDate = (ymd) => new Date(ymd + "T12:00:00Z").toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

  let HOURS = {};
  try { HOURS = JSON.parse(body.dataset.hours || "{}"); } catch (e) { HOURS = {}; }
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

  /* ---------- Telefon: bramy otwierają się po kolei, karuzela usług idzie razem z nimi ---------- */
  const svcar = $("[data-svcar]");
  if (svcar) {
    const track = $(".svcar__track", svcar);
    const cards = $$("[data-svcard]", svcar);
    const dots = $$("[data-svdot]", svcar);
    const bays = $$("[data-mbay]");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mobile = matchMedia("(max-width: 899px)");
    const STEP = 2600;
    let cur = -1, timer = null, visible = true, holdUntil = 0, scrollT = null;

    const centerOf = (i) => {
      const li = cards[i].parentElement;
      return li.offsetLeft + li.offsetWidth / 2 - track.clientWidth / 2;
    };
    const setActive = (i, scroll) => {
      cur = i;
      bays.forEach((b, k) => b.classList.toggle("is-open", k === i));
      cards.forEach((c, k) => c.classList.toggle("is-active", k === i));
      dots.forEach((d, k) => d.setAttribute("aria-current", String(k === i)));
      if (scroll) track.scrollTo({ left: centerOf(i), behavior: reduced ? "auto" : "smooth" });
    };
    const tick = () => {
      if (!reduced && visible && !document.hidden && mobile.matches && Date.now() >= holdUntil) setActive((cur + 1) % cards.length, true);
    };
    const start = () => { clearInterval(timer); if (!reduced) timer = setInterval(tick, STEP); };
    const hold = () => { holdUntil = Date.now() + 6000; };

    // Użytkownik przesunął karty – otwieramy bramę tej usługi, która jest na środku
    track.addEventListener("scroll", () => {
      clearTimeout(scrollT);
      scrollT = setTimeout(() => {
        let best = 0, dist = Infinity;
        cards.forEach((_, k) => { const d = Math.abs(centerOf(k) - track.scrollLeft); if (d < dist) { dist = d; best = k; } });
        if (best !== cur) setActive(best, false);
      }, 120);
    }, { passive: true });
    ["pointerdown", "touchstart", "wheel"].forEach((ev) => track.addEventListener(ev, hold, { passive: true }));
    dots.forEach((d, k) => d.addEventListener("click", () => { hold(); setActive(k, true); }));
    bays.forEach((b, k) => {
      b.addEventListener("focus", () => { hold(); setActive(k, true); });
      b.addEventListener("pointerenter", () => { hold(); setActive(k, true); });
    });

    if ("IntersectionObserver" in window) {
      new IntersectionObserver((en) => { visible = en[0].isIntersecting; }).observe(svcar.closest(".hero") || svcar);
    }
    cards[0].classList.add("is-active");
    dots[0].setAttribute("aria-current", "true");
    // Pierwsza brama otwiera się po animacji wjazdu bram
    setTimeout(() => { setActive(0, false); start(); }, reduced ? 0 : 1100);
  }

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

  // Wolne godziny z systemu rezerwacji (cache na dzień; po „termin zajęty” pobieramy od nowa)
  const slotCache = new Map();
  // opts: wybrane opcje formularza (wpływają na czas wizyty, więc i na listę godzin)
  const fetchSlots = (slug, ymd, fresh, opts) => {
    const key = slug + "|" + ymd + "|" + opts;
    if (!fresh && slotCache.has(key)) return slotCache.get(key);
    const p = fetch(`/api/terminy?usluga=${encodeURIComponent(slug)}&dzien=${ymd}${opts ? "&" + opts : ""}`, { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => ({ list: j.terminy || [], closed: j.zamkniete || null }));
    slotCache.set(key, p);
    p.catch(() => slotCache.delete(key));
    return p;
  };
  const MSG_NO_SLOTS = "Brak wolnych terminów tego dnia – wybierz inny dzień.";

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
    const slug = ($('input[name="usluga"]', form) || {}).value || "";
    let known = null;   // wolne godziny wybranego dnia (null = jeszcze nie wiemy)
    let closedWhy = null;
    let seq = 0;
    const optParams = () => {
      const p = new URLSearchParams();
      $$('input[type="radio"]:checked, input[type="checkbox"]:checked', form).forEach((i) => { if (i.name !== "zgoda") p.append(i.name, i.value); });
      return p.toString();
    };
    const fillSlots = async (fresh) => {
      if (!dateInp || !slotSel) return;
      const v = dateInp.value;
      const prev = slotSel.value;
      const my = ++seq;
      known = null;
      slotSel.replaceChildren();
      const add = (val, label) => { const o = document.createElement("option"); o.value = val; o.textContent = label; slotSel.append(o); return o; };
      if (!v || v < now.ymd || v > addDays(now.ymd, AHEAD)) { add("", "Najpierw wybierz dzień"); slotSel.disabled = true; return; }
      add("", "Sprawdzam wolne godziny…");
      slotSel.disabled = true;
      let list;
      try { ({ list, closed: closedWhy } = await fetchSlots(slug, v, fresh, optParams())); } catch (e) {
        if (my !== seq) return;
        slotSel.replaceChildren(); add("", "Nie udało się pobrać godzin – wybierz dzień ponownie");
        return;
      }
      if (my !== seq) return;
      known = list.map((t) => t.godzina);
      slotSel.replaceChildren();
      if (!list.length) {
        add("", closedWhy ? `Zamknięte (${closedWhy})` : dowOf(v) === 0 ? "Niedziela – zamknięte" : "Brak wolnych godzin tego dnia");
        slotSel.disabled = true;
        validateDate(dateInp);
        return;
      }
      slotSel.disabled = false;
      add("", "Wybierz godzinę");
      list.forEach((t) => add(t.godzina, `${t.godzina}–${t.do}`));   // klient od razu widzi, ile potrwa wizyta
      if (known.includes(prev)) slotSel.value = prev;
      else if (prev) setErr(slotSel.closest(".fld"), "Przy tym wyborze wizyta trwa inaczej – wybierz godzinę ponownie.");
    };
    dateInp && dateInp.addEventListener("change", () => { fillSlots(); validateDate(dateInp); });
    // zmiana opcji (np. pakiet, typ pojazdu) zmienia czas wizyty – odświeżamy godziny wybranego dnia
    $$('input[type="radio"], input[type="checkbox"]:not([name="zgoda"])', form).forEach((i) =>
      i.addEventListener("change", () => { if (dateInp && dateInp.value && slotSel) fillSlots(); }));

    const validateDate = (inp) => {
      const wrap = inp.closest(".fld");
      const v = inp.value;
      if (!v) { setErr(wrap, inp.required ? MSG.date : ""); return !inp.required; }
      if (v < now.ymd) { setErr(wrap, MSG.past); return false; }
      if (v > addDays(now.ymd, AHEAD)) { setErr(wrap, MSG.far); return false; }
      const optional = inp.hasAttribute("data-optional");
      if (optional && !HOURS[dowOf(v)]) { setErr(wrap, MSG.sunday); return false; }
      if (!optional && inp === dateInp && known && !known.length) {
        setErr(wrap, closedWhy ? `Tego dnia jesteśmy zamknięci (${closedWhy}) – wybierz inny dzień.` : dowOf(v) === 0 ? MSG.sunday : MSG_NO_SLOTS);
        return false;
      }
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
        if (!res.ok || !json.ok) {
          if (res.status === 409 && slotSel) {
            // termin zajęty w międzyczasie – odświeżamy listę godzin i wskazujemy pole
            setErr(slotSel.closest(".fld"), json.error || "Ten termin właśnie został zajęty.");
            fillSlots(true).then(() => setErr(slotSel.closest(".fld"), json.error || "Ten termin właśnie został zajęty."));
            slotSel.focus({ preventScroll: true });
          }
          if (res.status === 422 && Array.isArray(json.fields)) {
            json.fields.forEach((n) => { const el = $(`[name="${n}"],[name="${n}[]"]`, form); if (el) setErr(el.closest(".fld"), "Sprawdź to pole."); });
          }
          throw new Error(json.error || "Nie udało się wysłać zgłoszenia.");
        }
        if (json.redirectUrl) {
          // zaliczka: przechodzimy do płatności (termin jest wstrzymany na czas płatności)
          btn.innerHTML = '<span class="spin" aria-hidden="true"></span><span>Przechodzę do płatności…</span>';
          location.assign(json.redirectUrl);
          return;
        }
        btn.disabled = false;
        btn.innerHTML = label;
        showDone(form, { ...data, godzinaTekst: slotSel && slotSel.value ? slotSel.selectedOptions[0].textContent : "" });
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
    if (d.data) rows.push(["Termin", `${plDate(d.data)}${d.godzina ? ", " + (d.godzinaTekst || d.godzina) : ""}${d.pora && d.pora !== "Obojętnie" ? ", " + d.pora.toLowerCase() : ""}`]);
    rows.push(["Telefon", d.telefon]);
    if (d.email) rows.push(["E-mail", d.email]);
    const box = document.createElement("div");
    box.className = "done";
    box.setAttribute("tabindex", "-1");
    box.innerHTML = `
      <div class="done__ic"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></div>
      <h3>${esc(form.dataset.done || "Zgłoszenie wysłane")}</h3>
      <p>Dziękujemy${d.imie ? ", " + esc(d.imie) : ""}! ${d.godzina ? "Termin jest zarezerwowany – do zobaczenia przy Garbarskiej 2. Jeśli plany się zmienią, zadzwoń do nas." : "Oddzwonimy w wybranym terminie – zwykle tego samego dnia w godzinach pracy."}</p>
      <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      <button type="button" class="btn btn--ghost">Wyślij kolejne zgłoszenie</button>`;
    form.hidden = true;
    form.after(box);
    box.focus({ preventScroll: true });
    box.scrollIntoView({ block: "center", behavior: "smooth" });
    $("button", box).addEventListener("click", () => {
      form.reset();
      slotCache.clear();
      $$("[data-slots]", form).forEach((s) => { s.replaceChildren(new Option("Najpierw wybierz dzień", "")); s.disabled = true; });
      const ts = $("[data-ts]", form); if (ts) ts.value = String(Date.now());
      box.remove();
      form.hidden = false;
    });
  }

  /* ---------- Rezerwacja: potwierdzenie, płatność nieudana, płatność testowa ---------- */
  const qs = new URLSearchParams(location.search);
  const zl = (gr) => (gr / 100).toLocaleString("pl-PL", { style: "currency", currency: "PLN" });
  const termText = (r) => (r.data ? `${plDate(r.data)}${r.godzina ? ", " + r.godzina + (r.godzinaDo ? "–" + r.godzinaDo : "") : ""}` : "");
  const fillDl = (dl, rows) => {
    dl.replaceChildren();
    rows.filter((r) => r[1]).forEach(([k, v]) => {
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      dl.append(dt, dd);
    });
    dl.hidden = false;
  };
  const getJson = (url, opts = {}) =>
    fetch(url, { ...opts, headers: { Accept: "application/json", ...(opts.body ? { "Content-Type": "application/json" } : {}) } })
      .then((r) => r.json().catch(() => ({})).then((j) => ({ ok: r.ok && j.ok !== false, j })))
      .catch(() => ({ ok: false, j: {} }));

  const bs = $("[data-booking-status]");
  if (bs) {
    const id = qs.get("id");
    const title = $("[data-bs-title]"), lead = $("[data-bs-lead]"), dl = $("[data-bs-details]");
    const started = Date.now();
    const tick = async () => {
      const { ok, j } = id ? await getJson(`/api/platnosc/status?id=${encodeURIComponent(id)}`) : { ok: false, j: {} };
      const r = j.rezerwacja;
      if (!ok || !r) {
        if (id && Date.now() - started < 30000) { setTimeout(tick, 3000); return; }
        title.textContent = "Nie znaleziono rezerwacji";
        lead.textContent = "Link jest niepełny albo nieaktualny. Zadzwoń do nas – sprawdzimy rezerwację.";
        return;
      }
      if (r.status === "expired" || r.status === "cancelled") {
        location.replace(`/platnosc-nieudana?id=${encodeURIComponent(id)}&powod=${r.status === "cancelled" ? "anulowano" : "czas"}`);
        return;
      }
      const when = r.kontakt
        ? (r.data ? plDate(r.data) : "najszybciej, jak się da") + (r.pora && r.pora !== "Obojętnie" ? ", " + r.pora.toLowerCase() : "")
        : termText(r);
      fillDl(dl, [["Usługa", r.usluga], [r.kontakt ? "Kontakt" : "Termin", when],
        ["Zaliczka", r.platnosc ? `${zl(r.platnosc.kwota)} – ${r.platnosc.status === "succeeded" ? "opłacona" : "czeka na potwierdzenie"}` : ""]]);
      if (r.status === "confirmed") {
        $("[data-bs-ok]").hidden = false;
        title.textContent = r.kontakt ? "Zgłoszenie przyjęte" : "Rezerwacja potwierdzona";
        lead.textContent = r.kontakt
          ? "Oddzwonimy w wybranym terminie – zwykle tego samego dnia w godzinach pracy."
          : `Dziękujemy${r.imie ? ", " + r.imie : ""}! Termin jest Twój – do zobaczenia przy Garbarskiej 2.`;
        return;
      }
      // pending_payment: potwierdzenie przychodzi webhookiem, więc może dotrzeć chwilę po powrocie z płatności
      if (Date.now() - started > 120000) {
        title.textContent = "Płatność w trakcie";
        lead.textContent = "Nie mamy jeszcze potwierdzenia z systemu płatności. Odśwież stronę za chwilę albo zadzwoń do nas.";
        return;
      }
      setTimeout(tick, 2500);
    };
    tick();
  }

  const bf = $("[data-booking-failed]");
  if (bf) {
    const id = qs.get("id");
    if (qs.get("powod") === "anulowano") {
      $("[data-bf-title]").textContent = "Płatność anulowana";
      $("[data-bf-lead]").textContent = "Rezerwacja nie została opłacona, więc termin wrócił do puli.";
    }
    if (id) {
      // rezygnacja na stronie płatności: zamykamy płatność, żeby termin od razu wrócił do puli
      const cancel = qs.get("powod") === "anulowano" ? getJson("/api/platnosc/anuluj", { method: "POST", body: JSON.stringify({ id }) }) : Promise.resolve();
      cancel.then(() => getJson(`/api/platnosc/status?id=${encodeURIComponent(id)}`)).then(({ j }) => {
        const r = j.rezerwacja;
        if (!r) return;
        if (r.status === "confirmed") { location.replace(`/potwierdzenie?id=${encodeURIComponent(id)}`); return; }
        if (r.slug) $("[data-bf-again]").href = `/rezerwacja?usluga=${encodeURIComponent(r.slug)}`;
      });
    }
  }

  const mp = $("[data-mock-pay]");
  if (mp) {
    const pid = location.pathname.split("/").pop();
    const dl = $("[data-mp-details]"), timer = $("[data-mp-timer]"), msg = $("[data-mp-msg]");
    const pay = $("[data-mp-pay]"), cancel = $("[data-mp-cancel]");
    let until = 0, iv = null;
    const fail = (text) => { msg.textContent = text; msg.hidden = false; };
    const countdown = () => {
      const left = Math.max(0, Math.round((until - Date.now()) / 1000));
      timer.textContent = left
        ? `Termin czeka na wpłatę jeszcze ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} min.`
        : "Czas na wpłatę minął – termin wrócił do puli.";
      if (!left) { clearInterval(iv); pay.disabled = true; }
    };
    getJson(`/api/platnosc/info?id=${encodeURIComponent(pid)}`).then(({ ok, j }) => {
      const p = j.platnosc;
      if (!ok || !p) { timer.textContent = ""; fail(j.error || "Nie znaleziono płatności."); return; }
      fillDl(dl, [["Usługa", p.usluga], ["Termin", termText(p)], ["Zaliczka", zl(p.kwota)]]);
      if (p.status === "succeeded") { location.replace(`/potwierdzenie?id=${encodeURIComponent(p.rezerwacja)}`); return; }
      if (p.status !== "pending") { location.replace(`/platnosc-nieudana?id=${encodeURIComponent(p.rezerwacja)}&powod=czas`); return; }
      until = Date.parse(p.holdDo);
      countdown();
      iv = setInterval(countdown, 1000);
      pay.disabled = cancel.disabled = false;
    });
    const send = async (wynik, btn) => {
      pay.disabled = cancel.disabled = true;
      msg.hidden = true;
      const label = btn.innerHTML;
      btn.innerHTML = '<span class="spin" aria-hidden="true"></span><span>Chwileczkę…</span>';
      const { ok, j } = await getJson("/api/platnosc/mock", { method: "POST", body: JSON.stringify({ paymentId: pid, wynik }) });
      if (ok && j.next) { location.assign(j.next); return; }
      btn.innerHTML = label;
      pay.disabled = cancel.disabled = false;
      fail(j.error || "Nie udało się. Spróbuj ponownie.");
    };
    pay.addEventListener("click", () => send("zaplac", pay));
    cancel.addEventListener("click", () => send("anuluj", cancel));
  }
})();

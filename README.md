# Amigos Staweccy – strona z rezerwacjami

Strona dla Amigos Staweccy (Nowa Sól, Garbarska 2): strona główna, 5 podstron usług, rezerwacja z zakładkami, kontakt, polityka prywatności.
Czysty HTML/CSS/JS – bez frameworka i bez kroku budowania, więc Vercel serwuje pliki od razu, a strona ładuje się w ułamku sekundy.
Rezerwacje działają na funkcjach Vercel (`/api`) i bazie Postgres: wolne terminy, blokada terminu na czas płatności, zaliczka (symulacja albo Stripe) i panel admina pod `/admin`.

## Wdrożenie: GitHub → Vercel

1. Wrzuć zawartość tego folderu do nowego repozytorium na GitHubie (pliki mają leżeć w katalogu głównym repo).
2. Na vercel.com: **Add New → Project → Import** tego repo.
3. Framework Preset: **Other**. Build Command i Output Directory zostaw puste. **Deploy**.
4. Podepnij domenę (Settings → Domains). Jeśli to nie `amigoscar.pl`, zmień `SITE_URL` w `src/build.py` i uruchom generator (niżej).

### Baza i panel (wymagane do rezerwacji)

Wszystko klika się w Vercelu – niczego nie trzeba instalować lokalnie.

1. Vercel → projekt → **Storage → Create Database → Neon** (region Frankfurt, plan Free) → podłącz do projektu we wszystkich środowiskach. Vercel sam doda `DATABASE_URL`.
2. **Settings → Environment Variables**: `PAYMENTS_MODE=mock`, `ADMIN_LOGIN=admin`, `ADMIN_PASSWORD=<mocne hasło>`, `CRON_SECRET=<losowy ciąg>`, a tylko dla Production `PUBLIC_BASE_URL=https://twoja-domena.pl` (pełna lista: `.env.example`).
3. **Redeploy**. Przy każdym wdrożeniu Vercel uruchamia `npm run vercel-build` (`scripts/vercel-build.js`): tworzy/aktualizuje tabele, 5 usług (zaliczka 50 zł), stanowiska, grafik tygodniowy i czasy usług (wartości z `api/_lib/defaults.js`) oraz konto admina z `ADMIN_PASSWORD`. Uzupełnia tylko to, czego brakuje – ustawień zmienionych w panelu nie nadpisuje. Zmiana `ADMIN_PASSWORD` + Redeploy = nowe hasło admina.
4. Panel: `https://twoja-domena.pl/admin`. Terminy liczą się same z grafiku – nic nie trzeba generować ani dogenerowywać.

### Żeby zgłoszenia przychodziły na maila### Żeby zgłoszenia przychodziły na maila

Vercel → Project → Settings → Environment Variables:

| Zmienna | Przykład | Po co |
|---|---|---|
| `RESEND_API_KEY` | `re_xxx` | klucz z [resend.com](https://resend.com) (darmowy plan wystarczy) |
| `BOOKING_TO` | `biuro@amigoscar.pl` | gdzie wysyłać zgłoszenia (można kilka po przecinku) |
| `BOOKING_FROM` | `Amigos – rezerwacje <rezerwacje@amigoscar.pl>` | nadawca – domena zweryfikowana w Resend |
| `WEBHOOK_URL` | `https://panel…/api/rezerwacje` | opcjonalnie: każde zgłoszenie leci tu jako JSON (pod panel) |
| `WEBHOOK_SECRET` | dowolny ciąg | opcjonalnie: wysyłany w nagłówku `X-Amigos-Secret` |

Po dodaniu zmiennych zrób **Redeploy**. Bez nich formularz działa, ale zgłoszenia lądują tylko w logach funkcji (Vercel → Logs).

## Uruchomienie lokalne

Wymaga Node 20+ i Postgresa (lokalnie albo darmowy Neon).

```bash
cp .env.example .env        # uzupełnij DATABASE_URL (i ADMIN_PASSWORD)
npm install
npm run seed                # tabele + usługi + stanowiska + grafik + konto admina (można powtarzać; na Vercelu dzieje się to samo przy wdrożeniu)
npm run dev                 # http://localhost:3000, panel: http://localhost:3000/admin
npm test                    # testy na osobnej bazie: TEST_DATABASE_URL (domyślnie postgres://amigos:amigos@localhost:5432/amigos_test – UWAGA: test czyści tę bazę)
```

W trybie `PAYMENTS_MODE=mock` cały przepływ działa bez kluczy: formularz → strona „Płatność testowa” (`/platnosc/mock/<id>`) → „Zapłać (symulacja)” → potwierdzenie → powiadomienie w panelu.

## Jak działają rezerwacje

**Wolne godziny są liczone na bieżąco** (bez generowania slotów) z czterech rzeczy, które ustawia się w panelu:

1. **Grafik tygodniowy** usługi (Grafik → Godziny pracy, z przerwą) + **dni wolne / zmienione godziny** + **polskie święta** (automatycznie, łącznie z Wielkanocą, Bożym Ciałem i Wigilią).
2. **Czas wizyty zależny od wyboru klienta** (Usługi → Czas trwania): czas bazowy + minuty za wybrane opcje formularza, np. „Pakiet komplet” 180 min, „SUV” +15 min. Formularz pokazuje tylko te godziny, w których cała wizyta się mieści (np. nie wejdzie w przerwę ani za zamknięcie), i od razu godzinę zakończenia („10:00–13:00”).
3. **Stanowiska** (Usługi → Stanowiska): ile wizyt naraz. Stanowisko może obsługiwać kilka usług – wtedy wizyta w jednej blokuje je także dla drugiej (np. biuro: rejestracja + ubezpieczenia).
4. **Zasady**: zapas po każdej wizycie, co ile minut pokazywać godziny startu, minimalne wyprzedzenie, na ile dni do przodu.

Ochrona przed konfliktami:
- **Dwie osoby na ten sam termin:** zapis w transakcji blokuje stanowiska usługi (`SELECT … FOR UPDATE`), a w bazie działa constraint `bookings_no_overlap` (`EXCLUDE USING gist`) – dwie aktywne wizyty na jednym stanowisku nie mogą na siebie nachodzić, łącznie z zapasem. Przegrany dostaje „Ten termin właśnie został zajęty”.
- **Rezerwacje z telefonu / na miejscu:** Kalendarz → kliknij wolne miejsce albo „+ Dodaj rezerwację”. Termin od razu znika z rezerwacji online. Opcja „poza grafikiem” pozwala zapisać kogoś po godzinach – nadal bez nakładania się na inne wizyty.
- **Blokady czasu** (Kalendarz → „Zablokuj czas”): na całą usługę albo jedno stanowisko (awaria, szkolenie).
- **Duplikaty:** ten sam numer telefonu nie zarezerwuje drugi raz tej samej usługi tego samego dnia.
- Zmiana grafiku, dodanie dnia wolnego albo blokady nie przesuwa już zapisanych wizyt – panel ostrzega, ile wizyt wypada w tym czasie.

Pozostałe zasady:
- Usługa z zaliczką → status `pending_payment` i hold na 15 min (w trybie Stripe 30 min – minimum Stripe), potem przekierowanie do płatności. Bez zaliczki → od razu `confirmed`.
- Rezerwację potwierdza wyłącznie zdarzenie płatności (webhook Stripe albo przycisk na stronie symulacji – obie drogi przechodzą przez tę samą funkcję `applyPaymentEvent`). Powrót klienta na stronę potwierdzenia niczego nie zmienia – strona tylko odpytuje status.
- Wygasłe holdy nie blokują terminu (dostępność liczy tylko aktywne holdy, a zapis sprząta wygasłe holdy na stanowiskach); dodatkowo cron (`/api/cron`) porządkuje statusy raz dziennie.
- Daty w bazie są w UTC, wszystko na stronie i w panelu w czasie polskim (`Europe/Warsaw`, ze zmianą czasu).
- Pola specyficzne dla usług są w `bookings.details` (JSON) i są walidowane według definicji formularzy z `src/build.py` (generowane do `api/_uslugi.json`).
- Ubezpieczenia to prośba o kontakt („kiedy oddzwonić”) – bez terminu i domyślnie bez zaliczki.

### Domyślne liczby (do podmiany na dane od firmy)

Wszystkie przykładowe wartości – stanowiska, czasy usług, zapasy, przerwa, wyprzedzenie – są w **`api/_lib/defaults.js`**.
Trafiają do bazy przy pierwszym wdrożeniu; potem zmienia się je w panelu (Grafik, Usługi). Gdy przyjdą prawdziwe dane, najprościej
wpisać je w panelu albo poprawić `defaults.js` i w panelu kliknąć „Przywróć domyślne czasy” przy danej usłudze.

**Panel `/admin`:** rezerwacje (zakładki per usługa, wyszukiwanie po telefonie / nr rej. / imieniu, szczegóły, anulowanie z powodem), kalendarz dnia (kolumny = stanowiska, dodawanie rezerwacji kliknięciem, blokady), grafik (godziny pracy, zasady, dni wolne, święta), usługi i stanowiska (zaliczka, czas trwania, przypisanie stanowisk), dzwonek z powiadomieniami (odświeżanie co 20 s). Hasło admina jest hashowane (scrypt), sesja w ciasteczku `httpOnly`, logowanie ma limit prób.

## Jak przełączyć na prawdziwe płatności

Kod się nie zmienia – tylko zmienne środowiskowe i konfiguracja w Stripe.

1. W [panelu Stripe](https://dashboard.stripe.com) włącz metody płatności **BLIK** i **Karty** (Settings → Payment methods). Konto musi mieć walutę PLN.
2. Skopiuj **Secret key** (Developers → API keys): `sk_live_…` (albo `sk_test_…` do testów).
3. Dodaj endpoint webhooka (Developers → Webhooks → Add endpoint):
   - URL: `https://twoja-domena.pl/api/stripe-webhook`
   - zdarzenia: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
   - skopiuj **Signing secret** (`whsec_…`).
4. Ustaw w Vercel: `PAYMENTS_MODE=real`, `STRIPE_SECRET_KEY=sk_…`, `STRIPE_WEBHOOK_SECRET=whsec_…`, `PUBLIC_BASE_URL=https://twoja-domena.pl` → **Redeploy**.
   Bez któregoś z nich aplikacja się nie uruchomi i w logach pojawi się komunikat, czego brakuje.
5. Zwroty zaliczek po anulowaniu w panelu robi się na razie ręcznie w Stripe (Payments → płatność → Refund) – panel o tym przypomina.

**Testy lokalne ze Stripe** (klucze testowe `sk_test_…`):

```bash
stripe login
stripe listen --forward-to localhost:3000/api/stripe-webhook   # wypisze whsec_… – wpisz go do STRIPE_WEBHOOK_SECRET
PAYMENTS_MODE=real npm run dev                                 # zarezerwuj termin w formularzu i zapłać kartą testową 4242 4242 4242 4242
```

`stripe trigger …` wysyła zdarzenia bez naszych metadanych – webhook je przyjmie (200), ale zignoruje. Do testu całego przepływu użyj formularza.

## Edycja treści

Wszystkie dane są w jednym pliku: **`src/build.py`** – telefony, godziny otwarcia, usługi, cennik geometrii, FAQ, pola formularzy, promocja.

```bash
python3 src/build.py     # wymaga Pythona 3.12+, bez dodatkowych bibliotek
```

Generator nadpisuje pliki `.html` (także `admin/index.html` i strony płatności), `sitemap.xml`, `robots.txt`, `site.webmanifest` i `api/_uslugi.json`. Potem commit + push – Vercel sam wdroży nową wersję.

- Kolory i fonty: `assets/css/style.css` (sekcja `:root`).
- Promocja geometrii znika sama po dacie w `PROMO["until"]`.
- Zdjęcie budynku: `assets/img/obiekt.webp` (wycięte z okładki na Facebooku – warto podmienić na lepsze zdjęcie).

## Co jest w środku

```
index.html                strona główna (budynek z bramami = wybór usługi, rezerwacja, dojazd, FAQ)
uslugi/                   lista usług + 5 podstron (każda z własnym formularzem)
rezerwacja.html           rezerwacja z zakładkami (?usluga=geometria-kol-3d otwiera od razu daną zakładkę)
kontakt.html, polityka-prywatnosci.html, dziekujemy.html, 404.html
api/zapis.js              przyjmuje rezerwacje z formularzy
api/terminy.js            wolne terminy dla formularza
api/platnosc.js           status rezerwacji, strona płatności testowej
api/stripe-webhook.js     webhook Stripe (podpis, idempotencja)
api/admin.js              API panelu (/api/admin/*)
api/cron.js               sprzątanie wygasłych holdów
api/_lib/                 logika: dostępność (availability.js), rezerwacje, płatności (mock/Stripe), auth, walidacja, SQL migracji
api/_lib/defaults.js      domyślne stanowiska, czasy usług i zasady grafiku (przykładowe – do podmiany)
admin/                    panel rezerwacji (/admin) + assets/css/admin.css, assets/js/admin.js
potwierdzenie.html, platnosc-nieudana.html, platnosc/mock.html   strony po płatności
scripts/                  serwer lokalny, migracje, seed, krok build na Vercelu
test/                     testy (node --test)
assets/                   CSS, JS, fonty (lokalnie – bez Google Fonts), obrazy
vercel.json               czyste adresy, nagłówki bezpieczeństwa (CSP, HSTS), cache
src/build.py              generator stron (nie trafia na serwer – .vercelignore)
```

**Bezpieczeństwo:** ścisła polityka CSP (zero skryptów z zewnątrz), walidacja po stronie przeglądarki i serwera, whitelist pól, limit 5 zgłoszeń / 10 min z jednego IP, ukryte pole i blokada zbyt szybkiego wysłania przeciw botom, sprawdzanie źródła żądania. Mapa Google ładuje się dopiero po kliknięciu, więc strona nie potrzebuje banera cookies.

**SEO:** unikalne tytuły i opisy, dane strukturalne (AutoRepair, Service, FAQPage, BreadcrumbList), sitemap, Open Graph z obrazkiem, semantyczny HTML.

## Do zrobienia / do potwierdzenia z firmą

- [x] Prawdziwy system rezerwacji z blokowaniem zajętych godzin (zob. „Jak działają rezerwacje”).
- [ ] Kwoty zaliczek (teraz prototypowo 50 zł), liczba stanowisk, czasy usług, przerwy – teraz przykładowe (`api/_lib/defaults.js`), do potwierdzenia z firmą.
- [ ] Zwroty zaliczek automatycznie przez Stripe (interfejs `refund()` jest gotowy, teraz zwrot ręczny).
- [ ] Polityka prywatności: pełna nazwa firmy, NIP, REGON (żółte pole na stronie).
- [ ] Godziny otwarcia myjni, biura i geometrii – teraz wszędzie są godziny stacji kontroli z Google.
- [ ] Warianty i ceny myjni (w formularzu są propozycje pakietów).
- [ ] Cennik geometrii – przepisany z plakatu na Facebooku, warto sprawdzić.
- [ ] Domena (`SITE_URL`).

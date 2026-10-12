# Amigos Staweccy – strona z rezerwacjami

Strona dla Amigos Staweccy (Nowa Sól, Garbarska 2): strona główna, 5 podstron usług, rezerwacja z zakładkami, kontakt, polityka prywatności.
Czysty HTML/CSS/JS – bez frameworka i bez kroku budowania, więc Vercel serwuje pliki od razu, a strona ładuje się w ułamku sekundy.

## Wdrożenie: GitHub → Vercel

1. Wrzuć zawartość tego folderu do nowego repozytorium na GitHubie (pliki mają leżeć w katalogu głównym repo).
2. Na vercel.com: **Add New → Project → Import** tego repo.
3. Framework Preset: **Other**. Build Command i Output Directory zostaw puste. **Deploy**.
4. Podepnij domenę (Settings → Domains). Jeśli to nie `amigoscar.pl`, zmień `SITE_URL` w `src/build.py` i uruchom generator (niżej).

### Żeby zgłoszenia przychodziły na maila

Vercel → Project → Settings → Environment Variables:

| Zmienna | Przykład | Po co |
|---|---|---|
| `RESEND_API_KEY` | `re_xxx` | klucz z [resend.com](https://resend.com) (darmowy plan wystarczy) |
| `BOOKING_TO` | `biuro@amigoscar.pl` | gdzie wysyłać zgłoszenia (można kilka po przecinku) |
| `BOOKING_FROM` | `Amigos – rezerwacje <rezerwacje@amigoscar.pl>` | nadawca – domena zweryfikowana w Resend |
| `WEBHOOK_URL` | `https://panel…/api/rezerwacje` | opcjonalnie: każde zgłoszenie leci tu jako JSON (pod panel) |
| `WEBHOOK_SECRET` | dowolny ciąg | opcjonalnie: wysyłany w nagłówku `X-Amigos-Secret` |

Po dodaniu zmiennych zrób **Redeploy**. Bez nich formularz działa, ale zgłoszenia lądują tylko w logach funkcji (Vercel → Logs).

## Edycja treści

Wszystkie dane są w jednym pliku: **`src/build.py`** – telefony, godziny otwarcia, usługi, cennik geometrii, FAQ, pola formularzy, promocja.

```bash
python3 src/build.py     # wymaga Pythona 3.12+, bez dodatkowych bibliotek
```

Generator nadpisuje pliki `.html`, `sitemap.xml`, `robots.txt`, `site.webmanifest` i `api/_uslugi.json`. Potem commit + push – Vercel sam wdroży nową wersję.

- Kolory i fonty: `assets/css/style.css` (sekcja `:root`).
- Promocja geometrii znika sama po dacie w `PROMO["until"]`.
- Zdjęcie budynku: `assets/img/obiekt.webp` (wycięte z okładki na Facebooku – warto podmienić na lepsze zdjęcie).

## Co jest w środku

```
index.html                strona główna (budynek z bramami = wybór usługi, rezerwacja, dojazd, FAQ)
uslugi/                   lista usług + 5 podstron (każda z własnym formularzem)
rezerwacja.html           rezerwacja z zakładkami (?usluga=geometria-kol-3d otwiera od razu daną zakładkę)
kontakt.html, polityka-prywatnosci.html, dziekujemy.html, 404.html
api/zapis.js              funkcja Vercel przyjmująca zgłoszenia
assets/                   CSS, JS, fonty (lokalnie – bez Google Fonts), obrazy
vercel.json               czyste adresy, nagłówki bezpieczeństwa (CSP, HSTS), cache
src/build.py              generator stron (nie trafia na serwer – .vercelignore)
```

**Bezpieczeństwo:** ścisła polityka CSP (zero skryptów z zewnątrz), walidacja po stronie przeglądarki i serwera, whitelist pól, limit 5 zgłoszeń / 10 min z jednego IP, ukryte pole i blokada zbyt szybkiego wysłania przeciw botom, sprawdzanie źródła żądania. Mapa Google ładuje się dopiero po kliknięciu, więc strona nie potrzebuje banera cookies.

**SEO:** unikalne tytuły i opisy, dane strukturalne (AutoRepair, Service, FAQPage, BreadcrumbList), sitemap, Open Graph z obrazkiem, semantyczny HTML.

## Do zrobienia / do potwierdzenia z firmą

- [ ] **Prawdziwy system rezerwacji** z blokowaniem zajętych godzin – teraz godziny w formularzu wynikają z godzin otwarcia, a termin potwierdza się telefonicznie. Punkt zaczepienia: `WEBHOOK_URL` w `api/zapis.js` oraz funkcja `slotsFor()` w `assets/js/main.js` (tam podepnij pobieranie wolnych terminów z API panelu).
- [ ] Polityka prywatności: pełna nazwa firmy, NIP, REGON (żółte pole na stronie).
- [ ] Godziny otwarcia myjni, biura i geometrii – teraz wszędzie są godziny stacji kontroli z Google.
- [ ] Warianty i ceny myjni (w formularzu są propozycje pakietów).
- [ ] Cennik geometrii – przepisany z plakatu na Facebooku, warto sprawdzić.
- [ ] Domena (`SITE_URL`).

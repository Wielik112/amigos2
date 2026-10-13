#!/usr/bin/env python3
"""
Generator strony Amigos Staweccy.

Wszystkie treści (usługi, godziny, telefony, cennik, FAQ, pola formularzy)
siedzą w tym jednym pliku. Zmieniasz dane -> uruchamiasz:

    python3 src/build.py

i wszystkie pliki .html, sitemap.xml itd. generują się na nowo w katalogu głównym.
Nie potrzeba żadnych bibliotek – sam Python 3.8+.
"""
import json
import os
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------------------
# DANE FIRMY
# ---------------------------------------------------------------------------
SITE_URL = "https://amigoscar.pl"          # <- docelowa domena (bez / na końcu)
BRAND = "Amigos Staweccy"
CITY = "Nowa Sól"
STREET = "Garbarska 2"
POSTAL = "67-100"
ACCESS = "Wjazd od ul. Moniuszki, parking na miejscu"
EMAIL = "biuro@amigoscar.pl"
FACEBOOK = "https://www.facebook.com/AMIGOSStaweccy/"
MAPS_LINK = "https://www.google.com/maps/search/?api=1&query=Amigos+Stacja+Kontroli+Pojazd%C3%B3w+Garbarska+2+Nowa+S%C3%B3l"
MAPS_EMBED = "https://www.google.com/maps?q=Garbarska+2,+67-100+Nowa+S%C3%B3l&z=16&output=embed"
GOOGLE_RATING = "4,7"
GOOGLE_REVIEWS = "258"

PHONES = {
    "biuro": ("884 303 040", "Biuro, ubezpieczenia, rejestracja, myjnia"),
    "skp": ("697 500 530", "Stacja kontroli pojazdów"),
    "geometria": ("570 442 080", "Geometria kół 3D"),
}
MAIN_PHONE = PHONES["biuro"][0]

# (nazwa, numer dnia JS: 0=niedziela, otwarcie, zamknięcie) – None = zamknięte
HOURS = [
    ("Poniedziałek", 1, "08:00", "20:00"),
    ("Wtorek", 2, "09:00", "19:00"),
    ("Środa", 3, "08:00", "20:00"),
    ("Czwartek", 4, "08:00", "20:00"),
    ("Piątek", 5, "08:00", "20:00"),
    ("Sobota", 6, "08:00", "14:00"),
    ("Niedziela", 0, None, None),
]
SLOT_MINUTES = 30            # co ile minut pokazywać godziny w formularzu
BOOK_DAYS_AHEAD = 60         # na ile dni do przodu można wybrać termin

# Promocja – znika automatycznie po tej dacie (sprawdzane w przeglądarce)
PROMO = {
    "text": "−25% na wszystkie usługi geometrii kół do końca października",
    "until": "2026-10-31",
    "service": "geometria-kol-3d",
}


def tel(p):
    return "+48" + p.replace(" ", "")


# ---------------------------------------------------------------------------
# IKONY (inline SVG, stroke = currentColor)
# ---------------------------------------------------------------------------
ICONS = {
    "skp": '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2.8h6V4"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
    "shield": '<path d="M12 2.8 4.8 5.6v5.2c0 4.6 3 8.3 7.2 10.4 4.2-2.1 7.2-5.8 7.2-10.4V5.6z"/><path d="m8.8 12 2.2 2.2 4.2-4.4"/>',
    "drop": '<path d="M12 3s-5.5 6-5.5 10a5.5 5.5 0 0 0 11 0C17.5 9 12 3 12 3z"/><path d="M9.6 13.6a2.5 2.5 0 0 0 2.4 2.4"/>',
    "plate": '<rect x="2.5" y="7" width="19" height="10" rx="1.6"/><path d="M6 7v10"/><path d="M9 12h9"/>',
    "wheel": '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>',
    "phone": '<path d="M5 3.5h3.2l1.6 4.2-2.1 1.4a11 11 0 0 0 5.2 5.2l1.4-2.1 4.2 1.6V17a2 2 0 0 1-2 2A15.5 15.5 0 0 1 3 5.5a2 2 0 0 1 2-2z"/>',
    "pin": '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
    "clock": '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    "mail": '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
    "check": '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    "star": '<path d="m12 3.2 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/>',
    "parking": '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M9.5 16.5v-9h3.2a2.8 2.8 0 0 1 0 5.6H9.5"/>',
    "calendar": '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
    "chev": '<path d="m9 5 7 7-7 7"/>',
    "menu": '<path d="M4 7h16M4 12h16M4 17h16"/>',
    "close": '<path d="M6 6l12 12M18 6 6 18"/>',
    "fb": '<path d="M14 21v-7.5h2.6l.4-3H14V8.6c0-.9.3-1.5 1.6-1.5H17V4.4c-.3 0-1.2-.1-2.3-.1-2.3 0-3.8 1.4-3.8 3.9v2.3H8.3v3h2.6V21"/>',
}


def icon(name, cls="ic"):
    return (f'<svg class="{cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
            f'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{ICONS[name]}</svg>')


# ---------------------------------------------------------------------------
# USŁUGI – kolejność jak na budynku (od lewej)
# ---------------------------------------------------------------------------
CONTACT_NOTE = "Termin potwierdzamy telefonicznie w godzinach pracy – zwykle tego samego dnia."

SERVICES = [
    {
        "slug": "stacja-kontroli-pojazdow",
        "short": "Przegląd",
        "name": "Stacja kontroli pojazdów",
        "sign": ["Podstawowa stacja", "kontroli pojazdów"],
        "icon": "skp",
        "phone": "skp",
        "title": "Stacja kontroli pojazdów Nowa Sól – przegląd rejestracyjny",
        "desc": "Badanie techniczne aut osobowych, dostawczych do 3,5 t, motocykli i przyczep w Nowej Soli. Umów godzinę przeglądu online. Garbarska 2, wjazd od ul. Moniuszki.",
        "lead": "Przegląd rejestracyjny samochodu, motocykla lub przyczepy do 3,5 t. Zarezerwuj godzinę online i przyjedź na konkretny termin.",
        "card": "Badania okresowe, LPG, pojazdy sprowadzone i badania dodatkowe – dla pojazdów do 3,5 t.",
        "points": ["Badanie okresowe", "Auta z instalacją LPG", "Pojazdy sprowadzone z zagranicy"],
        "offer_title": "Jakie badania wykonujemy",
        "offer": [
            ("Badanie okresowe", "Coroczny przegląd samochodu osobowego, dostawczego, motocykla, motoroweru lub przyczepy do 3,5 t."),
            ("Auto z instalacją gazową", "Badanie pojazdu zasilanego LPG lub CNG, łącznie z kontrolą instalacji."),
            ("Pierwsze badanie pojazdu z zagranicy", "Badanie przed pierwszą rejestracją w Polsce – rejestrację załatwisz w tym samym budynku."),
            ("Badanie dodatkowe", "Po kolizji, po zmianach w konstrukcji pojazdu lub na wezwanie policji."),
        ],
        "bring_title": "Co zabrać na przegląd",
        "bring": [
            "Dowód rejestracyjny pojazdu (przy aucie z zagranicy – dokumenty pojazdu z kraju pochodzenia).",
            "Przy instalacji LPG/CNG – dokument z aktualną legalizacją zbiornika.",
            "Pojazd z czytelnym numerem VIN i sprawnymi światłami – to sprawdzamy na początku.",
        ],
        "price_note": "Opłaty za badania techniczne są ustalone przepisami i takie same na każdej stacji w Polsce. Dokładną kwotę dla Twojego pojazdu podamy przy potwierdzeniu terminu.",
        "faq": [
            ("Czy muszę się umawiać na przegląd?", "Nie musisz – przyjmujemy też bez rezerwacji. Z zarezerwowaną godziną wiesz jednak, kiedy zostaniesz obsłużony, i nie czekasz na swoją kolej."),
            ("Ile trwa badanie techniczne?", "Zwykle około pół godziny. Badanie pojazdu sprowadzonego z zagranicy lub z instalacją gazową trwa dłużej."),
            ("Skąd wiem, do kiedy mam ważny przegląd?", "Data następnego badania jest wpisana w dowodzie rejestracyjnym lub widoczna w zaświadczeniu z poprzedniego przeglądu. Możesz też zadzwonić – sprawdzimy to razem."),
            ("Co jeśli auto nie przejdzie przeglądu?", "Dostaniesz informację, co trzeba poprawić. Po naprawie wracasz na stację w wyznaczonym terminie, a sprawdzamy tylko usterki z poprzedniego badania."),
        ],
        "form": {
            "cta": "Zarezerwuj przegląd",
            "done": "Rezerwacja przeglądu wysłana",
            "fields": [
                {"type": "chips", "name": "pojazd", "label": "Rodzaj pojazdu", "req": True,
                 "opts": ["Osobowy", "Osobowy z LPG", "Dostawczy do 3,5 t", "Motocykl / motorower", "Przyczepa", "Inny"]},
                {"type": "chips", "name": "badanie", "label": "Rodzaj badania", "req": True,
                 "opts": ["Okresowe", "Pierwsze – pojazd z zagranicy", "Dodatkowe", "Nie wiem, doradźcie"]},
                {"type": "slot", "label": "Preferowany termin", "req": True},
                {"type": "row", "items": [
                    {"type": "text", "name": "marka", "label": "Marka i model", "ph": "np. Skoda Octavia", "ac": "off"},
                    {"type": "text", "name": "rejestracja", "label": "Nr rejestracyjny", "ph": "np. FNW 12345", "ac": "off", "upper": True},
                ]},
            ],
        },
    },
    {
        "slug": "myjnia-reczna",
        "short": "Myjnia",
        "name": "Myjnia ręczna",
        "sign": ["Myjnia ręczna", "i czyszczenie wnętrz"],
        "icon": "drop",
        "phone": "biuro",
        "title": "Myjnia ręczna Nowa Sól – mycie auta i czyszczenie wnętrza",
        "desc": "Ręczne mycie samochodu i kompleksowe czyszczenie wnętrza w Nowej Soli. Zarezerwuj termin online – Amigos Staweccy, Garbarska 2.",
        "lead": "Ręczne mycie nadwozia i kompleksowe czyszczenie wnętrza. Zostaw auto i w tym czasie załatw inną sprawę na miejscu.",
        "card": "Mycie ręczne nadwozia i kompleksowe czyszczenie wnętrza, bez szczotek rysujących lakier.",
        "points": ["Mycie ręczne nadwozia", "Czyszczenie wnętrza", "Pakiet: auto w środku i na zewnątrz"],
        "offer_title": "Co możesz u nas zrobić",
        "offer": [
            ("Mycie ręczne nadwozia", "Dokładne mycie karoserii, felg i szyb ręcznie – bez szczotek, które rysują lakier."),
            ("Mycie z odkurzaniem", "Nadwozie plus odkurzanie wnętrza, dywaników i bagażnika."),
            ("Kompleksowe czyszczenie wnętrza", "Kokpit, plastiki, szyby od środka, fotele i podsufitka – auto jak po odbiorze z salonu."),
            ("Pakiet komplet", "Mycie na zewnątrz i pełne czyszczenie w środku przy jednej wizycie."),
        ],
        "bring_title": "Dobrze wiedzieć",
        "bring": [
            "Czas i cena zależą od wielkości i stanu auta – podamy je przy potwierdzeniu rezerwacji.",
            "Przed czyszczeniem wnętrza wyjmij z auta rzeczy osobiste i foteliki.",
            "Podczas mycia możesz zrobić przegląd albo załatwić ubezpieczenie w biurze obok.",
        ],
        "price_note": "",
        "faq": [
            ("Ile trwa czyszczenie wnętrza?", "To zależy od stanu auta – od godziny przy odświeżeniu do kilku godzin przy pełnym czyszczeniu. Dokładny czas podamy przy potwierdzeniu."),
            ("Czy mogę zostawić auto i odebrać je później?", "Tak. Zadzwonimy, gdy samochód będzie gotowy do odbioru."),
            ("Czy myjecie busy i auta dostawcze?", "Tak – zaznacz typ pojazdu w formularzu, żebyśmy zaplanowali odpowiednio dużo czasu."),
        ],
        "form": {
            "cta": "Zarezerwuj mycie",
            "done": "Rezerwacja mycia wysłana",
            "fields": [
                {"type": "chips", "name": "pakiet", "label": "Co robimy", "req": True,
                 "opts": ["Mycie ręczne nadwozia", "Mycie z odkurzaniem", "Czyszczenie wnętrza", "Pakiet komplet", "Doradźcie mi"]},
                {"type": "chips", "name": "pojazd", "label": "Typ pojazdu", "req": True,
                 "opts": ["Osobowy", "SUV / kombi", "Bus / dostawczy"]},
                {"type": "slot", "label": "Preferowany termin", "req": True},
            ],
        },
    },
    {
        "slug": "geometria-kol-3d",
        "short": "Geometria 3D",
        "name": "Geometria kół 3D",
        "sign": ["Geometria", "kół 3D"],
        "icon": "wheel",
        "phone": "geometria",
        "title": "Geometria kół 3D Nowa Sól – ustawienie zbieżności, cennik",
        "desc": "Pomiar i ustawienie geometrii kół na stanowisku 3D w Nowej Soli. Osobowe, SUV, BMW, Mercedes, busy. Sprawdź cennik i umów termin online.",
        "lead": "Pomiar i ustawienie geometrii na stanowisku 3D. Auto przestaje ściągać, kierownica stoi prosto, a opony zużywają się równo.",
        "card": "Zbieżność, geometria przodu i całego auta – osobowe, SUV, BMW, Mercedes i busy.",
        "points": ["Pomiar z wydrukiem", "Osobowe, SUV, busy", "Kalibracja kąta skrętu"],
        "offer_title": "Kiedy przyjechać na geometrię",
        "offer": [
            ("Auto ściąga na bok", "Samochód zjeżdża w lewo lub prawo, choć trzymasz kierownicę prosto."),
            ("Kierownica stoi krzywo", "Jedziesz prosto, a kierownica jest przekręcona."),
            ("Opony zużywają się nierówno", "Bieżnik ściera się szybciej po wewnętrznej lub zewnętrznej stronie."),
            ("Po wymianie zawieszenia", "Po wymianie drążków, końcówek, wahaczy albo po mocnym uderzeniu w krawężnik."),
        ],
        "bring_title": "Zanim ustawimy geometrię",
        "bring": [
            "Zawieszenie i układ kierowniczy muszą być sprawne i bez luzów.",
            "Śruby regulacyjne nie mogą być zapieczone – jeśli są, odblokujemy je za dopłatą.",
            "Opony w dobrym stanie i brak błędów na desce rozdzielczej.",
        ],
        "price_note": "",
        "prices": [
            ("Dokładny pomiar z danymi, bez regulacji", "80–150 zł"),
            ("Zbieżność przód", "200 zł"),
            ("Geometria przód (zbieżność i kąt pochylenia)", "220 zł"),
            ("Geometria całego auta", "240 zł"),
            ("Geometria BMW / Mercedes", "300 zł"),
            ("Geometria całego auta typu SUV", "300 zł"),
            ("Zbieżność przód – bus", "300 zł"),
            ("Geometria przód – bus", "350 zł"),
            ("Regulacja kąta na „sankach” (grupa VW)", "50–150 zł"),
            ("Zapieczone śruby regulacyjne", "50 zł za stronę"),
            ("Ściągnięcie kół, jeśli potrzebne", "50–100 zł za oś"),
            ("Kalibracja kąta skrętu", "100 zł"),
            ("Diagnostyka komputerowa", "100 zł"),
        ],
        "faq": [
            ("Ile trwa ustawienie geometrii?", "Zwykle od 30 minut do godziny. Dłużej, jeśli trzeba odblokować zapieczone śruby."),
            ("Jak często robić geometrię?", "Po każdej wymianie elementów zawieszenia lub układu kierowniczego, po mocnym uderzeniu w krawężnik i zawsze, gdy auto zaczyna ściągać."),
            ("Czy dostanę wydruk pomiarów?", "Tak – pokazujemy wartości przed regulacją i po niej."),
        ],
        "form": {
            "cta": "Zarezerwuj geometrię",
            "done": "Rezerwacja geometrii wysłana",
            "fields": [
                {"type": "chips", "name": "pojazd", "label": "Typ pojazdu", "req": True,
                 "opts": ["Osobowy", "SUV", "BMW / Mercedes", "Bus"]},
                {"type": "chips", "name": "zakres", "label": "Zakres usługi", "req": True,
                 "opts": ["Sam pomiar", "Zbieżność przód", "Geometria przód", "Geometria całego auta", "Nie wiem, doradźcie"]},
                {"type": "checks", "name": "dodatkowo", "label": "Dodatkowo",
                 "opts": ["Kalibracja kąta skrętu", "Diagnostyka komputerowa"]},
                {"type": "slot", "label": "Preferowany termin", "req": True},
                {"type": "text", "name": "marka", "label": "Marka i model", "ph": "np. Volkswagen Passat B8", "ac": "off"},
                {"type": "textarea", "name": "problem", "label": "Co się dzieje z autem?", "ph": "np. ściąga w prawo, po wymianie końcówek drążków"},
            ],
        },
    },
    {
        "slug": "rejestracja-pojazdow",
        "short": "Rejestracja",
        "name": "Rejestracja pojazdów",
        "sign": ["Rejestracja aut", "akcyza, PCC-3, tłumaczenia"],
        "icon": "plate",
        "phone": "biuro",
        "title": "Rejestracja pojazdów Nowa Sól – auta z zagranicy, akcyza, PCC-3",
        "desc": "Rejestracja samochodu w wydziale komunikacji bez stania w kolejkach. Auta z zagranicy, akcyza, PCC-3, tłumaczenia dokumentów. Amigos Staweccy, Nowa Sól.",
        "lead": "Załatwimy rejestrację w wydziale komunikacji za Ciebie – także auta sprowadzonego z zagranicy. Akcyza, PCC-3 i tłumaczenia w jednym okienku.",
        "card": "Rejestracja w wydziale komunikacji, auta z zagranicy, akcyza, PCC-3 i tłumaczenia.",
        "points": ["Auta z zagranicy", "Akcyza i PCC-3", "Tłumaczenia dokumentów"],
        "offer_title": "Co załatwimy",
        "offer": [
            ("Rejestracja auta kupionego w Polsce", "Przerejestrowanie po zakupie – przygotujemy wniosek i złożymy go w wydziale komunikacji."),
            ("Auto sprowadzone z zagranicy", "Tłumaczenia, akcyza, badanie techniczne i rejestracja – wszystko pod jednym adresem."),
            ("Akcyza i PCC-3", "Przygotujemy i złożymy deklaracje, żebyś nie przegapił terminów."),
            ("Tłumaczenia dokumentów", "Dowód rejestracyjny, umowa lub faktura z zagranicy – przetłumaczymy, co potrzebne."),
        ],
        "bring_title": "Jak to wygląda",
        "bring": [
            "Wysyłasz zgłoszenie z krótkim opisem sprawy.",
            "Oddzwaniamy i mówimy dokładnie, jakie dokumenty przygotować – lista zależy od sprawy.",
            "Przyjeżdżasz raz, podpisujesz pełnomocnictwo, a resztę załatwiamy my.",
        ],
        "price_note": "Koszt zależy od rodzaju sprawy i opłat urzędowych – podamy go przy pierwszej rozmowie.",
        "faq": [
            ("Ile mam czasu na rejestrację auta po zakupie?", "Na zgłoszenie nabycia lub rejestrację masz 30 dni od zakupu albo od sprowadzenia auta do Polski. Po tym terminie grozi kara – lepiej nie zostawiać tego na ostatnią chwilę."),
            ("Czy muszę iść do urzędu osobiście?", "Nie. Na podstawie pełnomocnictwa złożymy dokumenty w wydziale komunikacji w Twoim imieniu."),
            ("Mam auto z Niemiec. Od czego zacząć?", "Od zgłoszenia przez formularz albo telefonu. Badanie techniczne zrobisz u nas na stacji, a tłumaczenia, akcyzę i rejestrację przygotujemy w biurze obok."),
        ],
        "form": {
            "cta": "Wyślij zgłoszenie",
            "done": "Zgłoszenie wysłane",
            "fields": [
                {"type": "chips", "name": "sprawa", "label": "Rodzaj sprawy", "req": True,
                 "opts": ["Pierwsza rejestracja w Polsce", "Przerejestrowanie", "Auto z zagranicy", "Akcyza / PCC-3", "Tłumaczenie dokumentów", "Inna sprawa"]},
                {"type": "slot", "label": "Kiedy chcesz przyjechać", "req": True},
                {"type": "textarea", "name": "opis", "label": "Opisz krótko sytuację", "ph": "np. kupiłem auto w Niemczech 5 dni temu, mam niemiecki brief i umowę"},
            ],
        },
    },
    {
        "slug": "ubezpieczenia",
        "short": "Ubezpieczenia",
        "name": "Ubezpieczenia",
        "sign": ["Ubezpieczenia", "OC, AC, dom, życie"],
        "icon": "shield",
        "phone": "biuro",
        "title": "Ubezpieczenia Nowa Sól – OC, AC, dom, życie, firma",
        "desc": "Ubezpieczenie OC i AC samochodu, domu, na życie i dla firm w Nowej Soli. Poproś o ofertę online – oddzwonimy. Amigos Staweccy, Garbarska 2.",
        "lead": "OC, AC i inne ubezpieczenia. Zostaw numer – przygotujemy ofertę i oddzwonimy w wybranym terminie. Bez wysyłania dokumentów.",
        "card": "OC i AC samochodu, dom, życie i firma – przygotujemy ofertę i oddzwonimy.",
        "points": ["OC i AC", "Dom i mieszkanie", "Życie i firma"],
        "offer_title": "Co ubezpieczamy",
        "offer": [
            ("Samochód: OC, AC, NNW, assistance", "Nowa polisa, przedłużenie albo przejęcie polisy po poprzednim właścicielu auta."),
            ("Dom i mieszkanie", "Mury, wyposażenie i odpowiedzialność cywilna w życiu prywatnym."),
            ("Ubezpieczenie na życie", "Ochrona dla Ciebie i bliskich, dopasowana do budżetu."),
            ("Dla firm", "Majątek, flota i odpowiedzialność cywilna działalności."),
        ],
        "bring_title": "Jak to działa",
        "bring": [
            "Zaznaczasz, czego potrzebujesz, i podajesz numer telefonu.",
            "Oddzwaniamy w wybranym terminie i dopytujemy o szczegóły.",
            "Dostajesz ofertę – decydujesz bez presji.",
        ],
        "price_note": "",
        "faq": [
            ("Czy muszę przesyłać dokumenty?", "Nie. Wszystkiego, czego potrzebujemy do oferty, dowiemy się w rozmowie telefonicznej."),
            ("Kupiłem auto z OC poprzedniego właściciela. Co dalej?", "Polisa przechodzi na Ciebie do końca okresu ubezpieczenia, ale możesz ją wypowiedzieć i wybrać własną. Pomożemy ocenić, co się bardziej opłaca."),
            ("Czy mogę załatwić ubezpieczenie przy rejestracji auta?", "Tak – rejestracja i ubezpieczenia są w tym samym biurze, więc załatwisz obie sprawy podczas jednej wizyty."),
        ],
        "form": {
            "cta": "Poproś o ofertę",
            "done": "Prośba o ofertę wysłana",
            "fields": [
                {"type": "chips", "name": "ubezpieczenie", "label": "Czego potrzebujesz", "req": True,
                 "opts": ["OC / AC samochodu", "Dom / mieszkanie", "Na życie", "Dla firmy", "Turystyczne", "Inne"]},
                {"type": "chips", "name": "polisa", "label": "Polisa", "req": True,
                 "opts": ["Nowa polisa", "Przedłużenie", "Porównanie z obecną"]},
                {"type": "row", "items": [
                    {"type": "date", "name": "data", "label": "Kiedy oddzwonić", "hint": "Puste = najszybciej, jak się da"},
                    {"type": "select", "name": "pora", "label": "Pora dnia", "opts": ["Obojętnie", "Rano", "W południe", "Po południu"]},
                ]},
            ],
        },
    },
]
SVC = {s["slug"]: s for s in SERVICES}


# ---------------------------------------------------------------------------
# FORMULARZE
# ---------------------------------------------------------------------------
def req_mark(f):
    return ' <span class="req" aria-hidden="true">*</span>' if f.get("req") else ' <span class="opt">opcjonalnie</span>'


def render_field(f, sid):
    t = f["type"]
    if t == "row":
        return '<div class="row2">' + "".join(render_field(x, sid) for x in f["items"]) + "</div>"
    if t in ("chips", "checks"):
        kind = "radio" if t == "chips" else "checkbox"
        name = f["name"] if t == "chips" else f["name"] + "[]"
        opts = "".join(
            f'<label class="chip"><input type="{kind}" name="{name}" value="{o}"'
            f'{" required" if (f.get("req") and i == 0 and kind == "radio") else ""}><span>{o}</span></label>'
            for i, o in enumerate(f["opts"]))
        return (f'<fieldset class="fld" data-group="{f["name"]}"><legend>{f["label"]}{req_mark(f)}</legend>'
                f'<div class="chips">{opts}</div><p class="fld__err" aria-live="polite"></p></fieldset>')
    if t == "slot":
        return (f'<div class="row2 row2--slot">'
                f'<div class="fld"><label for="{sid}-data">{f["label"]}{req_mark(f)}</label>'
                f'<input id="{sid}-data" type="date" name="data" data-date{" required" if f.get("req") else ""}>'
                f'<p class="fld__err" aria-live="polite"></p></div>'
                f'<div class="fld"><label for="{sid}-godzina">Godzina{req_mark(f)}</label>'
                f'<select id="{sid}-godzina" name="godzina" data-slots disabled{" required" if f.get("req") else ""}>'
                f'<option value="">Najpierw wybierz dzień</option></select>'
                f'<p class="fld__err" aria-live="polite"></p></div></div>')
    fid = f"{sid}-{f['name']}"
    lab = f'<label for="{fid}">{f["label"]}{req_mark(f)}</label>'
    hint = f'<p class="fld__hint">{f["hint"]}</p>' if f.get("hint") else ""
    err = '<p class="fld__err" aria-live="polite"></p>'
    if t == "text":
        up = ' data-upper' if f.get("upper") else ""
        return (f'<div class="fld">{lab}<input id="{fid}" type="text" name="{f["name"]}" maxlength="80" '
                f'placeholder="{f.get("ph", "")}" autocomplete="{f.get("ac", "on")}"{up}>{hint}{err}</div>')
    if t == "date":
        return f'<div class="fld">{lab}<input id="{fid}" type="date" name="{f["name"]}" data-date data-optional>{hint}{err}</div>'
    if t == "select":
        opts = "".join(f"<option>{o}</option>" for o in f["opts"])
        return f'<div class="fld">{lab}<select id="{fid}" name="{f["name"]}">{opts}</select>{hint}{err}</div>'
    if t == "textarea":
        return (f'<div class="fld">{lab}<textarea id="{fid}" name="{f["name"]}" rows="3" maxlength="800" '
                f'placeholder="{f.get("ph", "")}"></textarea>{err}</div>')
    raise ValueError(t)


def render_form(s, uid=None):
    sid = uid or s["slug"]
    form = s["form"]
    phone = PHONES[s["phone"]][0]
    fields = "".join(render_field(f, sid) for f in form["fields"])
    return f'''<form class="bform" action="/api/zapis" method="post" novalidate data-form data-done="{form["done"]}" data-phone="{phone}">
<input type="hidden" name="usluga" value="{s["slug"]}">
<input type="hidden" name="ts" value="" data-ts>
<div class="hp" aria-hidden="true"><label for="{sid}-www">Zostaw to pole puste</label><input id="{sid}-www" type="text" name="www" tabindex="-1" autocomplete="off"></div>
{fields}
<div class="row2">
<div class="fld"><label for="{sid}-imie">Imię <span class="req" aria-hidden="true">*</span></label><input id="{sid}-imie" type="text" name="imie" required maxlength="60" autocomplete="given-name"><p class="fld__err" aria-live="polite"></p></div>
<div class="fld"><label for="{sid}-telefon">Telefon <span class="req" aria-hidden="true">*</span></label><input id="{sid}-telefon" type="tel" name="telefon" required maxlength="20" inputmode="tel" autocomplete="tel" placeholder="np. 600 100 200"><p class="fld__err" aria-live="polite"></p></div>
</div>
<div class="fld"><label for="{sid}-email">E-mail <span class="opt">opcjonalnie</span></label><input id="{sid}-email" type="email" name="email" maxlength="100" autocomplete="email" placeholder="np. jan@poczta.pl"><p class="fld__err" aria-live="polite"></p></div>
<div class="fld fld--consent"><label class="check"><input type="checkbox" name="zgoda" value="tak" required><span>Zgadzam się na kontakt w sprawie tego zgłoszenia. Dane przetwarzamy zgodnie z <a href="/polityka-prywatnosci">polityką prywatności</a>.</span></label><p class="fld__err" aria-live="polite"></p></div>
<div class="bform__foot">
<button class="btn btn--red btn--lg" type="submit"><span>{form["cta"]}</span></button>
<p class="bform__note">{icon("phone", "ic ic--sm")} {CONTACT_NOTE} Wolisz zadzwonić? <a href="tel:{tel(phone)}">{phone}</a></p>
</div>
<p class="bform__msg" role="alert" hidden></p>
</form>'''


def booking_widget(heading_tag="h2", heading="Umów wizytę online", intro="Wybierz usługę – formularz pokaże tylko to, czego potrzebujemy do tej sprawy."):
    tabs = "".join(
        f'<button class="tab" role="tab" id="tab-{s["slug"]}" aria-controls="panel-{s["slug"]}" '
        f'aria-selected="{"true" if i == 0 else "false"}" tabindex="{0 if i == 0 else -1}" data-tab="{s["slug"]}">'
        f'{icon(s["icon"])}<span>{s["short"]}</span></button>'
        for i, s in enumerate(SERVICES))
    panels = "".join(
        f'<div class="tabpanel" role="tabpanel" id="panel-{s["slug"]}" aria-labelledby="tab-{s["slug"]}"'
        f'{"" if i == 0 else " hidden"}><div class="tabpanel__head"><p class="tabpanel__title">{s["name"]}</p>'
        f'<p>{s["lead"]}</p></div>{render_form(s, "bw-" + s["slug"])}</div>'
        for i, s in enumerate(SERVICES))
    return f'''<div class="booking" data-tabs>
<div class="booking__intro"><{heading_tag} class="h2">{heading}</{heading_tag}><p>{intro}</p></div>
<div class="tabs" role="tablist" aria-label="Wybierz usługę">{tabs}</div>
<div class="booking__panels">{panels}</div>
</div>'''


# ---------------------------------------------------------------------------
# FASADA (ilustracja budynku – sygnatura strony)
# ---------------------------------------------------------------------------
def facade():
    bays = []
    for i, s in enumerate(SERVICES):
        x = 60 + i * 216
        cx = x + 88
        l1, l2 = s["sign"]
        bays.append(f'''<a class="bay" href="/uslugi/{s["slug"]}" aria-label="{s["name"]}">
<clipPath id="cl{i}"><rect x="{x + 13}" y="196" width="150" height="164"/></clipPath>
<rect class="bay__in" x="{x + 13}" y="196" width="150" height="164"/>
<g class="bay__inner" transform="translate({cx - 22} 236)"><g class="bay__ic" transform="scale(1.85)">{ICONS[s["icon"]]}</g></g>
<text class="bay__go" x="{cx}" y="330" text-anchor="middle">Zobacz</text>
<g clip-path="url(#cl{i})"><g class="door"><rect x="{x + 13}" y="196" width="150" height="164" fill="url(#slats)"/><rect x="{x + 13}" y="350" width="150" height="10" class="door__lip"/></g></g>
<rect class="bay__frame" x="{x + 10}" y="193" width="156" height="167" rx="2"/>
<rect class="sign" x="{x + 6}" y="122" width="164" height="50" rx="3"/>
<text class="sign__t" x="{cx}" y="143" text-anchor="middle">{l1}</text>
<text class="sign__s" x="{cx}" y="161" text-anchor="middle">{l2}</text>
</a>''')
    return f'''<div class="facade" data-facade>
<svg viewBox="0 0 1200 400" role="group" aria-label="Budynek Amigos – wybierz usługę">
<defs>
<pattern id="slats" width="10" height="11" patternUnits="userSpaceOnUse"><rect width="10" height="11" fill="#3a4152"/><rect y="9" width="10" height="2" fill="#2d3343"/></pattern>
<linearGradient id="glow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e74f2"/><stop offset="1" stop-color="#0a3c94"/></linearGradient>
</defs>
<rect x="30" y="92" width="1140" height="268" class="wall"/>
<rect x="30" y="84" width="1140" height="12" class="roof"/>
<rect x="566" y="72" width="170" height="14" class="roof roof--back"/>
{''.join(bays)}
<rect x="0" y="360" width="1200" height="40" class="ground"/>
<path d="M120 380h60M300 380h60M480 380h60M660 380h60M840 380h60M1020 380h60" class="lane"/>
<g class="psign" transform="translate(1176 288)"><rect x="-1.5" y="0" width="3" height="72" class="psign__pole"/><rect x="-14" y="-28" width="28" height="28" rx="4" class="psign__plate"/><text x="0" y="-8" text-anchor="middle" class="psign__t">P</text></g>
</svg>
</div>'''


def facade_mobile():
    """Węższy budynek na telefony: wszystkie bramy widać naraz, a bramy po kolei się otwierają."""
    bays = []
    for i, s in enumerate(SERVICES):
        x = 30 + i * 120
        cx = x + 50
        bays.append(f'''<a class="mbay" href="/uslugi/{s["slug"]}" aria-label="{s["name"]}" data-mbay="{i}">
<clipPath id="mcl{i}"><rect x="{x}" y="128" width="100" height="150"/></clipPath>
<rect class="bay__in" fill="url(#mglow)" x="{x}" y="128" width="100" height="150"/>
<g transform="translate({cx - 20} 158)"><g class="bay__ic" transform="scale(1.66)">{ICONS[s["icon"]]}</g></g>
<text class="mbay__go" x="{cx}" y="248" text-anchor="middle">Zobacz</text>
<g clip-path="url(#mcl{i})"><g class="mdoor"><rect x="{x}" y="128" width="100" height="150" fill="url(#mslats)"/><rect x="{x}" y="268" width="100" height="10" class="door__lip"/></g></g>
<rect class="bay__frame" x="{x - 3}" y="125" width="106" height="153" rx="2"/>
<rect class="sign" x="{x - 4}" y="62" width="108" height="46" rx="4"/>
<g transform="translate({cx - 15} 70)"><g class="msign__ic" transform="scale(1.25)">{ICONS[s["icon"]]}</g></g>
</a>''')
    return f'''<div class="facade facade--m" data-mfacade>
<svg viewBox="0 0 640 312" role="group" aria-label="Budynek Amigos – wybierz usługę">
<defs><pattern id="mslats" width="10" height="11" patternUnits="userSpaceOnUse"><rect width="10" height="11" fill="#3a4152"/><rect y="9" width="10" height="2" fill="#2d3343"/></pattern>
<linearGradient id="mglow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e74f2"/><stop offset="1" stop-color="#0a3c94"/></linearGradient></defs>
<rect x="12" y="46" width="616" height="232" class="wall"/>
<rect x="12" y="38" width="616" height="12" class="roof"/>
<rect x="250" y="26" width="140" height="14" class="roof roof--back"/>
{''.join(bays)}
<rect x="0" y="278" width="640" height="34" class="ground"/>
<path d="M60 296h50M240 296h50M420 296h50M580 296h40" class="lane"/>
</svg>
</div>'''


def service_carousel():
    cards = "".join(
        f'<li class="svcar__item"><a class="svcar__card" href="/uslugi/{s["slug"]}" data-svcard="{i}">'
        f'<span class="svcar__ic">{icon(s["icon"])}</span>'
        f'<span class="svcar__txt"><b>{s["short"]}</b><small>{s["sign"][1]}</small></span>'
        f'{icon("chev", "ic svcar__go")}</a></li>'
        for i, s in enumerate(SERVICES))
    dots = "".join(
        f'<button type="button" class="svcar__dot" data-svdot="{i}" aria-label="{s["short"]}"></button>'
        for i, s in enumerate(SERVICES))
    return f'''<div class="svcar" data-svcar>
<ul class="svcar__track" aria-label="Usługi">{cards}</ul>
<div class="svcar__dots">{dots}</div>
</div>'''


# ---------------------------------------------------------------------------
# WSPÓLNE ELEMENTY
# ---------------------------------------------------------------------------
def hours_table(cls="hours"):
    rows = "".join(
        f'<tr data-day="{d}"><th scope="row">{n}</th><td>{f"{o}–{c}" if o else "Zamknięte"}</td></tr>'
        for n, d, o, c in HOURS)
    return f'<table class="{cls}"><caption class="sr">Godziny otwarcia</caption><tbody>{rows}</tbody></table>'


def phones_list():
    return "".join(
        f'<li><a href="tel:{tel(p)}">{icon("phone")}<span><b>{p}</b><small>{lbl}</small></span></a></li>'
        for p, lbl in PHONES.values())


def header(active):
    links = "".join(
        f'<li><a href="/uslugi/{s["slug"]}"{" aria-current=\"page\"" if active == s["slug"] else ""}>'
        f'{icon(s["icon"], "ic nav__ic")}<span>{s["short"]}</span>{icon("chev", "ic nav__chev")}</a></li>'
        for s in SERVICES)
    kontakt_cur = ' aria-current="page"' if active == "kontakt" else ""
    return f'''<a class="skip" href="#main">Przejdź do treści</a>
<header class="hdr" data-hdr>
<div class="wrap hdr__in">
<a class="brand" href="/" aria-label="{BRAND} – strona główna"><img src="/assets/img/logo-96.webp" width="46" height="46" alt=""><span class="brand__txt"><b>Amigos Staweccy</b><small>{CITY}, {STREET}</small></span></a>
<nav class="nav" id="nav" aria-label="Menu główne">
<p class="nav__h">Usługi</p>
<ul class="nav__list">{links}<li><a href="/kontakt"{kontakt_cur}>{icon("pin", "ic nav__ic")}<span>Kontakt</span>{icon("chev", "ic nav__chev")}</a></li></ul>
<div class="nav__extra"><a class="btn btn--red btn--lg btn--block" href="/rezerwacja">{icon("calendar")}Umów wizytę</a><a class="btn btn--ghost btn--lg btn--block" href="tel:{tel(MAIN_PHONE)}">{icon("phone")}Zadzwoń {MAIN_PHONE}</a></div>
</nav>
<a class="hdr__tel" href="tel:{tel(MAIN_PHONE)}">{icon("phone")}<span>{MAIN_PHONE}</span></a>
<a class="btn btn--red hdr__cta" href="/rezerwacja">Umów wizytę</a>
<button class="burger" type="button" aria-expanded="false" aria-controls="nav" aria-label="Otwórz menu" data-burger>{icon("menu", "ic ic--open")}{icon("close", "ic ic--close")}</button>
</div>
</header>'''


def footer():
    svc = "".join(f'<li><a href="/uslugi/{s["slug"]}">{s["name"]}</a></li>' for s in SERVICES)
    return f'''<footer class="ftr">
<div class="wrap ftr__grid">
<div class="ftr__brand">
<a class="brand brand--inv" href="/"><img src="/assets/img/logo-96.webp" width="46" height="46" alt="" loading="lazy"><span class="brand__txt"><b>Amigos Staweccy</b><small>Jeden adres, wiele usług</small></span></a>
<p>{STREET}, {POSTAL} {CITY}<br>{ACCESS}.</p>
<p><a href="mailto:{EMAIL}">{EMAIL}</a></p>
<a class="ftr__fb" href="{FACEBOOK}" rel="noopener" target="_blank">{icon("fb")}<span>Amigos Staweccy na Facebooku</span></a>
</div>
<div><p class="ftr__h">Usługi</p><ul>{svc}</ul></div>
<div><p class="ftr__h">Telefony</p><ul class="ftr__phones">{''.join(f'<li><a href="tel:{tel(p)}">{p}</a> <small>{l}</small></li>' for p, l in PHONES.values())}</ul></div>
<div><p class="ftr__h">Godziny otwarcia</p>{hours_table("hours hours--inv")}</div>
</div>
<div class="wrap ftr__bottom">
<p>© <span data-year>{date.today().year}</span> {BRAND}</p>
<p><a href="/polityka-prywatnosci">Polityka prywatności</a> <a href="/rezerwacja">Rezerwacja online</a> <a href="/kontakt">Kontakt</a></p>
</div>
</footer>
<div class="mbar" data-mbar>
<a class="mbar__call" href="tel:{tel(MAIN_PHONE)}">{icon("phone")}<span>Zadzwoń</span></a>
<a class="mbar__book" href="/rezerwacja">{icon("calendar")}<span>Umów wizytę</span></a>
</div>'''


def local_business_ld():
    days = {1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday", 0: "Sunday"}
    return {
        "@context": "https://schema.org",
        "@type": "AutoRepair",
        "@id": SITE_URL + "/#firma",
        "name": BRAND,
        "slogan": "Jeden adres, wiele usług. U nas załatwisz więcej dla swojego auta.",
        "url": SITE_URL + "/",
        "image": SITE_URL + "/assets/img/obiekt.webp",
        "logo": SITE_URL + "/assets/img/logo-256.png",
        "telephone": tel(MAIN_PHONE),
        "email": EMAIL,
        "priceRange": "$$",
        "address": {"@type": "PostalAddress", "streetAddress": STREET, "postalCode": POSTAL,
                    "addressLocality": CITY, "addressRegion": "lubuskie", "addressCountry": "PL"},
        "areaServed": [CITY, "Kożuchów", "Bytom Odrzański", "Otyń", "Siedlisko", "Nowe Miasteczko"],
        "sameAs": [FACEBOOK],
        "openingHoursSpecification": [
            {"@type": "OpeningHoursSpecification", "dayOfWeek": days[d], "opens": o, "closes": c}
            for n, d, o, c in HOURS if o],
        "department": [
            {"@type": "AutomotiveBusiness", "name": f"{BRAND} – {s['name']}",
             "telephone": tel(PHONES[s["phone"]][0]), "url": f"{SITE_URL}/uslugi/{s['slug']}"}
            for s in SERVICES],
    }


def page(path, title, desc, body, active="", ld=None, noindex=False):
    url_path = "/" if path == "index" else "/" + path.removesuffix("/index")
    canonical = SITE_URL + url_path
    hours_json = json.dumps({str(d): [o, c] for n, d, o, c in HOURS if o}, separators=(",", ":"))
    lds = "".join(f'<script type="application/ld+json">{json.dumps(x, ensure_ascii=False)}</script>' for x in (ld or []))
    robots = '<meta name="robots" content="noindex, follow">' if noindex else '<meta name="robots" content="index, follow, max-image-preview:large">'
    html = f'''<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{desc}">
{robots}
<link rel="canonical" href="{canonical}">
<meta name="theme-color" content="#061a40">
<meta property="og:type" content="website">
<meta property="og:locale" content="pl_PL">
<meta property="og:site_name" content="{BRAND}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{SITE_URL}/assets/img/og.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/assets/img/favicon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/assets/img/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="preload" href="/assets/fonts/archivo-latin-wdth-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/css/style.css?v={VERSION}">
<script src="/assets/js/main.js?v={VERSION}" defer></script>
{lds}
</head>
<body data-hours='{hours_json}' data-slot="{SLOT_MINUTES}" data-ahead="{BOOK_DAYS_AHEAD}">
{header(active)}
<main id="main">
{body}
</main>
{footer()}
</body>
</html>
'''
    out = os.path.join(ROOT, path + ".html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(html)
    return path


VERSION = date.today().strftime("%Y%m%d")


def breadcrumbs_ld(items):
    return {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": i + 1, "name": n, "item": SITE_URL + u} for i, (n, u) in enumerate(items)]}


def faq_ld(faq):
    return {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
        {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faq]}


def faq_block(faq, title="Najczęstsze pytania"):
    items = "".join(f'<details class="faq__item"><summary>{q}{icon("chev", "ic faq__ic")}</summary><p>{a}</p></details>' for q, a in faq)
    return f'<div class="faq"><h2 class="h2">{title}</h2><div class="faq__list">{items}</div></div>'


def promo_banner(slug):
    if PROMO and PROMO["service"] == slug:
        return f'<p class="promo" data-until="{PROMO["until"]}" hidden>{icon("star")}<span>{PROMO["text"]}</span></p>'
    return ""


def service_rows(heading_tag="h3"):
    rows = []
    for s in SERVICES:
        pts = "".join(f"<li>{icon('check', 'ic ic--sm')}{p}</li>" for p in s["points"])
        rows.append(f'''<article class="svc">
<a class="svc__plate" href="/uslugi/{s["slug"]}" tabindex="-1" aria-hidden="true">{icon(s["icon"], "ic ic--xl")}</a>
<div class="svc__body">
<{heading_tag} class="svc__name"><a href="/uslugi/{s["slug"]}">{s["name"]}</a></{heading_tag}>
<p>{s["card"]}</p>
<ul class="svc__pts">{pts}</ul>
{promo_banner(s["slug"])}
</div>
<div class="svc__act">
<a class="btn btn--ghost" href="/uslugi/{s["slug"]}">Zobacz usługę</a>
<a class="btn btn--blue" href="/rezerwacja?usluga={s["slug"]}">Umów</a>
<a class="svc__tel" href="tel:{tel(PHONES[s["phone"]][0])}">{icon("phone", "ic ic--sm")}{PHONES[s["phone"]][0]}</a>
</div>
</article>''')
    return '<div class="svcs">' + "".join(rows) + "</div>"


def location_block(h="h2"):
    return f'''<section class="loc" id="dojazd" aria-labelledby="loc-h">
<div class="wrap loc__grid">
<div class="loc__info">
<{h} class="h2" id="loc-h">Jak do nas trafić</{h}>
<p class="loc__addr">{icon("pin")}<span><b>{STREET}, {POSTAL} {CITY}</b>{ACCESS}. Szukaj białego budynku z niebieskimi szyldami.</span></p>
<div class="loc__status" data-open-status><span class="dot"></span><span data-open-text>Godziny otwarcia</span></div>
{hours_table()}
<ul class="phones">{phones_list()}</ul>
<p class="loc__mail">{icon("mail")}<a href="mailto:{EMAIL}">{EMAIL}</a></p>
</div>
<div class="loc__media">
<figure class="loc__photo"><img src="/assets/img/obiekt-800.webp" srcset="/assets/img/obiekt-800.webp 800w, /assets/img/obiekt.webp 1234w" sizes="(min-width: 960px) 600px, 100vw" width="1234" height="448" alt="Budynek Amigos Staweccy przy ul. Garbarskiej 2 w Nowej Soli – stacja kontroli pojazdów, myjnia, geometria, ubezpieczenia" loading="lazy" decoding="async"></figure>
<div class="map" data-map="{MAPS_EMBED}">
<button class="map__btn" type="button">{icon("pin")}<span>Pokaż mapę</span><small>Mapa ładuje się z Google po kliknięciu</small></button>
</div>
<a class="btn btn--ghost btn--block" href="{MAPS_LINK}" target="_blank" rel="noopener">Wyznacz trasę w Google Maps</a>
</div>
</div>
</section>'''


# ---------------------------------------------------------------------------
# STRONY
# ---------------------------------------------------------------------------
HOME_FAQ = [
    ("Czy mogę załatwić kilka spraw podczas jednej wizyty?", "Tak – po to jesteśmy pod jednym adresem. Możesz np. zrobić przegląd i w tym czasie umyć auto albo zarejestrować samochód i od razu wykupić OC."),
    ("Czy rezerwacja online jest wiążąca?", "Wysłanie formularza to zgłoszenie. Termin staje się pewny, gdy potwierdzimy go telefonicznie – zwykle tego samego dnia w godzinach pracy."),
    ("Gdzie zaparkować?", "Na miejscu jest parking. Wjazd od ulicy Moniuszki."),
    ("Czy obsługujecie auta z zagranicy?", "Tak. Na miejscu zrobisz pierwsze badanie techniczne, a w biurze przygotujemy tłumaczenia, akcyzę, PCC-3, rejestrację i ubezpieczenie."),
    ("Jak odwołać lub przełożyć wizytę?", f"Zadzwoń pod numer {MAIN_PHONE} albo bezpośrednio do działu, w którym masz termin."),
]


def build_home():
    combos = [
        ("Auto z zagranicy, jedna wizyta", ["Pierwsze badanie techniczne na stacji", "Tłumaczenia, akcyza i PCC-3 w biurze", "Rejestracja w wydziale komunikacji", "OC od razu na nowe tablice"], "rejestracja-pojazdow"),
        ("Przegląd i czyste auto", ["Badanie techniczne na stacji", "Mycie ręczne lub czyszczenie wnętrza", "Odbierasz auto gotowe na sezon"], "stacja-kontroli-pojazdow"),
        ("Auto ściąga na bok", ["Diagnostyka komputerowa", "Pomiar geometrii na stanowisku 3D", "Ustawienie z wydrukiem przed i po"], "geometria-kol-3d"),
    ]
    combo_html = "".join(
        f'<article class="combo"><h3 class="combo__t">{t}</h3><ol class="combo__steps">{"".join(f"<li>{x}</li>" for x in steps)}</ol>'
        f'<a class="combo__link" href="/rezerwacja?usluga={slug}">Zacznij od rezerwacji{icon("chev", "ic ic--sm")}</a></article>'
        for t, steps, slug in combos)
    body = f'''<section class="hero" aria-labelledby="hero-h">
<div class="hero__bg" aria-hidden="true"><svg viewBox="0 0 1440 700" preserveAspectRatio="xMidYMid slice"><path d="M-40 520C300 380 700 640 1480 300v420H-40z" class="sw1"/><path d="M-40 600C420 470 860 690 1480 420v300H-40z" class="sw2"/><path d="M-40 470C360 300 820 560 1480 210" class="sw3"/></svg></div>
<div class="wrap hero__top">
<div class="hero__copy">
<p class="hero__rating"><a href="{MAPS_LINK}" target="_blank" rel="noopener">{icon("star")}<b>{GOOGLE_RATING}</b> w Google, {GOOGLE_REVIEWS} opinii</a></p>
<h1 class="hero__h" id="hero-h">Jeden adres, wiele usług dla Twojego auta.</h1>
<p class="hero__lead">Przegląd, myjnia, geometria 3D, rejestracja i ubezpieczenie w Nowej Soli, przy Garbarskiej 2. Zarezerwuj termin online w minutę.</p>
<div class="hero__cta"><a class="btn btn--red btn--lg" href="#rezerwacja">Wybierz usługę</a><a class="btn btn--line btn--lg" href="tel:{tel(MAIN_PHONE)}">{icon("phone")}Zadzwoń {MAIN_PHONE}</a></div>
</div>
<ul class="hero__facts">
<li>{icon("parking")}<span><b>Parking na miejscu</b>wjazd od ul. Moniuszki</span></li>
<li>{icon("clock")}<span><b>Pn–pt do 20:00</b>w sobotę 8:00–14:00</span></li>
</ul>
</div>
<div class="hero__facade">
<div class="wrap"><p class="facade__hint"><span class="on-desk">Wybierz bramę, żeby przejść do usługi</span><span class="on-touch">Dotknij bramy albo przesuń karty, żeby wybrać usługę</span></p></div>
{facade()}
{facade_mobile()}
<div class="hero__ground">{service_carousel()}</div>
</div>
</section>

<section class="sec" id="uslugi" aria-labelledby="uslugi-h">
<div class="wrap">
<div class="sec__head"><h2 class="h2" id="uslugi-h">Pięć usług pod jednym dachem</h2><p>Każda sprawa ma swoją bramę i swój numer telefonu. Rezerwacja online działa dla wszystkich.</p></div>
{service_rows()}
</div>
</section>

<section class="sec sec--paper" aria-labelledby="how-h">
<div class="wrap">
<div class="sec__head"><h2 class="h2" id="how-h">Rezerwacja w trzech krokach</h2></div>
<ol class="steps">
<li><b>Wybierz usługę</b><span>Formularz pyta tylko o to, czego potrzebujemy do danej sprawy.</span></li>
<li><b>Podaj termin i telefon</b><span>Wybierz dzień i godzinę w czasie, gdy jesteśmy otwarci.</span></li>
<li><b>Potwierdzamy telefonicznie</b><span>Oddzwaniamy, zwykle tego samego dnia, i termin jest Twój.</span></li>
</ol>
</div>
</section>

<section class="sec sec--book" id="rezerwacja" aria-label="Rezerwacja online">
<div class="wrap">{booking_widget()}</div>
</section>

<section class="sec" aria-labelledby="combo-h">
<div class="wrap">
<div class="sec__head"><h2 class="h2" id="combo-h">Załatw dwie sprawy za jednym przyjazdem</h2><p>Wszystkie stanowiska są w jednym budynku. Tak klienci łączą wizyty najczęściej.</p></div>
<div class="combos">{combo_html}</div>
</div>
</section>

{location_block()}

<section class="sec" aria-label="Najczęstsze pytania">
<div class="wrap wrap--narrow">{faq_block(HOME_FAQ)}</div>
</section>'''
    ld = [local_business_ld(), faq_ld(HOME_FAQ),
          {"@context": "https://schema.org", "@type": "WebSite", "name": BRAND, "url": SITE_URL + "/", "inLanguage": "pl-PL"}]
    return page("index", "Amigos Staweccy Nowa Sól – przegląd, myjnia, geometria 3D, rejestracja, ubezpieczenia",
                "Stacja kontroli pojazdów, myjnia ręczna, geometria kół 3D, rejestracja pojazdów i ubezpieczenia w Nowej Soli, Garbarska 2. Umów wizytę online.",
                body, "home", ld)


def build_service(s):
    phone = PHONES[s["phone"]][0]
    offer = "".join(f'<li><b>{t}</b><span>{d}</span></li>' for t, d in s["offer"])
    bring = "".join(f'<li>{icon("check", "ic ic--sm")}<span>{b}</span></li>' for b in s["bring"])
    prices = ""
    if s.get("prices"):
        rows = "".join(f"<tr><th scope=\"row\">{n}</th><td>{p}</td></tr>" for n, p in s["prices"])
        prices = f'''<section class="block" aria-labelledby="cennik-h"><h2 class="h3" id="cennik-h">Cennik</h2>
{promo_banner(s["slug"])}
<table class="prices"><caption class="sr">Cennik usług geometrii</caption><tbody>{rows}</tbody></table>
<p class="muted">Ceny regularne brutto. Ostateczny koszt zależy od auta i stanu zawieszenia – powiemy o nim przed regulacją.</p></section>'''
    note = f'<p class="note">{s["price_note"]}</p>' if s.get("price_note") else ""
    others = "".join(f'<li><a href="/uslugi/{o["slug"]}">{icon(o["icon"], "ic ic--sm")}{o["name"]}</a></li>' for o in SERVICES if o is not s)
    body = f'''<section class="phero">
<div class="hero__bg" aria-hidden="true"><svg viewBox="0 0 1440 400" preserveAspectRatio="xMidYMid slice"><path d="M-40 330C380 220 840 400 1480 160v260H-40z" class="sw1"/><path d="M-40 380C420 300 900 430 1480 280" class="sw3"/></svg></div>
<div class="wrap">
<nav class="crumbs" aria-label="Okruszki"><ol><li><a href="/">Strona główna</a></li><li><a href="/uslugi">Usługi</a></li><li aria-current="page">{s["name"]}</li></ol></nav>
<div class="phero__grid">
<div class="phero__plate">{icon(s["icon"], "ic ic--xl")}</div>
<div><h1 class="phero__h">{s["name"]}</h1><p class="phero__lead">{s["lead"]}</p>
<div class="hero__cta"><a class="btn btn--red btn--lg" href="#formularz">Umów termin</a><a class="btn btn--line btn--lg" href="tel:{tel(phone)}">{icon("phone")}{phone}</a></div></div>
</div>
</div>
</section>
<div class="wrap svcpage">
<div class="svcpage__main">
<section class="block" aria-labelledby="oferta-h"><h2 class="h3" id="oferta-h">{s["offer_title"]}</h2><ul class="offer">{offer}</ul>{note}</section>
{prices}
<section class="block" aria-labelledby="info-h"><h2 class="h3" id="info-h">{s["bring_title"]}</h2><ul class="ticks">{bring}</ul></section>
<section class="block">{faq_block(s["faq"])}</section>
<section class="block" aria-labelledby="inne-h"><h2 class="h3" id="inne-h">Przy okazji załatwisz też</h2><ul class="others">{others}</ul></section>
</div>
<aside class="svcpage__side" id="formularz" aria-labelledby="form-h">
<div class="sidecard">
<h2 class="sidecard__h" id="form-h">{s["form"]["cta"]}</h2>
{render_form(s)}
</div>
</aside>
</div>
{location_block()}'''
    ld = [local_business_ld(), faq_ld(s["faq"]),
          breadcrumbs_ld([("Strona główna", "/"), ("Usługi", "/uslugi"), (s["name"], "/uslugi/" + s["slug"])]),
          {"@context": "https://schema.org", "@type": "Service", "name": s["name"], "serviceType": s["name"],
           "description": s["lead"], "areaServed": CITY, "provider": {"@id": SITE_URL + "/#firma"},
           "url": f"{SITE_URL}/uslugi/{s['slug']}"}]
    return page("uslugi/" + s["slug"], s["title"] + " | Amigos", s["desc"], body, s["slug"], ld)


def simple_hero(h1, lead, crumbs):
    cr = "".join(f'<li><a href="{u}">{n}</a></li>' for n, u in crumbs)
    return f'''<section class="phero phero--simple">
<div class="hero__bg" aria-hidden="true"><svg viewBox="0 0 1440 400" preserveAspectRatio="xMidYMid slice"><path d="M-40 330C380 220 840 400 1480 160v260H-40z" class="sw1"/><path d="M-40 380C420 300 900 430 1480 280" class="sw3"/></svg></div>
<div class="wrap"><nav class="crumbs" aria-label="Okruszki"><ol><li><a href="/">Strona główna</a></li>{cr}<li aria-current="page">{h1}</li></ol></nav>
<h1 class="phero__h">{h1}</h1><p class="phero__lead">{lead}</p></div></section>'''


def build_uslugi():
    body = simple_hero("Usługi", "Wszystko, co załatwisz w Amigos przy Garbarskiej 2 w Nowej Soli.", []) + f'''
<section class="sec"><div class="wrap">{service_rows("h2")}</div></section>'''
    return page("uslugi/index", "Usługi – przegląd, myjnia, geometria, rejestracja, ubezpieczenia | Amigos Staweccy",
                "Stacja kontroli pojazdów, myjnia ręczna, geometria kół 3D, rejestracja pojazdów i ubezpieczenia w Nowej Soli. Wybierz usługę i umów wizytę online.",
                body, "uslugi", [breadcrumbs_ld([("Strona główna", "/"), ("Usługi", "/uslugi")])])


def build_rezerwacja():
    body = simple_hero("Rezerwacja online", "Wybierz usługę, dzień i godzinę. Oddzwonimy, żeby potwierdzić termin.", []) + f'''
<section class="sec sec--book sec--tight"><div class="wrap">{booking_widget("h2", "Wybierz usługę", "Formularz dopasuje się do sprawy – zajmie Ci to mniej niż minutę.")}</div></section>
<section class="sec sec--paper"><div class="wrap">
<ol class="steps">
<li><b>Wysyłasz zgłoszenie</b><span>Termin w formularzu to Twoja propozycja.</span></li>
<li><b>Oddzwaniamy</b><span>Zwykle tego samego dnia, w godzinach pracy.</span></li>
<li><b>Przyjeżdżasz</b><span>{STREET}, {ACCESS.lower()}.</span></li>
</ol></div></section>'''
    return page("rezerwacja", "Rezerwacja online – umów wizytę | Amigos Staweccy Nowa Sól",
                "Umów przegląd, mycie, geometrię kół, rejestrację pojazdu lub rozmowę o ubezpieczeniu w Amigos w Nowej Soli. Rezerwacja online w minutę.",
                body, "rezerwacja", [local_business_ld()])


def build_kontakt():
    body = simple_hero("Kontakt", "Zadzwoń bezpośrednio do działu albo przyjedź – jesteśmy przy Garbarskiej 2 w Nowej Soli.", []) + f'''
<section class="sec sec--tight"><div class="wrap">
<div class="depts">{"".join(f'<a class="dept" href="tel:{tel(p)}"><span class="dept__l">{l}</span><b class="dept__p">{icon("phone")}{p}</b></a>' for p, l in PHONES.values())}
<a class="dept" href="mailto:{EMAIL}"><span class="dept__l">E-mail</span><b class="dept__p">{icon("mail")}{EMAIL}</b></a></div>
</div></section>
{location_block()}'''
    return page("kontakt", "Kontakt i dojazd – Amigos Staweccy, Garbarska 2, Nowa Sól",
                "Telefony do stacji kontroli pojazdów, geometrii i biura, godziny otwarcia i dojazd do Amigos Staweccy w Nowej Soli.",
                body, "kontakt", [local_business_ld()])


def build_privacy():
    body = simple_hero("Polityka prywatności", "Jakie dane zbieramy przez formularze i co z nimi robimy.", []) + f'''
<section class="sec"><div class="wrap wrap--narrow prose">
<h2>Kto jest administratorem danych</h2>
<p>Administratorem danych osobowych jest {BRAND}, {STREET}, {POSTAL} {CITY} <span class="todo">[uzupełnij pełną nazwę firmy, NIP i REGON]</span>. W sprawach danych osobowych napisz na <a href="mailto:{EMAIL}">{EMAIL}</a> lub zadzwoń pod numer {MAIN_PHONE}.</p>
<h2>Jakie dane zbieramy</h2>
<p>Przez formularze rezerwacji zbieramy tylko to, co jest potrzebne do obsługi zgłoszenia: imię, numer telefonu, opcjonalnie adres e-mail, wybraną usługę, preferowany termin oraz informacje, które sam wpiszesz (np. markę auta, numer rejestracyjny lub opis sprawy).</p>
<h2>Po co i na jakiej podstawie</h2>
<p>Dane przetwarzamy, aby skontaktować się z Tobą, potwierdzić termin i wykonać usługę (art. 6 ust. 1 lit. b RODO – działania przed zawarciem umowy) oraz na podstawie Twojej zgody wyrażonej w formularzu (art. 6 ust. 1 lit. a RODO). Zgodę możesz w każdej chwili wycofać.</p>
<h2>Jak długo przechowujemy dane</h2>
<p>Dane ze zgłoszenia przechowujemy do czasu jego obsługi, a jeśli dojdzie do wykonania usługi – przez okres wymagany przepisami podatkowymi i rachunkowymi. Zgłoszenia, które nie zakończyły się wizytą, usuwamy najpóźniej po 12 miesiącach.</p>
<h2>Komu przekazujemy dane</h2>
<p>Dane mogą trafić do dostawców usług technicznych, z których korzystamy do działania strony i poczty (hosting, wysyłka e-maili), wyłącznie w zakresie niezbędnym do obsługi zgłoszenia. W sprawach rejestracji pojazdów i ubezpieczeń dane przekazujemy urzędom lub towarzystwom ubezpieczeniowym tylko wtedy, gdy zlecisz nam taką sprawę.</p>
<h2>Twoje prawa</h2>
<p>Masz prawo dostępu do swoich danych, ich sprostowania, usunięcia, ograniczenia przetwarzania, przeniesienia oraz sprzeciwu. Możesz też złożyć skargę do Prezesa Urzędu Ochrony Danych Osobowych.</p>
<h2>Pliki cookies i mapy</h2>
<p>Strona nie używa cookies śledzących ani narzędzi analitycznych. Mapa Google ładuje się dopiero po kliknięciu „Pokaż mapę” – wtedy Google może zapisać własne pliki cookies zgodnie ze swoją polityką prywatności.</p>
</div></section>'''
    return page("polityka-prywatnosci", "Polityka prywatności | Amigos Staweccy",
                "Informacje o przetwarzaniu danych osobowych w formularzach rezerwacji Amigos Staweccy.", body, "pp")


def build_thanks():
    body = f'''<section class="phero phero--simple phero--center">
<div class="wrap wrap--narrow"><div class="thanks__ic">{icon("check", "ic ic--xl")}</div>
<h1 class="phero__h">Zgłoszenie wysłane</h1>
<p class="phero__lead">Oddzwonimy, żeby potwierdzić termin – zwykle tego samego dnia w godzinach pracy. W pilnej sprawie zadzwoń: <a href="tel:{tel(MAIN_PHONE)}">{MAIN_PHONE}</a>.</p>
<div class="hero__cta hero__cta--center"><a class="btn btn--red btn--lg" href="/">Wróć na stronę główną</a></div></div></section>'''
    return page("dziekujemy", "Zgłoszenie wysłane | Amigos Staweccy", "Dziękujemy za zgłoszenie.", body, "", noindex=True)


def build_404():
    links = "".join(f'<li><a href="/uslugi/{s["slug"]}">{icon(s["icon"], "ic ic--sm")}{s["name"]}</a></li>' for s in SERVICES)
    body = f'''<section class="phero phero--simple phero--center">
<div class="wrap wrap--narrow">
<p class="big404">404</p>
<h1 class="phero__h">Tej strony tu nie ma</h1>
<p class="phero__lead">Adres mógł się zmienić. Wybierz usługę albo wróć na stronę główną.</p>
<div class="hero__cta hero__cta--center"><a class="btn btn--red btn--lg" href="/">Strona główna</a><a class="btn btn--line btn--lg" href="/rezerwacja">Umów wizytę</a></div>
</div></section>
<section class="sec sec--tight"><div class="wrap wrap--narrow"><ul class="others">{links}</ul></div></section>'''
    return page("404", "Nie znaleziono strony | Amigos Staweccy", "Strona nie istnieje.", body, "", noindex=True)


def write(name, content):
    with open(os.path.join(ROOT, name), "w", encoding="utf-8") as fh:
        fh.write(content)


def build_meta(paths):
    today = date.today().isoformat()
    prio = {"index": "1.0", "rezerwacja": "0.9", "kontakt": "0.8", "uslugi/index": "0.8", "polityka-prywatnosci": "0.2"}
    urls = "".join(
        f"<url><loc>{SITE_URL}{'/' if p == 'index' else '/' + p.removesuffix('/index')}</loc><lastmod>{today}</lastmod>"
        f"<priority>{prio.get(p, '0.9')}</priority></url>\n"
        for p in paths if p not in ("404", "dziekujemy"))
    write("sitemap.xml", f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}</urlset>\n')
    write("robots.txt", f"User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: {SITE_URL}/sitemap.xml\n")
    write("site.webmanifest", json.dumps({
        "name": BRAND, "short_name": "Amigos", "lang": "pl", "start_url": "/", "display": "standalone",
        "background_color": "#061a40", "theme_color": "#061a40",
        "icons": [{"src": "/assets/img/icon-192.png", "sizes": "192x192", "type": "image/png"},
                  {"src": "/assets/img/icon-512.png", "sizes": "512x512", "type": "image/png"}]},
        ensure_ascii=False, indent=2))
    # konfiguracja dla API (lista usług, nazwy) – używana przez api/zapis.js
    os.makedirs(os.path.join(ROOT, "api"), exist_ok=True)
    write("api/_uslugi.json", json.dumps(
        {s["slug"]: {"name": s["name"], "phone": PHONES[s["phone"]][0]} for s in SERVICES}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    out = [build_home(), build_uslugi(), build_rezerwacja(), build_kontakt(), build_privacy(), build_thanks(), build_404()]
    out += [build_service(s) for s in SERVICES]
    build_meta(out)
    print("Zbudowano:", ", ".join(out))

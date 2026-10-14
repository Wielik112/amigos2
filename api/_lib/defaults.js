/**
 * DOMYŚLNE USTAWIENIA GRAFIKU – wartości przykładowe (prototyp), do podmiany na dane od firmy.
 *
 * Używane tylko przy pierwszym przygotowaniu bazy (wdrożenie / `npm run seed`): wartości trafiają do bazy
 * i dalej zmienia się je w panelu (/admin → Grafik, Usługi). Zmiana tego pliku NIE nadpisuje tego,
 * co już jest w bazie – żeby wgrać nowe liczby od zera, użyj w panelu „Usługi → Przywróć domyślne czasy”.
 *
 * Czas wizyty = base + suma minut z wybranych opcji formularza (nazwy opcji muszą być takie jak w src/build.py).
 */
module.exports = {
  // Stanowiska i usługi, które obsługują. Wspólne stanowisko (Biuro) = wizyta w jednej usłudze blokuje drugą.
  resources: [
    { name: "Stacja kontroli – linia 1", services: ["stacja-kontroli-pojazdow"] },
    { name: "Stacja kontroli – linia 2", services: ["stacja-kontroli-pojazdow"] },
    { name: "Myjnia – stanowisko 1", services: ["myjnia-reczna"] },
    { name: "Myjnia – stanowisko 2", services: ["myjnia-reczna"] },
    { name: "Geometria – stanowisko 3D", services: ["geometria-kol-3d"] },
    { name: "Biuro", services: ["rejestracja-pojazdow", "ubezpieczenia"] },
  ],

  // Przerwa w dni powszednie (pon–pt), wycinana z godzin otwarcia. null = bez przerwy.
  weekdayBreak: ["13:00", "13:30"],

  services: {
    "stacja-kontroli-pojazdow": {
      base: 0, buffer: 5, step: 15, notice: 60, daysAhead: 60,
      durations: {
        pojazd: { "Osobowy": 30, "Osobowy z LPG": 40, "Dostawczy do 3,5 t": 40, "Motocykl / motorower": 20, "Przyczepa": 20, "Inny": 30 },
        badanie: { "Okresowe": 0, "Pierwsze – pojazd z zagranicy": 30, "Dodatkowe": 0, "Nie wiem, doradźcie": 10 },
      },
    },
    "myjnia-reczna": {
      base: 0, buffer: 10, step: 30, notice: 120, daysAhead: 45,
      durations: {
        pakiet: { "Mycie ręczne nadwozia": 45, "Mycie z odkurzaniem": 75, "Czyszczenie wnętrza": 150, "Pakiet komplet": 180, "Doradźcie mi": 60 },
        pojazd: { "Osobowy": 0, "SUV / kombi": 15, "Bus / dostawczy": 30 },
      },
    },
    "geometria-kol-3d": {
      base: 0, buffer: 10, step: 30, notice: 120, daysAhead: 60,
      durations: {
        pojazd: { "Osobowy": 0, "SUV": 10, "BMW / Mercedes": 15, "Bus": 15 },
        zakres: { "Sam pomiar": 20, "Zbieżność przód": 30, "Geometria przód": 45, "Geometria całego auta": 60, "Nie wiem, doradźcie": 45 },
        dodatkowo: { "Kalibracja kąta skrętu": 15, "Diagnostyka komputerowa": 15 },
      },
    },
    "rejestracja-pojazdow": {
      base: 0, buffer: 5, step: 15, notice: 60, daysAhead: 30,
      durations: {
        sprawa: { "Pierwsza rejestracja w Polsce": 30, "Przerejestrowanie": 20, "Auto z zagranicy": 45, "Akcyza / PCC-3": 30, "Tłumaczenie dokumentów": 15, "Inna sprawa": 30 },
      },
    },
    "ubezpieczenia": { base: 30, buffer: 0, step: 30, notice: 0, daysAhead: 60, durations: {} },
  },
};

-- Etap 1: zamiast pre-generowanych slotów – grafik tygodniowy, stanowiska i czas trwania zależny od wyboru klienta.
-- Wolne godziny są liczone na bieżąco; rezerwacja zajmuje stanowisko na [start, koniec + zapas).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Zasady usługi
ALTER TABLE services RENAME COLUMN slot_duration_minutes TO base_minutes;
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_slot_duration_minutes_check;
ALTER TABLE services
  ADD CONSTRAINT services_base_minutes_check CHECK (base_minutes BETWEEN 0 AND 480),
  ADD COLUMN buffer_minutes     integer NOT NULL DEFAULT 10 CHECK (buffer_minutes BETWEEN 0 AND 120),       -- zapas po wizycie
  ADD COLUMN step_minutes       integer NOT NULL DEFAULT 30 CHECK (step_minutes IN (5, 10, 15, 20, 30, 60)), -- co ile minut pokazujemy godziny startu
  ADD COLUMN min_notice_minutes integer NOT NULL DEFAULT 60 CHECK (min_notice_minutes BETWEEN 0 AND 10080),  -- najwcześniej za ile minut od teraz
  ADD COLUMN max_days_ahead     integer NOT NULL DEFAULT 60 CHECK (max_days_ahead BETWEEN 1 AND 365),
  ADD COLUMN closed_on_holidays boolean NOT NULL DEFAULT true,
  ADD COLUMN duration_rules     jsonb   NOT NULL DEFAULT '{}'::jsonb,  -- { "pole": { "opcja": minuty } }, czas = base + suma
  ADD COLUMN defaults_applied   boolean NOT NULL DEFAULT false;        -- seed wpisał już wartości z defaults.js (potem rządzi panel)

-- Stanowiska (linie diagnostyczne, stanowiska myjni, biurko w biurze…). Jedno stanowisko może obsługiwać kilka usług –
-- wtedy wizyta w jednej usłudze blokuje to stanowisko także dla pozostałych.
CREATE TABLE resources (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  sort       integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_resources (
  service_id  integer NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  resource_id integer NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  PRIMARY KEY (service_id, resource_id)
);

-- Grafik tygodniowy: przedziały godzin pracy (przerwa = dwa przedziały w jednym dniu). weekday: 1 = pon … 7 = niedz.
CREATE TABLE service_hours (
  id         serial PRIMARY KEY,
  service_id integer NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  weekday    integer NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time time NOT NULL,
  end_time   time NOT NULL,
  CHECK (end_time > start_time)
);
CREATE INDEX service_hours_service ON service_hours (service_id, weekday);

-- Wyjątki: dzień wolny albo inne godziny (service_id NULL = wszystkie usługi). Wyjątek usługi ma pierwszeństwo przed ogólnym.
CREATE TABLE schedule_exceptions (
  id         serial PRIMARY KEY,
  service_id integer REFERENCES services(id) ON DELETE CASCADE,
  day        date NOT NULL,
  closed     boolean NOT NULL DEFAULT true,
  start_time time,
  end_time   time,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (closed OR (start_time IS NOT NULL AND end_time > start_time))
);
CREATE UNIQUE INDEX schedule_exceptions_day ON schedule_exceptions (coalesce(service_id, 0), day);

-- Ręczne blokady czasu (np. awaria, szkolenie): na całą usługę albo na jedno stanowisko.
CREATE TABLE time_blocks (
  id          serial PRIMARY KEY,
  service_id  integer REFERENCES services(id) ON DELETE CASCADE,
  resource_id integer REFERENCES resources(id) ON DELETE CASCADE,
  start_at    timestamptz NOT NULL,
  end_at      timestamptz NOT NULL,
  reason      text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK (service_id IS NOT NULL OR resource_id IS NOT NULL)
);
CREATE INDEX time_blocks_range ON time_blocks (start_at, end_at);

-- Rezerwacje: konkretne stanowisko i przedział czasu zamiast slotu
ALTER TABLE bookings
  ADD COLUMN resource_id integer REFERENCES resources(id),
  ADD COLUMN start_at    timestamptz,
  ADD COLUMN end_at      timestamptz,
  ADD COLUMN block_until timestamptz,      -- koniec wizyty + zapas (do tego momentu stanowisko jest zajęte)
  ADD COLUMN source      text NOT NULL DEFAULT 'online' CHECK (source IN ('online', 'telefon'));

UPDATE bookings b SET start_at = s.start_at, end_at = s.end_at, block_until = s.end_at FROM slots s WHERE s.id = b.slot_id;

DROP INDEX IF EXISTS bookings_active_seat;
DROP INDEX IF EXISTS bookings_slot;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_check;   -- (slot_id IS NULL) = (seat IS NULL)
ALTER TABLE bookings DROP COLUMN slot_id, DROP COLUMN seat;
DROP TABLE slots;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_time_check CHECK (
    (start_at IS NULL AND end_at IS NULL AND block_until IS NULL)
    OR (start_at IS NOT NULL AND end_at > start_at AND block_until >= end_at)),
  -- Ochrona przed podwójną rezerwacją na poziomie bazy: dwie aktywne rezerwacje na tym samym
  -- stanowisku nie mogą na siebie nachodzić (łącznie z zapasem po wizycie).
  ADD CONSTRAINT bookings_no_overlap EXCLUDE USING gist (resource_id WITH =, tstzrange(start_at, block_until) WITH &&)
    WHERE (status IN ('pending_payment', 'confirmed') AND resource_id IS NOT NULL);
CREATE INDEX bookings_start ON bookings (start_at);
CREATE INDEX bookings_resource_start ON bookings (resource_id, start_at);

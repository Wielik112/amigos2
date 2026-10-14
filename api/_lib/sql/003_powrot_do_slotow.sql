-- Powrót do modelu ze slotami. Działa tylko w bazie, w której była już wgrana wycofana wersja
-- z grafikiem i stanowiskami (002_grafik.sql): odtwarza tabelę slotów, przypina do niej rezerwacje
-- i generuje sloty na 2 tygodnie z zapisanych godzin pracy. W każdej innej bazie nic nie robi.
DO $$
BEGIN
  IF to_regclass('public.slots') IS NOT NULL OR to_regclass('public.resources') IS NULL THEN
    RETURN;
  END IF;

  CREATE TABLE slots (
    id         bigserial PRIMARY KEY,
    service_id integer NOT NULL REFERENCES services(id),
    start_at   timestamptz NOT NULL,
    end_at     timestamptz NOT NULL,
    capacity   integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 50),
    blocked    boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (end_at > start_at),
    UNIQUE (service_id, start_at)
  );

  -- sloty dla istniejących rezerwacji (pojemność = liczba aktywnych wizyt o tej godzinie)
  INSERT INTO slots (service_id, start_at, end_at, capacity)
  SELECT service_id, start_at, max(end_at),
         greatest(1, count(*) FILTER (WHERE status IN ('pending_payment', 'confirmed')))
    FROM bookings WHERE start_at IS NOT NULL
   GROUP BY service_id, start_at;

  -- sloty na 2 tygodnie z grafiku tygodniowego (co 30 min, pojemność = liczba stanowisk usługi)
  INSERT INTO slots (service_id, start_at, end_at, capacity)
  SELECT h.service_id,
         ((d::date + h.start_time) + make_interval(mins => m))::timestamp AT TIME ZONE 'Europe/Warsaw',
         ((d::date + h.start_time) + make_interval(mins => m + 30))::timestamp AT TIME ZONE 'Europe/Warsaw',
         greatest(1, (SELECT count(*) FROM service_resources sr JOIN resources r ON r.id = sr.resource_id
                       WHERE sr.service_id = h.service_id AND r.active))
    FROM service_hours h
    CROSS JOIN generate_series(current_date, current_date + 13, interval '1 day') d
    CROSS JOIN LATERAL generate_series(0, (extract(epoch FROM h.end_time - h.start_time) / 60)::int - 30, 30) m
   WHERE extract(isodow FROM d)::int = h.weekday
     AND ((d::date + h.start_time) + make_interval(mins => m))::timestamp AT TIME ZONE 'Europe/Warsaw' > now()
  ON CONFLICT (service_id, start_at) DO NOTHING;

  -- rezerwacje: z powrotem slot + numer miejsca
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_no_overlap;
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_time_check;
  ALTER TABLE bookings ADD COLUMN slot_id bigint REFERENCES slots(id) ON DELETE RESTRICT, ADD COLUMN seat integer;
  UPDATE bookings b SET slot_id = s.id FROM slots s WHERE s.service_id = b.service_id AND s.start_at = b.start_at;
  WITH n AS (
    SELECT id, row_number() OVER (PARTITION BY slot_id ORDER BY (status IN ('pending_payment', 'confirmed')) DESC, created_at) AS rn
      FROM bookings WHERE slot_id IS NOT NULL)
  UPDATE bookings b SET seat = n.rn FROM n WHERE n.id = b.id;
  ALTER TABLE bookings ADD CONSTRAINT bookings_check CHECK ((slot_id IS NULL) = (seat IS NULL));
  CREATE UNIQUE INDEX bookings_active_seat ON bookings (slot_id, seat) WHERE status IN ('pending_payment', 'confirmed');
  CREATE INDEX bookings_slot ON bookings (slot_id);
  ALTER TABLE bookings DROP COLUMN resource_id, DROP COLUMN start_at, DROP COLUMN end_at, DROP COLUMN block_until, DROP COLUMN source;

  DROP TABLE time_blocks, schedule_exceptions, service_hours, service_resources, resources;

  ALTER TABLE services DROP CONSTRAINT IF EXISTS services_base_minutes_check;
  ALTER TABLE services RENAME COLUMN base_minutes TO slot_duration_minutes;
  UPDATE services SET slot_duration_minutes = 30;
  ALTER TABLE services ADD CONSTRAINT services_slot_duration_minutes_check CHECK (slot_duration_minutes BETWEEN 5 AND 480);
  ALTER TABLE services DROP COLUMN buffer_minutes, DROP COLUMN step_minutes, DROP COLUMN min_notice_minutes,
    DROP COLUMN max_days_ahead, DROP COLUMN closed_on_holidays, DROP COLUMN duration_rules, DROP COLUMN defaults_applied;
END $$;

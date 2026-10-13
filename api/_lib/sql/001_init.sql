-- Amigos – system rezerwacji. Wszystkie znaczniki czasu w UTC (timestamptz),
-- dni i godziny „lokalne” liczymy zawsze przez AT TIME ZONE 'Europe/Warsaw'.

CREATE TABLE services (
  id                    serial PRIMARY KEY,
  slug                  text NOT NULL UNIQUE,
  name                  text NOT NULL,
  deposit_amount        integer NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),       -- w groszach
  deposit_required      boolean NOT NULL DEFAULT false,
  slot_duration_minutes integer NOT NULL DEFAULT 30 CHECK (slot_duration_minutes BETWEEN 5 AND 480),
  uses_slots            boolean NOT NULL DEFAULT true,  -- false = prośba o kontakt (ubezpieczenia), bez terminu
  active                boolean NOT NULL DEFAULT true,
  sort                  integer NOT NULL DEFAULT 0
);

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

CREATE TABLE bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id      integer NOT NULL REFERENCES services(id),
  -- RESTRICT: slotu z historią rezerwacji nie da się usunąć (można go tylko zablokować)
  slot_id         bigint REFERENCES slots(id) ON DELETE RESTRICT,
  seat            integer,             -- numer miejsca w slocie (1..capacity)
  status          text NOT NULL CHECK (status IN ('pending_payment', 'confirmed', 'expired', 'cancelled')),
  customer_name   text NOT NULL,
  phone           text NOT NULL,
  email           text,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes           text,
  consent_at      timestamptz NOT NULL,
  payment_id      uuid,
  hold_expires_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  cancelled_at    timestamptz,
  cancel_reason   text,
  cancelled_by    text,
  CHECK ((slot_id IS NULL) = (seat IS NULL)),
  CHECK (status <> 'pending_payment' OR hold_expires_at IS NOT NULL)
);

-- Ochrona przed podwójną rezerwacją na poziomie bazy: jedno miejsce w slocie
-- może mieć najwyżej jedną aktywną rezerwację (wstrzymaną albo potwierdzoną).
CREATE UNIQUE INDEX bookings_active_seat ON bookings (slot_id, seat)
  WHERE status IN ('pending_payment', 'confirmed');
CREATE INDEX bookings_slot ON bookings (slot_id);
CREATE INDEX bookings_pending_hold ON bookings (hold_expires_at) WHERE status = 'pending_payment';
CREATE INDEX bookings_service_created ON bookings (service_id, created_at);

CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES bookings(id),
  provider     text NOT NULL CHECK (provider IN ('mock', 'stripe')),
  provider_ref text,
  amount       integer NOT NULL CHECK (amount > 0),
  currency     text NOT NULL DEFAULT 'PLN',
  status       text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'expired', 'refunded')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_provider_ref ON payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX payments_booking ON payments (booking_id);
ALTER TABLE bookings ADD CONSTRAINT bookings_payment_fk FOREIGN KEY (payment_id) REFERENCES payments(id);

CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id),
  type       text NOT NULL CHECK (type IN ('booking_confirmed', 'booking_cancelled')),
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, type)   -- powtórzone zdarzenie nie zdubluje powiadomienia
);
CREATE INDEX notifications_unread ON notifications (created_at) WHERE read_at IS NULL;

-- Idempotencja webhooków: każde zdarzenie dostawcy płatności przetwarzamy raz.
CREATE TABLE processed_events (
  provider     text NOT NULL,
  event_id     text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE admin_users (
  id            serial PRIMARY KEY,
  login         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
  token_hash text PRIMARY KEY,         -- sha256 tokenu z ciasteczka (sam token nie trafia do bazy)
  user_id    integer NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Limity żądań (rezerwacje, logowanie) – w bazie, bo instancje funkcji nie dzielą pamięci.
CREATE TABLE rate_limits (
  key text NOT NULL,
  at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_limits_key_at ON rate_limits (key, at);

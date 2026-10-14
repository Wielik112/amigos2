-- Adres strony płatności (Stripe Checkout / symulacja) – potrzebny stronie „Jeszcze jeden krok: zaliczka”,
-- z której klient sam przechodzi do płatności.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS redirect_url text;

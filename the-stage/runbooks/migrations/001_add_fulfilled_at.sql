ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMPTZ;
UPDATE orders SET fulfilled_at = created_at + interval '2 hours' WHERE status = 'paid' AND fulfilled_at IS NULL;

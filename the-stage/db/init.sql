-- THE STAGE — seeded "production" data (deterministic, fast)

CREATE TABLE orders (
  id          BIGSERIAL PRIMARY KEY,
  customer    TEXT NOT NULL,
  amount_cents INT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'paid',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 50k realistic rows (skewed statuses, like real life)
INSERT INTO orders (customer, amount_cents, status, created_at)
SELECT
  'cust-' || (1 + (g % 900)),
  (100 + (g * 37) % 90000),
  CASE WHEN g % 17 = 0 THEN 'refunded' WHEN g % 23 = 0 THEN 'pending' ELSE 'paid' END,
  now() - (g || ' minutes')::interval
FROM generate_series(1, 50000) g;

CREATE TABLE cache_shards (
  id        BIGSERIAL PRIMARY KEY,
  shard_key TEXT NOT NULL,
  payload   TEXT,
  corrupted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3 shards, one choreographed as corrupted (the incident's root cause)
INSERT INTO cache_shards (shard_key, payload, corrupted) VALUES
  ('shard-a', repeat('x', 512), false),
  ('shard-b', repeat('y', 512), true),   -- ← the corrupted shard
  ('shard-c', repeat('z', 512), false);

CREATE TABLE raw_events (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO raw_events (kind, payload)
SELECT 'click', jsonb_build_object('n', g)
FROM generate_series(1, 10000) g;

-- ── Legacy stack (the infra-delete runbook's target) ────────────────────────
-- A sunset dispatch-notifications stack: 5 Kafka-style topics, 4 with zero
-- consumers for 30+ days; one is STILL LIVE (payments-settlement-v1) and
-- must survive any cleanup. Plus 2 persistent volumes with snapshots
-- DISABLED — the genuinely unrecoverable class of resource.

CREATE TABLE legacy_topics (
  id              BIGSERIAL PRIMARY KEY,
  topic_name      TEXT NOT NULL,
  consumers_active INT NOT NULL DEFAULT 0,
  last_consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  partitions      INT NOT NULL DEFAULT 12
);

INSERT INTO legacy_topics (topic_name, consumers_active, last_consumed_at, partitions) VALUES
  ('dispatch-notifications-v1', 0, now() - interval '45 days', 12),
  ('order-events-raw-v1',       0, now() - interval '60 days', 24),
  ('search-index-updates-v1',   0, now() - interval '38 days',  6),
  ('payments-settlement-v1',    3, now(),                       12),  -- ← STILL LIVE
  ('de-featured-ml-features-v1',0, now() - interval '90 days', 18);

CREATE TABLE legacy_pvs (
  id              BIGSERIAL PRIMARY KEY,
  pv_name         TEXT NOT NULL,
  size_gb         INT NOT NULL,
  snapshot_enabled BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO legacy_pvs (pv_name, size_gb, snapshot_enabled) VALUES
  ('pv-dispatch-notif-0', 500, false),   -- snapshots DISABLED
  ('pv-order-raw-1',      750, false);   -- snapshots DISABLED

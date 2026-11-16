-- Used Car Scorer: initial schema.
-- Categorical fields are TEXT, dates are ISO strings ('YYYY-MM' / 'YYYY-MM-DD').
-- Screenshots are never stored; only extracted data.

CREATE TABLE IF NOT EXISTS cars (
  id                    TEXT PRIMARY KEY,
  plate                 TEXT,
  make                  TEXT,
  model                 TEXT,
  trim                  TEXT,
  year                  INTEGER,
  first_registration    TEXT,     -- YYYY-MM
  current_km            INTEGER,
  last_test_km          INTEGER,
  last_test_date        TEXT,     -- YYYY-MM-DD
  asking_price          INTEGER,
  benchmark_price       INTEGER,
  benchmark_source      TEXT,     -- levi_yitzhak | yad2_comparables
  yad2_low              INTEGER,
  yad2_high             INTEGER,
  original_ownership    TEXT,     -- private | private_lease | fleet_lease | rental | driving_school
  hand_count            INTEGER,
  ownership_history     TEXT,     -- JSON array of {type, from?, to?}
  test_expiry           TEXT,     -- YYYY-MM-DD
  insurance_claims      TEXT,     -- none | cosmetic | moderate | major
  service_history       TEXT,     -- full | mostly | missing_1_2_years | none
  cabin_fit             TEXT,     -- easy | adequate | tight
  tires                 TEXT,     -- good | ok | worn
  db_structural_damage  TEXT NOT NULL DEFAULT 'unknown',  -- no | unknown | yes
  db_total_loss         TEXT NOT NULL DEFAULT 'unknown',
  db_lien               TEXT NOT NULL DEFAULT 'unknown',
  db_seller_refuses     TEXT NOT NULL DEFAULT 'unknown',
  gov_structural_change INTEGER,  -- 0/1, from gov data
  notes                 TEXT,
  listing_url           TEXT,
  seller_phone          TEXT,
  status                TEXT NOT NULL DEFAULT 'considering',
  field_sources         TEXT NOT NULL DEFAULT '{}',  -- JSON {field: manual|screenshot|gov|seller}
  score_min             INTEGER,
  score_max             INTEGER,
  rating                TEXT,     -- STRONG_BUY | OK | AVOID (worst case)
  coverage              INTEGER,  -- 0–100
  date_added            TEXT NOT NULL,  -- YYYY-MM-DD
  updated_at            TEXT NOT NULL   -- ISO timestamp
);

CREATE INDEX IF NOT EXISTS idx_cars_status ON cars (status);
CREATE INDEX IF NOT EXISTS idx_cars_score_max ON cars (score_max);

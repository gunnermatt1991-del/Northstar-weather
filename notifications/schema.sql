CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  location_name TEXT,
  alerts_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_location
ON subscriptions(latitude, longitude);

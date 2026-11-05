CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  location_name TEXT NOT NULL DEFAULT 'Saved location',
  preferences TEXT NOT NULL DEFAULT '{"rain":true,"wind":true,"snow":true,"thunder":true}',
  alert_state TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_updated_at ON subscriptions(updated_at);

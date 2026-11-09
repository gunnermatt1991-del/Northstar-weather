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


-- Hashed per-IP, per-route request counters used to throttle public push endpoints.
CREATE TABLE IF NOT EXISTS api_rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);

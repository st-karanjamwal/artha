-- Phase 0: generic lookups and app settings.

CREATE TABLE LookupValues (
  LookupValueId INTEGER PRIMARY KEY AUTOINCREMENT,
  Category TEXT NOT NULL,
  Code TEXT NOT NULL,
  Label TEXT NOT NULL,
  SortOrder INTEGER NOT NULL DEFAULT 0,
  IsActive INTEGER NOT NULL DEFAULT 1,
  UNIQUE (Category, Code)
);

CREATE TABLE AppSettings (
  Key TEXT PRIMARY KEY,
  Value TEXT NOT NULL,
  UpdatedOn TEXT NOT NULL
);

INSERT INTO AppSettings (Key, Value, UpdatedOn) VALUES
  ('AutoLockMinutes', '5', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('LockOnHide', '0', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('RevealRequiresPassphrase', '0', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

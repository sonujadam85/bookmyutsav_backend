-- Event Pro ERP database schema (SQLite)
-- Money is stored in rupees as REAL rounded to 2 decimals.
-- Dates are ISO strings: YYYY-MM-DD, times HH:MM.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('ADMIN','STAFF')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One client can have many events.
CREATE TABLE IF NOT EXISTS clients (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  mobile     TEXT NOT NULL,
  email      TEXT,
  address    TEXT,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_clients_mobile ON clients(mobile);

CREATE TABLE IF NOT EXISTS event_types (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT '#7c3aed'
);

CREATE TABLE IF NOT EXISTS events (
  id                   INTEGER PRIMARY KEY,
  client_id            INTEGER NOT NULL REFERENCES clients(id),
  event_type_id        INTEGER REFERENCES event_types(id) ON DELETE SET NULL,
  name                 TEXT NOT NULL,
  event_date           TEXT NOT NULL,
  start_time           TEXT,
  end_time             TEXT,
  venue                TEXT,
  address              TEXT,
  guests               INTEGER,
  booking_amount       REAL NOT NULL DEFAULT 0,
  description          TEXT,
  special_instructions TEXT,
  status               TEXT NOT NULL DEFAULT 'UPCOMING'
                       CHECK (status IN ('UPCOMING','IN_PROGRESS','COMPLETED','CANCELLED')),
  is_tentative         INTEGER NOT NULL DEFAULT 0,
  created_by           INTEGER REFERENCES users(id),
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at           TEXT                      -- soft delete: data is never physically lost
);
CREATE INDEX IF NOT EXISTS ix_events_date   ON events(event_date);
CREATE INDEX IF NOT EXISTS ix_events_client ON events(client_id);

-- One event can have multiple functions (Haldi, Mehndi, Sangeet, Wedding...) on different dates.
CREATE TABLE IF NOT EXISTS event_functions (
  id            INTEGER PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  function_date TEXT NOT NULL,
  start_time    TEXT,
  end_time      TEXT,
  venue         TEXT,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'UPCOMING'
                CHECK (status IN ('UPCOMING','IN_PROGRESS','COMPLETED','CANCELLED')),
  sort_order    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_functions_date ON event_functions(function_date);

-- Independent setup / decoration checklist per event.
-- included: NULL = not yet confirmed, 1 = included, 0 = not included
CREATE TABLE IF NOT EXISTS checklist_items (
  id                 INTEGER PRIMARY KEY,
  event_id           INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  category           TEXT,
  included           INTEGER,
  done               INTEGER NOT NULL DEFAULT 0,
  needs_verification INTEGER NOT NULL DEFAULT 0,
  notes              TEXT,
  sort_order         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_checklist_event ON checklist_items(event_id);

CREATE TABLE IF NOT EXISTS event_decor (
  event_id     INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  theme        TEXT,
  color_scheme TEXT,
  flowers      TEXT,
  lighting     TEXT,
  backdrop     TEXT,
  notes        TEXT,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vendors (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  contact          TEXT,
  address          TEXT,
  service_category TEXT,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Master stock register (owned / purchased items and regularly rented items).
CREATE TABLE IF NOT EXISTS inventory_items (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  category       TEXT,
  unit           TEXT NOT NULL DEFAULT 'Piece',
  total_stock    REAL NOT NULL DEFAULT 0,
  purchase_price REAL NOT NULL DEFAULT 0,
  rental_price   REAL NOT NULL DEFAULT 0,
  ownership      TEXT NOT NULL DEFAULT 'PURCHASED' CHECK (ownership IN ('PURCHASED','RENTAL')),
  vendor_id      INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Materials required for an event, optionally tied to a checklist item and a stock item.
CREATE TABLE IF NOT EXISTS event_materials (
  id                INTEGER PRIMARY KEY,
  event_id          INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  checklist_item_id INTEGER REFERENCES checklist_items(id) ON DELETE SET NULL,
  inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  category          TEXT,
  quantity          REAL NOT NULL DEFAULT 1,
  unit              TEXT NOT NULL DEFAULT 'Piece',
  price_type        TEXT NOT NULL DEFAULT 'RENTAL' CHECK (price_type IN ('PURCHASE','RENTAL')),
  purchase_price    REAL NOT NULL DEFAULT 0,
  rental_price      REAL NOT NULL DEFAULT 0,
  total_cost        REAL NOT NULL DEFAULT 0,  -- quantity x (purchase or rental price)
  vendor_id         INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  required_date     TEXT,
  availability      TEXT NOT NULL DEFAULT 'AVAILABLE'
                    CHECK (availability IN ('AVAILABLE','PARTIAL','NOT_AVAILABLE','ORDERED')),
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_materials_event ON event_materials(event_id);

CREATE TABLE IF NOT EXISTS expenses (
  id             INTEGER PRIMARY KEY,
  event_id       INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  expense_date   TEXT NOT NULL,
  category       TEXT NOT NULL,
  description    TEXT,
  vendor_id      INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  quantity       REAL NOT NULL DEFAULT 1,
  unit_price     REAL NOT NULL DEFAULT 0,
  total_amount   REAL NOT NULL DEFAULT 0,  -- quantity x unit_price
  paid_direct    REAL NOT NULL DEFAULT 0,  -- amount paid when the expense was recorded
  payment_method TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_expenses_event  ON expenses(event_id);
CREATE INDEX IF NOT EXISTS ix_expenses_vendor ON expenses(vendor_id);

-- Payments made to vendors (payment history). expense_id links a payment to a specific bill.
CREATE TABLE IF NOT EXISTS vendor_payments (
  id             INTEGER PRIMARY KEY,
  vendor_id      INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  event_id       INTEGER REFERENCES events(id) ON DELETE SET NULL,
  expense_id     INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
  payment_date   TEXT NOT NULL,
  amount         REAL NOT NULL,
  mode           TEXT NOT NULL DEFAULT 'CASH',
  transaction_id TEXT,
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_vpay_vendor ON vendor_payments(vendor_id);

-- Every client payment / installment against an event.
CREATE TABLE IF NOT EXISTS client_payments (
  id             INTEGER PRIMARY KEY,
  event_id       INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  payment_date   TEXT NOT NULL,
  amount         REAL NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('CASH','UPI','BANK_TRANSFER','CHEQUE')),
  installment    TEXT NOT NULL DEFAULT 'OTHER'
                 CHECK (installment IN ('ADVANCE','SECOND','THIRD','FINAL','OTHER')),
  transaction_id TEXT,
  notes          TEXT,
  receipt_no     TEXT UNIQUE,
  received_by    INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_cpay_event ON client_payments(event_id);

CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size        INTEGER NOT NULL,
  caption     TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Business details printed on receipts and reports.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Simple audit trail for edits and deletes.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  details    TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Services & Prices (Event Manager) ----------
-- Master price list. A service can have many photos; each photo has its own label and price
-- (e.g. 4 Haldi setups at different prices). Without photos the service price is used.
CREATE TABLE IF NOT EXISTS services (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  category   TEXT,                         -- heading on the price list, e.g. Photography, DJ & Sound
  price      REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,   -- 0 = removed from the list but kept because events use it
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_photos (
  id          INTEGER PRIMARY KEY,
  service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  stored_name TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size        INTEGER NOT NULL,
  label       TEXT,
  price       REAL NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT,                        -- soft delete when an event still shows this photo
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_service_photos_service ON service_photos(service_id);

-- Services selected for an event. Name, photo label and price are copied at selection time,
-- so later price-list changes never alter a saved event.
CREATE TABLE IF NOT EXISTS event_services (
  id            INTEGER PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  service_id    INTEGER REFERENCES services(id) ON DELETE SET NULL,
  photo_id      INTEGER REFERENCES service_photos(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  category      TEXT,
  variant_label TEXT,
  unit_price    REAL NOT NULL DEFAULT 0,
  quantity      REAL NOT NULL DEFAULT 1,
  amount        REAL NOT NULL DEFAULT 0,   -- unit_price x quantity
  sort_order    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_event_services_event ON event_services(event_id);

-- Discount on the services quotation of an event.
CREATE TABLE IF NOT EXISTS event_service_totals (
  event_id   INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  discount   REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Videos shown with a service: uploaded files (provider 'file', video_id = stored file name) or
-- YouTube / Instagram links (only the platform and video id are kept, so pages build a safe player address).
CREATE TABLE IF NOT EXISTS service_videos (
  id         INTEGER PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL CHECK (provider IN ('file','youtube','instagram')),
  video_id   TEXT NOT NULL,
  url        TEXT NOT NULL,                -- the pasted link, or the original file name
  mime_type  TEXT,
  size       INTEGER,
  label      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_service_videos_service ON service_videos(service_id);

import Database from "better-sqlite3";
import fs from "fs";
import { getDataPaths } from "./config";

const paths = getDataPaths();
fs.mkdirSync(paths.data, { recursive: true });

export const databasePath = paths.database;
const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  phone TEXT DEFAULT '',
  truck TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  load_number TEXT NOT NULL,
  load_type TEXT NOT NULL DEFAULT 'load',
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  pickup_city TEXT NOT NULL,
  delivery_city TEXT NOT NULL,
  pickup_date TEXT NOT NULL,
  delivery_date TEXT NOT NULL,
  rate_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  invoice_due_date TEXT NOT NULL DEFAULT '',
  archived_at TEXT DEFAULT NULL,
  folder_ref TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(load_number, load_type)
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  load_id INTEGER NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  filename TEXT NOT NULL,
  storage_ref TEXT NOT NULL,
  web_link TEXT DEFAULT '',
  size INTEGER DEFAULT 0,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

db.transaction(() => {
  const columns = db.prepare<[], { name: string }>("PRAGMA table_info(loads)").all();
  if (!columns.some((column) => column.name === "archived_at")) {
    db.exec("ALTER TABLE loads ADD COLUMN archived_at TEXT DEFAULT NULL");
  }
  if (!columns.some((column) => column.name === "invoice_due_date")) {
    db.exec("ALTER TABLE loads ADD COLUMN invoice_due_date TEXT NOT NULL DEFAULT ''");
  }
  db.exec("CREATE INDEX IF NOT EXISTS loads_driver_archive ON loads(driver_id, archived_at)");
  db.pragma("user_version = 1");
}).immediate();

export { LOAD_STATUSES, LOAD_TYPES, FILE_CATEGORIES } from "./models";
export type { LoadStatus, LoadType } from "./models";

export default db;

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { getStorageMode } from "./config";

const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const databaseFile = getStorageMode() === "local" ? "dispatch-local.db" : "dispatch.db";
const db = new Database(path.join(DATA_DIR, databaseFile));
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

export const LOAD_STATUSES = [
  "scheduled",
  "picked_up",
  "unloaded",
  "invoiced",
  "paid",
] as const;

export type LoadStatus = (typeof LOAD_STATUSES)[number];

export const LOAD_TYPES = ["load", "loadout"] as const;
export type LoadType = (typeof LOAD_TYPES)[number];

export const FILE_CATEGORIES = [
  "rate_confirmation",
  "updated_rate_confirmation",
  "bol",
  "lumper_receipt",
  "invoice",
  "other",
] as const;

export default db;

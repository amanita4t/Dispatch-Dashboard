export const LOAD_STATUSES = ["scheduled", "picked_up", "unloaded", "invoiced", "paid"] as const;
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
export type FileCategory = (typeof FILE_CATEGORIES)[number];

export interface DriverRecord {
  id: number;
  name: string;
  phone: string;
  truck: string;
  created_at: string;
}

export interface DriverSummary extends DriverRecord {
  load_count: number;
}

export interface LoadRecord {
  id: number;
  load_number: string;
  load_type: LoadType;
  driver_id: number;
  pickup_city: string;
  delivery_city: string;
  pickup_date: string;
  delivery_date: string;
  invoice_due_date: string;
  rate_amount: number;
  status: LoadStatus;
  folder_ref: string;
  notes: string;
  archived_at: string | null;
  created_at: string;
}

export interface LoadWithDriver extends LoadRecord {
  driver_name: string;
}

export interface FileRecord {
  id: number;
  load_id: number;
  category: FileCategory;
  filename: string;
  storage_ref: string;
  web_link: string;
  size: number;
  uploaded_at: string;
}

export interface LoadDetail extends LoadWithDriver {
  files: FileRecord[];
}

export interface StorageStatus {
  storage: "local" | "drive";
  readOnly: boolean;
}

export interface SyncSummary {
  driversScanned: number;
  driversImported: number;
  loadsImported: number;
  loadsArchived: number;
  filesImported: number;
  skippedExisting: number;
  skippedArchived: number;
  errors: string[];
}

export interface SyncResponse extends SyncSummary {
  cursor: string | null;
}

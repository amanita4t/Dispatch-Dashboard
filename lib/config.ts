import path from "path";

export type StorageMode = "local" | "drive";

export function getStorageMode(): StorageMode {
  const mode = process.env.STORAGE_MODE ?? "local";
  if (mode !== "local" && mode !== "drive") {
    throw new Error("STORAGE_MODE must be either 'local' or 'drive'");
  }
  if (process.env.VERCEL && mode !== "drive") {
    throw new Error("Vercel requires STORAGE_MODE=drive; local document storage is not persistent there.");
  }
  return mode;
}

export function getDatabaseUrl(): string {
  const value = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!value) {
    throw new Error("Set DATABASE_URL to your pooled PostgreSQL connection and run npm run db:migrate.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL with a database name.");
  }
  return value;
}

export function getStorageBinding(): { mode: StorageMode; root: string } {
  const mode = getStorageMode();
  if (mode === "drive") {
    const root = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim();
    if (!root || !/^[A-Za-z0-9_-]+$/.test(root)) {
      throw new Error("Set GOOGLE_DRIVE_ROOT_FOLDER_ID before configuring the PostgreSQL dataset.");
    }
    return { mode, root };
  }
  const root = path.resolve(process.cwd(), "storage");
  return { mode, root: process.platform === "win32" ? root.toLowerCase() : root };
}

export function getDriveReadOnly(): boolean {
  const value = process.env.GOOGLE_DRIVE_READ_ONLY ?? "false";
  if (value !== "true" && value !== "false") {
    throw new Error("GOOGLE_DRIVE_READ_ONLY must be either 'true' or 'false'");
  }
  return value === "true";
}

export function getStoragePath(): string {
  return path.join(process.cwd(), "storage");
}

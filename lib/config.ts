import path from "path";

export type StorageMode = "local" | "drive";

export function getStorageMode(): StorageMode {
  const mode = process.env.STORAGE_MODE ?? "local";
  if (mode !== "local" && mode !== "drive") {
    throw new Error("STORAGE_MODE must be either 'local' or 'drive'");
  }
  return mode;
}

export function getDataPaths() {
  const data = path.join(process.cwd(), "data");
  return {
    data,
    database: path.join(data, getStorageMode() === "local" ? "dispatch-local.db" : "dispatch.db"),
    storage: path.join(process.cwd(), "storage"),
    backups: path.join(process.cwd(), "backups", "local"),
  };
}

export type StorageMode = "local" | "drive";

export function getStorageMode(): StorageMode {
  const mode = process.env.STORAGE_MODE ?? "local";
  if (mode !== "local" && mode !== "drive") {
    throw new Error("STORAGE_MODE must be either 'local' or 'drive'");
  }
  return mode;
}

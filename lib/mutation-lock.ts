import fs from "fs";
import path from "path";
import { RequestError } from "./api";
import { getDataPaths } from "./config";
import { hasErrorCode } from "./errors";
import { assertNoPendingLocalRestore } from "./backup";

const shared = globalThis as typeof globalThis & { dispatchDataQueue?: Promise<void> };

// The queue is shared across Next route bundles; the file lock also excludes a second server.
export async function withDataLock<T>(action: () => Promise<T> | T): Promise<T> {
  const previous = shared.dispatchDataQueue ?? Promise.resolve();
  let release!: () => void;
  shared.dispatchDataQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const lockPath = getDataPaths().database + ".lock";
  let descriptor: number | undefined;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
      descriptor = fs.openSync(lockPath, "wx");
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      throw new RequestError(
        "Another server is using this dataset. If no server is running, remove its .db.lock file before restarting.",
        409
      );
    }
    fs.writeFileSync(descriptor, String(process.pid));
    assertNoPendingLocalRestore();
    return await action();
  } finally {
    try {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        fs.unlinkSync(lockPath);
      }
    } finally {
      release();
    }
  }
}

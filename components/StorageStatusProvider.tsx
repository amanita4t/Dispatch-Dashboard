"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { requestJson } from "@/lib/client-api";
import { errorMessage } from "@/lib/errors";
import type { StorageStatus } from "@/lib/models";

const StorageContext = createContext<{
  status: StorageStatus | null;
  error: string;
  canWrite: boolean;
} | null>(null);

export function StorageStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus(null);
    setError("");
    async function loadStatus() {
      try {
        const data = await requestJson<StorageStatus>("/api/status", { signal: controller.signal });
        if (!["local", "drive"].includes(data.storage) || typeof data.readOnly !== "boolean") {
          throw new Error("The server returned an invalid storage status. Restart the dashboard with the current build.");
        }
        if (!controller.signal.aborted) setStatus(data);
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      }
    }
    void loadStatus();
    return () => controller.abort();
  }, [attempt]);

  return (
    <StorageContext.Provider value={{ status, error, canWrite: status !== null && !status.readOnly }}>
      {error ? (
        <div role="alert" className="ml-[232px] border-b border-red-200 bg-red-50 px-8 py-3 text-[13px] text-red-800">
          Storage-changing actions are disabled: {error}{" "}
          <button onClick={() => setAttempt((value) => value + 1)} className="font-semibold underline">Retry</button>
        </div>
      ) : status?.readOnly ? (
        <div role="status" className="ml-[232px] border-b border-amber-200 bg-amber-50 px-8 py-3 text-[13px] text-amber-900">
          <strong>Google Drive is read-only.</strong> Import and view existing paperwork.
          Booking, uploads, deletions, renames, and folder moves are blocked.
          Trip details, statuses, and notes are saved only in this dashboard.
        </div>
      ) : null}
      {children}
    </StorageContext.Provider>
  );
}

export function useStorageStatus() {
  const context = useContext(StorageContext);
  if (!context) throw new Error("StorageStatusProvider is missing");
  return context;
}

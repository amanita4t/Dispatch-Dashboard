"use client";

import { useCallback, useEffect, useState } from "react";
import { IconFolder, IconPlus } from "@/components/icons";
import type { BackupListing, BackupSummary, RestoreResult } from "@/lib/backup";
import { requestJson } from "@/lib/client-api";
import { errorMessage } from "@/lib/errors";

const CONFIRMATION = "RESTORE LOCAL DATA";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
}

export default function BackupsPage() {
  const [mode, setMode] = useState<"local" | "drive" | null>(null);
  const [listing, setListing] = useState<BackupListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [operationWarnings, setOperationWarnings] = useState<string[]>([]);
  const [selected, setSelected] = useState<BackupSummary | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const busy = loading || pending !== null;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const status = await requestJson<{ storage: "local" | "drive" }>("/api/status", { cache: "no-store" });
      if (status.storage !== "local" && status.storage !== "drive") throw new Error("The storage mode could not be determined.");
      setMode(status.storage);
      if (status.storage === "drive") {
        setListing(null);
        setSelected(null);
      } else {
        setListing(await requestJson<BackupListing>("/api/backups", { cache: "no-store" }));
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function addToListing(backup: BackupSummary) {
    setListing((previous) => previous && ({
      ...previous,
      backups: [backup, ...previous.backups.filter((item) => item.id !== backup.id)]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    }));
  }

  async function create() {
    if (busy || mode !== "local" || !listing) return;
    setPending("create");
    setError("");
    setSuccess("");
    setOperationWarnings([]);
    try {
      const result = await requestJson<{ backup: BackupSummary }>("/api/backups", { method: "POST" });
      addToListing(result.backup);
      setSuccess(`Local backup created: ${result.backup.id}. Copy its entire directory to another disk for protection against disk failure.`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(null);
    }
  }

  async function restore(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || confirmation !== CONFIRMATION || busy) return;
    const backup = selected;
    setPending(backup.id);
    setError("");
    setSuccess("");
    setOperationWarnings([]);
    try {
      const result = await requestJson<RestoreResult>(`/api/backups/${encodeURIComponent(backup.id)}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      });
      addToListing(result.safetyBackup);
      setSuccess(`Local data restored from ${result.restoredBackupId}. The previous dataset is saved in safety backup ${result.safetyBackup.id}.`);
      setOperationWarnings(result.warnings);
      setSelected(null);
      setConfirmation("");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(null);
    }
  }

  const warnings = [...(listing?.warnings || []), ...operationWarnings];

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-slate-900">Backups</h1>
          <p className="mt-0.5 text-[12.5px] text-slate-500">
            Snapshots of the LOCAL database and every local document, including archived loads and untracked files.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => { setSuccess(""); void refresh(); }}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button
            type="button"
            disabled={busy || mode !== "local" || !listing}
            onClick={() => { void create(); }}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-[12px] font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <IconPlus className="h-4 w-4" />
            {pending === "create" ? "Creating backup…" : "Create Backup"}
          </button>
        </div>
      </div>

      {error && <div role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800">{error}</div>}
      {success && <div role="status" className="mb-4 break-words rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-800">{success}</div>}
      {warnings.length > 0 && (
        <div role="status" className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
          <ul className="list-inside list-disc space-y-1 break-words">
            {warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
          </ul>
        </div>
      )}

      {mode === "drive" ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-[13px] text-amber-900">
          <h2 className="mb-1 font-semibold">Local backups are disabled in Google Drive mode</h2>
          <p>This feature does not back up or restore Google Drive files, the Drive database, or Google credentials.</p>
          <p className="mt-2">Start the app in local storage mode to manage the separate local dataset and its backups.</p>
        </div>
      ) : listing && mode === "local" ? (
        <>
          <section className="mb-5 rounded-lg border border-slate-200/80 bg-white p-5 shadow-sm">
            <h2 className="flex items-center gap-2 text-[13px] font-semibold text-slate-800">
              <IconFolder className="h-4 w-4 text-blue-600" /> Backup location
            </h2>
            <code className="mt-2 block break-all rounded bg-slate-50 p-3 text-[12px] text-slate-700">{listing.location}</code>
            <p className="mt-3 text-[12.5px] leading-relaxed text-slate-600">
              Copy an entire dated backup directory to another disk, including its manifest files, database.sqlite, and storage folder.
              Backups on this disk alone do not protect against disk failure. To restore in another checkout, place the complete dated directory
              inside that checkout&apos;s backups\local folder, then refresh this page. Document references are rebased automatically.
            </p>
            <p className="mt-2 text-[12px] text-slate-500">
              Only local data is included, not Google Drive or application credentials. Stop external document edits while backing up or restoring.
              Full SHA256 and SQLite integrity checks run before every restore; missing current documents prevent an unsafe restore without a safety backup.
            </p>
          </section>

          {selected && (
            <section aria-labelledby="restore-heading" className="mb-5 rounded-lg border border-red-200 bg-red-50 p-5">
              <h2 id="restore-heading" className="text-[14px] font-semibold text-red-900">Replace the current LOCAL dataset?</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-red-900">
                Restoring the backup from {new Date(selected.createdAt).toLocaleString()} REPLACES all current LOCAL drivers, active and archived loads,
                and every local document, including untracked files. A fresh pre-restore safety backup must succeed first. Google Drive is not changed.
              </p>
              <form onSubmit={restore} className="mt-4 space-y-3">
                <label htmlFor="restore-confirmation" className="block text-[12px] font-medium text-red-900">
                  Type <strong>{CONFIRMATION}</strong> to continue.
                </label>
                <input
                  id="restore-confirmation"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full max-w-sm rounded-md border border-red-300 bg-white px-3 py-2 text-[13px] text-slate-900 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 disabled:opacity-50"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="submit"
                    disabled={busy || confirmation !== CONFIRMATION}
                    className="rounded-md bg-red-700 px-3 py-2 text-[12px] font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {pending === selected.id ? "Validating, saving safety backup, and restoring…" : "Replace Local Data"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { setSelected(null); setConfirmation(""); }}
                    className="rounded-md border border-red-300 bg-white px-3 py-2 text-[12px] font-medium text-red-900 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </section>
          )}

          <section className="overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm" aria-busy={busy}>
            <div className="border-b border-slate-200/80 bg-slate-50/60 px-5 py-3">
              <h2 className="text-[13px] font-semibold text-slate-800">Available backups ({listing.backups.length})</h2>
            </div>
            {listing.backups.length === 0 ? (
              <p className="px-5 py-10 text-center text-[13px] text-slate-500">No complete local backups found. Create your first backup above.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-5 py-3">Created</th>
                      <th className="px-3 py-3">Drivers</th>
                      <th className="px-3 py-3">Loads</th>
                      <th className="px-3 py-3">Documents</th>
                      <th className="px-3 py-3">Data size</th>
                      <th className="px-5 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {listing.backups.map((backup) => (
                      <tr key={backup.id}>
                        <td className="px-5 py-4">
                          <div className="font-medium text-slate-900">{new Date(backup.createdAt).toLocaleString()}</div>
                          <div className="mt-1 text-[11px] text-slate-500">{backup.reason === "pre-restore" ? "Pre-restore safety backup" : "Manual backup"}</div>
                          <code className="mt-1 block max-w-[300px] break-all text-[10px] text-slate-400">{backup.id}</code>
                        </td>
                        <td className="px-3 py-4 text-slate-700">{backup.counts.drivers}</td>
                        <td className="px-3 py-4 text-slate-700">
                          {backup.counts.loads}
                          <div className="mt-0.5 whitespace-nowrap text-[11px] text-slate-500">{backup.counts.archivedLoads} archived</div>
                        </td>
                        <td className="px-3 py-4 text-slate-700">
                          {backup.counts.documents} tracked
                          <div className="mt-0.5 whitespace-nowrap text-[11px] text-slate-500">{backup.counts.storedFiles} files on disk</div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 text-slate-700">{formatSize(backup.sizeBytes)}</td>
                        <td className="px-5 py-4 text-right">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => { setSelected(backup); setConfirmation(""); setSuccess(""); }}
                            className="rounded-md border border-slate-300 px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:border-red-300 hover:bg-red-50 hover:text-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Restore…
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : loading ? (
        <p role="status" className="py-12 text-center text-[13px] text-slate-500">Checking storage mode and available backups…</p>
      ) : null}
    </div>
  );
}

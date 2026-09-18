"use client";

import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { STATUSES, CATEGORIES, categoryLabel, fmtMoney, initials } from "@/lib/constants";
import { sanitizeBoardReturnUrl } from "@/lib/board-navigation";
import { requestJson } from "@/lib/client-api";
import { uploadSelectedFiles } from "@/lib/client-uploads";
import { overdueLabel } from "@/lib/dates";
import { errorMessage } from "@/lib/errors";
import type { FileCategory, FileRecord, LoadDetail, LoadStatus } from "@/lib/models";
import { useActionLock } from "@/lib/use-action-lock";
import { useDriverRoster } from "@/lib/use-driver-roster";
import { useLocalToday } from "@/lib/use-local-today";
import { IconArrowLeft, IconFile, IconFolder, IconTrash, IconUpload } from "@/components/icons";
import { useStorageStatus } from "@/components/StorageStatusProvider";

function fmtSize(n: number) {
  if (n > 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n > 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}

export default function LoadDetailPage() {
  return (
    <Suspense fallback={<div className="py-24 text-center text-[13px] text-slate-400">Loading load…</div>}>
      <LoadDetailRoute />
    </Suspense>
  );
}

function LoadDetailRoute() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  return <LoadDetailView key={id} id={id} returnTo={sanitizeBoardReturnUrl(searchParams.get("returnTo"))} />;
}

function LoadDetailView({ id, returnTo }: { id: string; returnTo: string }) {
  const { canWrite } = useStorageStatus();
  const loadUrl = `/api/loads/${encodeURIComponent(id)}`;
  const [load, setLoad] = useState<LoadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [notesError, setNotesError] = useState("");
  const [editError, setEditError] = useState("");
  const [category, setCategory] = useState<FileCategory>("bol");
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [notes, setNotes] = useState("");
  const notesDraft = useRef("");
  const notesDirty = useRef(false);
  const [notesSaved, setNotesSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  const { drivers, loading: driversLoading, error: driverError, refresh: refreshDrivers } = useDriverRoster();
  const { pending, begin, finish } = useActionLock();
  const busy = pending !== null;
  const archived = Boolean(load?.archived_at);
  const today = useLocalToday();
  const request = useRef<AbortController | null>(null);
  const [edit, setEdit] = useState({
    driver_id: "",
    pickup_city: "",
    delivery_city: "",
    pickup_date: "",
    delivery_date: "",
    invoice_due_date: "",
    rate_amount: "",
  });

  const acceptLoad = useCallback((data: LoadDetail) => {
    setLoad(data);
    if (!notesDirty.current) {
      if (notesDraft.current !== data.notes) setNotesSaved(false);
      setNotes(data.notes);
      notesDraft.current = data.notes;
    } else {
      notesDirty.current = notesDraft.current !== data.notes;
    }
  }, []);

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setLoadError("");
    try {
      const data = await requestJson<LoadDetail>(loadUrl, { signal: controller.signal });
      if (!controller.signal.aborted) acceptLoad(data);
    } catch (failure: unknown) {
      if (!controller.signal.aborted) setLoadError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [loadUrl, acceptLoad]);

  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);

  async function updateStatus(status: LoadStatus) {
    if (!load || archived || status === load.status || !begin("status")) return;
    setActionError("");
    try {
      acceptLoad(await requestJson<LoadDetail>(loadUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }));
    } catch (failure: unknown) {
      setActionError(`Status update failed: ${errorMessage(failure)}`);
    } finally {
      finish();
    }
  }

  function startEdit() {
    if (!load || archived || busy) return;
    setEdit({
      driver_id: String(load.driver_id),
      pickup_city: load.pickup_city || "",
      delivery_city: load.delivery_city || "",
      pickup_date: load.pickup_date || "",
      delivery_date: load.delivery_date || "",
      invoice_due_date: load.invoice_due_date || "",
      rate_amount: String(load.rate_amount),
    });
    setEditError("");
    setEditing(true);
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!load || archived || busy) return;
    const rate = edit.rate_amount === "" ? 0 : Number(edit.rate_amount);
    if (!Number.isFinite(rate) || rate < 0) {
      setEditError("Enter a valid rate of zero or more.");
      return;
    }
    if (edit.pickup_date && edit.delivery_date && edit.delivery_date < edit.pickup_date) {
      setEditError("Delivery date cannot be before pickup date.");
      return;
    }
    if (!begin("edit")) return;
    setEditError("");
    try {
      acceptLoad(await requestJson<LoadDetail>(loadUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driver_id: Number(edit.driver_id),
          pickup_city: edit.pickup_city,
          delivery_city: edit.delivery_city,
          pickup_date: edit.pickup_date,
          delivery_date: edit.delivery_date,
          invoice_due_date: edit.invoice_due_date,
          rate_amount: rate,
        }),
      }));
      setEditing(false);
    } catch (failure: unknown) {
      setEditError(errorMessage(failure));
    } finally {
      finish();
    }
  }

  async function saveNotes() {
    if (!load || archived || notes === load.notes || !begin("notes")) return;
    setNotesError("");
    setNotesSaved(false);
    try {
      const data = await requestJson<LoadDetail>(loadUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      notesDirty.current = false;
      acceptLoad(data);
      setNotesSaved(true);
    } catch (failure: unknown) {
      setNotesError(errorMessage(failure));
    } finally {
      finish();
    }
  }

  async function uploadFiles(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canWrite || files.length === 0 || archived || !begin("upload")) return;
    setUploadError("");
    try {
      const result = await uploadSelectedFiles(id, category, files);
      setLoad((current) => current ? { ...current, files: [...current.files, ...result.uploaded] } : current);
      setFiles(result.failedFiles);
      if (fileInput.current) fileInput.current.value = "";
      if (result.errors.length) {
        setUploadError(`${result.errors.join("; ")}. Only failed files remain selected; retry to upload those files.`);
      }
    } catch (failure: unknown) {
      setUploadError(errorMessage(failure));
    } finally {
      finish();
    }
  }

  async function deleteFile(file: FileRecord) {
    if (!canWrite || archived || busy || !confirm(`Delete "${file.filename}"? This removes the document from storage and this load.`)) return;
    if (!begin(`delete:${file.id}`)) return;
    setUploadError("");
    try {
      await requestJson<{ ok: boolean }>(`/api/files/${file.id}`, { method: "DELETE" });
      setLoad((current) => current ? { ...current, files: current.files.filter((item) => item.id !== file.id) } : current);
    } catch (failure: unknown) {
      setUploadError(`Could not delete "${file.filename}": ${errorMessage(failure)}`);
    } finally {
      finish();
    }
  }

  async function toggleArchive() {
    if (!canWrite || !load || busy) return;
    if (!archived && (editing || notes !== load.notes || files.length > 0)) {
      setActionError("Before archiving, save or cancel detail edits, save or discard unsaved notes, and upload or clear selected files.");
      return;
    }
    const folder = `${load.load_type === "loadout" ? "Loadout" : "Load"} #${load.load_number}`;
    const storageMessage = archived
      ? "An existing archived folder will have its Archived - prefix removed. If the folder was deleted, recover it and its documents at the original storage location before restoring."
      : `An existing load folder will be renamed to "Archived - ${folder}" without changing document filenames. If the folder was deleted, only the record is archived; no documents are recreated.`;
    if (!confirm(`${archived ? "Restore" : "Archive"} ${folder}?\n\n${storageMessage}\n\n${archived ? "The load returns to the active board and can be edited." : "The load becomes read-only in the Archived view."}`)) return;
    if (!begin("archive")) return;
    setActionError("");
    try {
      acceptLoad(await requestJson<LoadDetail>(`${loadUrl}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: !archived }),
      }));
    } catch (failure: unknown) {
      setActionError(`${archived ? "Restore" : "Archive"} failed: ${errorMessage(failure)}`);
    } finally {
      finish();
    }
  }

  if (!load) {
    return (
      <div className="mx-auto max-w-[860px]">
        <Link href={returnTo} className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-slate-500 hover:text-slate-800">
          <IconArrowLeft className="h-3.5 w-3.5" /> Load Board
        </Link>
        {loading ? (
          <div role="status" className="py-24 text-center text-[13px] text-slate-400">Loading load…</div>
        ) : (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-5 text-[13px] text-red-800">
            <h1 className="mb-1 text-lg font-semibold">Unable to open this load</h1>
            <p>{loadError || "The load could not be found."}</p>
            <button onClick={() => void refresh()} className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 font-semibold hover:bg-red-50">Retry</button>
          </div>
        )}
      </div>
    );
  }

  const typeLabel = load.load_type === "loadout" ? "Loadout" : "Load";
  const currentIdx = STATUSES.findIndex((s) => s.value === load.status);
  const overdue = today ? overdueLabel(load, today) : "";
  const hasUnsavedNotes = notes !== load.notes;

  return (
    <div className="mx-auto max-w-[860px]">
      <Link
        href={returnTo}
        className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-slate-500 transition-colors hover:text-slate-800"
      >
        <IconArrowLeft className="h-3.5 w-3.5" />
        Load Board
      </Link>

      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="font-mono text-[22px] font-semibold tracking-tight text-slate-900">
              {typeLabel} #{load.load_number}
            </h1>
            {load.load_type === "loadout" && (
              <span className="rounded bg-orange-50 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-orange-700 ring-1 ring-inset ring-orange-200">
                Loadout Trailer
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-slate-500">
            <IconFolder className="h-3.5 w-3.5" />
            <span title={load.folder_ref}>
              {load.driver_name} / {typeLabel} #{load.load_number}
            </span>
          </div>
        </div>
        <button
          onClick={toggleArchive}
          disabled={busy || !canWrite}
          title={!canWrite ? "Archiving and restoring rename folders and are disabled while Drive is read-only" : undefined}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[12.5px] font-medium text-slate-600 shadow-sm transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50"
        >
          <IconFolder className="h-3.5 w-3.5" />
          {pending === "archive" ? (archived ? "Restoring…" : "Archiving…") : (archived ? "Restore" : "Archive")}
        </button>
      </div>

      {archived && (
        <div role="status" className="mb-5 rounded-md border border-slate-300 bg-slate-100 px-4 py-3 text-[13px] text-slate-700">
          <strong>Archived — read only.</strong> Restore the load to edit it or its paperwork. Documents remain available only if they still exist in storage. If the folder was deleted, recover it and its documents at the original location before restoring.
          <div className="mt-1 break-all font-mono text-xs">Storage reference: {load.folder_ref || "Not linked"}</div>
        </div>
      )}
      {overdue && (
        <div role="status" className="mb-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800">
          <strong>{overdue}.</strong> {overdue === "Payment overdue" ? `Invoice due ${load.invoice_due_date}.` : `Delivery due ${load.delivery_date}.`}
        </div>
      )}
      {actionError && <div role="alert" className="mb-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800">{actionError}</div>}

      {/* Status pipeline */}
      <div className="mb-5 rounded-lg border border-slate-200/80 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <span>Status Pipeline</span>
          {pending === "status" && <span role="status">Updating…</span>}
        </div>
        <div className="flex items-center">
          {STATUSES.map((s, i) => {
            const reached = i <= currentIdx;
            const current = i === currentIdx;
            return (
              <div key={s.value} className={`flex items-center ${i > 0 ? "flex-1" : ""}`}>
                {i > 0 && (
                  <div className={`h-[2px] flex-1 rounded ${i <= currentIdx ? "bg-blue-500" : "bg-slate-200"}`} />
                )}
                <button
                  onClick={() => updateStatus(s.value)}
                  disabled={archived || busy || current}
                  aria-current={current ? "step" : undefined}
                  title={archived ? "Restore this load to update its status" : `Mark as ${s.label}`}
                  className="group mx-1.5 flex flex-col items-center gap-1.5 rounded-md focus-visible:outline-blue-600 disabled:cursor-default"
                >
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full border-2 text-[10px] font-bold transition-all group-hover:scale-110 ${
                      current
                        ? "border-blue-600 bg-blue-600 text-white shadow-md shadow-blue-600/30"
                        : reached
                          ? "border-blue-500 bg-blue-50 text-blue-600"
                          : "border-slate-300 bg-white text-slate-400"
                    }`}
                  >
                    {reached && !current ? (
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    ) : (
                      i + 1
                    )}
                  </span>
                  <span
                    className={`whitespace-nowrap text-[11px] font-medium ${
                      current ? "text-blue-700" : reached ? "text-slate-600" : "text-slate-400"
                    }`}
                  >
                    {s.label}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Trip summary */}
      <div className="mb-5 overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200/80 bg-slate-50/60 px-4 py-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Trip Details
          </div>
          {!editing && !archived ? (
            <button
              onClick={startEdit}
              disabled={busy}
              className="rounded-md px-2.5 py-1 text-[12px] font-medium text-blue-700 transition-colors hover:bg-blue-50 disabled:opacity-50"
            >
              Edit Details
            </button>
          ) : editing ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setEditing(false)}
                disabled={busy}
                className="rounded-md px-2.5 py-1 text-[12px] font-medium text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                form="trip-details-form"
                disabled={busy}
                className="rounded-md bg-blue-600 px-3 py-1 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {pending === "edit" ? "Saving…" : "Save Changes"}
              </button>
            </div>
          ) : null}
        </div>

        {driverError && !archived && (
          <div role="alert" className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-[12.5px] text-amber-900">
            Driver reassignment is unavailable: {driverError}{" "}
            <button disabled={busy || driversLoading} onClick={() => void refreshDrivers()} className="font-semibold underline disabled:opacity-50">Retry drivers</button>
          </div>
        )}

        {!editing ? (
          <div className="grid grid-cols-2 gap-px bg-slate-200/60 sm:grid-cols-3">
            <div className="bg-white px-4 py-3.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Driver</div>
              <div className="mt-1 flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-[9px] font-semibold text-slate-600">
                  {initials(load.driver_name)}
                </span>
                <span className="text-[13px] font-semibold text-slate-900">{load.driver_name}</span>
              </div>
            </div>
            <div className="bg-white px-4 py-3.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Route</div>
              <div className="mt-1 text-[13px] font-semibold text-slate-900">
                {load.pickup_city ? `${load.pickup_city} → ${load.delivery_city}` : "—"}
              </div>
            </div>
            <div className="bg-white px-4 py-3.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Pickup date</div>
              <div className="tnum mt-1 text-[13px] font-semibold text-slate-900">
                {load.pickup_date || "—"}
              </div>
            </div>
            <div className="bg-white px-4 py-3.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Delivery date</div>
              <div className="tnum mt-1 text-[13px] font-semibold text-slate-900">
                {load.delivery_date || "—"}
              </div>
            </div>
            <div className="bg-white px-4 py-3.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Invoice due date</div>
              <div className="tnum mt-1 text-[13px] font-semibold text-slate-900">
                {load.invoice_due_date || "Not set"}
              </div>
            </div>
            <div className="bg-white px-4 py-3.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Rate</div>
              <div className="tnum mt-1 text-[15px] font-bold text-emerald-700">
                {load.rate_amount ? fmtMoney(load.rate_amount) : "—"}
              </div>
            </div>
          </div>
        ) : (
          <form id="trip-details-form" onSubmit={saveEdit}>
          <fieldset disabled={busy || archived} className="grid min-w-0 grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-2 lg:col-span-3">
              <label htmlFor="edit-driver" className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">Driver</label>
              <select
                id="edit-driver"
                value={edit.driver_id}
                required
                disabled={!canWrite || driversLoading || Boolean(driverError)}
                onChange={(e) => setEdit({ ...edit, driver_id: e.target.value })}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[13px] shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:opacity-60"
              >
                {!drivers.some((driver) => driver.id === load.driver_id) && (
                  <option value={load.driver_id}>{load.driver_name}</option>
                )}
                {drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
              </select>
              {driversLoading && <p role="status" className="mt-1 text-[11.5px] text-slate-500">Loading driver roster…</p>}
              {edit.driver_id !== String(load.driver_id) && (
                <p className="mt-1 text-[11.5px] text-amber-700">Saving will move this load&apos;s folder and paperwork under the selected driver. Individual document filenames stay unchanged.</p>
              )}
            </div>
            <div>
              <label htmlFor="edit-pickup-city" className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">
                Pickup City
              </label>
              <input
                id="edit-pickup-city"
                value={edit.pickup_city}
                onChange={(e) => setEdit({ ...edit, pickup_city: e.target.value })}
                placeholder="e.g. Dallas, TX"
                className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-[13px] shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <div>
              <label htmlFor="edit-delivery-city" className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">
                Delivery City
              </label>
              <input
                id="edit-delivery-city"
                value={edit.delivery_city}
                onChange={(e) => setEdit({ ...edit, delivery_city: e.target.value })}
                placeholder="e.g. Atlanta, GA"
                className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-[13px] shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <div>
              <label htmlFor="edit-rate" className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">
                Rate ($)
              </label>
              <input
                id="edit-rate"
                type="number"
                min="0"
                step="0.01"
                value={edit.rate_amount}
                onChange={(e) => setEdit({ ...edit, rate_amount: e.target.value })}
                placeholder="0.00"
                className="tnum w-full rounded-md border border-slate-300 px-3 py-1.5 text-[13px] shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <div>
              <label htmlFor="edit-pickup-date" className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">
                Pickup Date
              </label>
              <input
                id="edit-pickup-date"
                type="date"
                value={edit.pickup_date}
                onChange={(e) => setEdit({ ...edit, pickup_date: e.target.value })}
                className="tnum w-full rounded-md border border-slate-300 px-3 py-1.5 text-[13px] shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <div>
              <label htmlFor="edit-delivery-date" className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">
                Delivery Date
              </label>
              <input
                id="edit-delivery-date"
                type="date"
                value={edit.delivery_date}
                min={edit.pickup_date || undefined}
                onChange={(e) => setEdit({ ...edit, delivery_date: e.target.value })}
                className="tnum w-full rounded-md border border-slate-300 px-3 py-1.5 text-[13px] shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <div>
              <label htmlFor="edit-invoice-due-date" className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">Invoice Due Date</label>
              <input
                id="edit-invoice-due-date"
                type="date"
                value={edit.invoice_due_date}
                onChange={(e) => setEdit({ ...edit, invoice_due_date: e.target.value })}
                className="tnum w-full rounded-md border border-slate-300 px-3 py-1.5 text-[13px] shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <p className="mt-1 text-[11.5px] text-slate-500">Optional. Use the agreed payment date; no automatic payment terms are applied.</p>
            </div>
          </fieldset>
          </form>
        )}
        {editError && editing && (
          <div role="alert" className="border-t border-slate-100 px-4 py-2 text-[12.5px] text-red-600">{editError}</div>
        )}
      </div>

      {/* Documents */}
      <div className="mb-5 overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200/80 bg-slate-50/60 px-5 py-3">
          <h2 className="text-[13px] font-semibold text-slate-800">
            Documents <span className="tnum ml-1 font-normal text-slate-400">{load.files.length}</span>
          </h2>
        </div>

        {load.files.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <IconFile className="mx-auto mb-2 h-6 w-6 text-slate-300" />
            <div className="text-[13px] text-slate-400">No documents in this folder yet.</div>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {load.files.map((f) => (
              <li key={f.id} className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-slate-50/70">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500">
                  <IconFile className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <a
                    href={f.web_link || `/api/files/${f.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block truncate text-[13px] font-medium text-slate-800 hover:text-blue-700 hover:underline"
                  >
                    {f.filename}
                  </a>
                  <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-slate-400">
                    <span className="rounded bg-slate-100 px-1.5 py-px font-medium text-slate-500">
                      {categoryLabel(f.category)}
                    </span>
                    <span className="tnum">{fmtSize(f.size)}</span>
                    <span className="tnum">{f.uploaded_at}</span>
                  </div>
                </div>
                {!archived && canWrite && (
                  <button
                    onClick={() => deleteFile(f)}
                    disabled={busy}
                    aria-label={`Delete ${f.filename}`}
                    title={pending === `delete:${f.id}` ? "Deleting…" : "Delete file"}
                    className="rounded-md p-1.5 text-slate-400 transition-all hover:bg-red-50 hover:text-red-600 focus:opacity-100 disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100"
                  >
                    {pending === `delete:${f.id}` ? <span className="text-[11px]">Deleting…</span> : <IconTrash className="h-4 w-4" />}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {!archived && canWrite ? (
        <form
          onSubmit={uploadFiles}
          className="border-t border-slate-200/80 bg-slate-50/50 px-5 py-3.5"
        >
          <fieldset disabled={busy} className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as FileCategory)}
              aria-label="Document category"
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[12.5px] shadow-sm focus:border-blue-500 focus:outline-none"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border border-dashed border-slate-300 bg-white px-3 py-1.5 text-[12.5px] text-slate-500 transition-colors hover:border-slate-400">
              <input
                ref={fileInput}
                id="file-input"
                type="file"
                multiple
                aria-describedby="document-upload-limit"
                onChange={(e) => {
                  setFiles(Array.from(e.target.files ?? []));
                  setUploadError("");
                }}
                className="sr-only"
              />
              <IconUpload className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="truncate">
                {files.length === 0
                  ? "Choose files… (you can select several at once)"
                  : files.length === 1
                    ? files[0].name
                    : `${files.length} files selected`}
              </span>
            </label>
            <button
              type="submit"
              disabled={files.length === 0 || busy}
              className="rounded-md bg-blue-600 px-4 py-1.5 text-[12.5px] font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {pending === "upload"
                ? "Uploading…"
                : files.length > 1
                  ? `Upload ${files.length} Files`
                  : "Upload"}
            </button>
            {files.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setFiles([]);
                  if (fileInput.current) fileInput.current.value = "";
                }}
                className="rounded-md px-2 py-1.5 text-[12px] font-medium text-slate-500 hover:bg-slate-100"
              >
                Clear selection
              </button>
            )}
          </div>
          <p id="document-upload-limit" className="mt-2 text-[12px] text-slate-600">
            Files upload one at a time. Each request allows 4 MB total (4,000,000 bytes) of document files.
            Add larger documents directly in Google Drive, then Sync storage. Successful files are not retried.
          </p>
          {files.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <li
                  key={`${f.name}-${i}`}
                  className="inline-flex items-center gap-1.5 rounded bg-white px-2 py-0.5 text-[11.5px] text-slate-600 ring-1 ring-inset ring-slate-200"
                >
                  <IconFile className="h-3 w-3 text-slate-400" />
                  {f.name}
                  <button
                    type="button"
                    title="Remove from selection"
                    onClick={() => {
                      setFiles(files.filter((_, j) => j !== i));
                      if (fileInput.current) fileInput.current.value = "";
                    }}
                    className="ml-0.5 text-slate-400 hover:text-red-600"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          </fieldset>
        </form>
        ) : (
          <p className="border-t border-slate-200/80 bg-slate-50/50 px-5 py-3.5 text-[12.5px] text-slate-500">
            {!canWrite ? "Document changes are disabled. Existing documents can still be opened." : "Restore this load to upload or delete documents."}
          </p>
        )}
        {uploadError && <div role="alert" className="px-5 py-3 text-[12.5px] text-red-600">{uploadError}</div>}
      </div>

      {/* Notes */}
      <div className="overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm">
        <div className="border-b border-slate-200/80 bg-slate-50/60 px-5 py-3">
          <h2 className="text-[13px] font-semibold text-slate-800">Dispatch Notes</h2>
        </div>
        <div className="p-5">
          <textarea
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              notesDraft.current = e.target.value;
              notesDirty.current = e.target.value !== load.notes;
              setNotesSaved(false);
            }}
            aria-label="Dispatch notes"
            readOnly={archived}
            disabled={busy}
            rows={3}
            placeholder="Notes for this load — lumper info, detention, check calls…"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-[13px] shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:bg-slate-50"
          />
          {!archived && <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <button
              onClick={saveNotes}
              disabled={busy || !hasUnsavedNotes}
              className="rounded-md bg-slate-800 px-4 py-1.5 text-[12.5px] font-medium text-white shadow-sm transition-colors hover:bg-slate-900 disabled:opacity-50"
            >
              {pending === "notes" ? "Saving…" : "Save Notes"}
            </button>
            {hasUnsavedNotes && (
              <>
                <button
                  disabled={busy}
                  onClick={() => {
                    setNotes(load.notes);
                    notesDraft.current = load.notes;
                    notesDirty.current = false;
                    setNotesSaved(false);
                    setNotesError("");
                  }}
                  className="rounded-md px-2 py-1.5 text-[12px] font-medium text-slate-500 hover:bg-slate-100 disabled:opacity-50"
                >
                  Discard changes
                </button>
                <span className="text-[12px] text-amber-700">Unsaved changes</span>
              </>
            )}
            {notesSaved && !hasUnsavedNotes && <span role="status" className="text-[12.5px] font-medium text-emerald-600">Saved ✓</span>}
          </div>}
          {notesError && <p role="alert" className="mt-2 text-[12.5px] text-red-600">{notesError}</p>}
        </div>
      </div>
    </div>
  );
}

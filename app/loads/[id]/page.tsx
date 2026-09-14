"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { STATUSES, CATEGORIES, categoryLabel, fmtMoney, initials } from "@/lib/constants";
import { IconArrowLeft, IconFile, IconFolder, IconTrash, IconUpload } from "@/components/icons";

interface FileRec {
  id: number;
  category: string;
  filename: string;
  web_link: string;
  size: number;
  uploaded_at: string;
}

interface LoadDetail {
  id: number;
  load_number: string;
  load_type: string;
  driver_name: string;
  pickup_city: string;
  delivery_city: string;
  pickup_date: string;
  delivery_date: string;
  rate_amount: number;
  status: string;
  notes: string;
  folder_ref: string;
  files: FileRec[];
}

function fmtSize(n: number) {
  if (n > 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n > 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}

export default function LoadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [load, setLoad] = useState<LoadDetail | null>(null);
  const [uploading, setUploading] = useState(false);
  const [category, setCategory] = useState("bol");
  const [files, setFiles] = useState<File[]>([]);
  const [notes, setNotes] = useState("");
  const [notesSaved, setNotesSaved] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({
    pickup_city: "",
    delivery_city: "",
    pickup_date: "",
    delivery_date: "",
    rate_amount: "",
  });
  const [savingEdit, setSavingEdit] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/loads/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setLoad(data);
    setNotes(data.notes || "");
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function updateStatus(status: string) {
    await fetch(`/api/loads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    refresh();
  }

  function startEdit() {
    if (!load) return;
    setEdit({
      pickup_city: load.pickup_city || "",
      delivery_city: load.delivery_city || "",
      pickup_date: load.pickup_date || "",
      delivery_date: load.delivery_date || "",
      rate_amount: load.rate_amount ? String(load.rate_amount) : "",
    });
    setEditing(true);
  }

  async function saveEdit() {
    setSavingEdit(true);
    setError("");
    const res = await fetch(`/api/loads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pickup_city: edit.pickup_city,
        delivery_city: edit.delivery_city,
        pickup_date: edit.pickup_date,
        delivery_date: edit.delivery_date,
        rate_amount: edit.rate_amount === "" ? 0 : Number(edit.rate_amount),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Failed to save changes");
    } else {
      setEditing(false);
    }
    setSavingEdit(false);
    refresh();
  }

  async function saveNotes() {
    await fetch(`/api/loads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    setNotesSaved(true);
    setTimeout(() => setNotesSaved(false), 2000);
    refresh();
  }

  async function uploadFiles(e: React.FormEvent) {
    e.preventDefault();
    if (files.length === 0) return;
    setUploading(true);
    setError("");
    const failed: string[] = [];
    for (const f of files) {
      const fd = new FormData();
      fd.set("file", f);
      fd.set("category", category);
      const res = await fetch(`/api/loads/${id}/files`, { method: "POST", body: fd });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        failed.push(`${f.name}: ${data.error || "upload failed"}`);
      }
    }
    if (failed.length) {
      setError(failed.join("; "));
    } else {
      setFiles([]);
      (document.getElementById("file-input") as HTMLInputElement).value = "";
    }
    setUploading(false);
    refresh();
  }

  async function deleteFile(fileId: number) {
    if (!confirm("Delete this file?")) return;
    await fetch(`/api/files/${fileId}`, { method: "DELETE" });
    refresh();
  }

  async function deleteLoad() {
    if (!confirm(`Delete ${load?.load_type === "loadout" ? "Loadout" : "Load"} #${load?.load_number}? Files in storage are kept, but the load record is removed.`)) return;
    await fetch(`/api/loads/${id}`, { method: "DELETE" });
    router.push("/");
  }

  if (!load) {
    return (
      <div className="py-24 text-center text-[13px] text-slate-400">Loading load…</div>
    );
  }

  const typeLabel = load.load_type === "loadout" ? "Loadout" : "Load";
  const currentIdx = STATUSES.findIndex((s) => s.value === load.status);

  return (
    <div className="mx-auto max-w-[860px]">
      <Link
        href="/"
        className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-slate-500 transition-colors hover:text-slate-800"
      >
        <IconArrowLeft className="h-3.5 w-3.5" />
        Load Board
      </Link>

      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
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
              {load.driver_name} / {load.load_type === "loadout" ? "Loadout" : "Loads"} / {typeLabel} #{load.load_number}
            </span>
          </div>
        </div>
        <button
          onClick={deleteLoad}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[12.5px] font-medium text-slate-600 shadow-sm transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-700"
        >
          <IconTrash className="h-3.5 w-3.5" />
          Delete
        </button>
      </div>

      {/* Status pipeline */}
      <div className="mb-5 rounded-lg border border-slate-200/80 bg-white p-5 shadow-sm">
        <div className="mb-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Status Pipeline
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
                  title={`Mark as ${s.label}`}
                  className="group mx-1.5 flex flex-col items-center gap-1.5 focus:outline-none"
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
          {!editing ? (
            <button
              onClick={startEdit}
              className="rounded-md px-2.5 py-1 text-[12px] font-medium text-blue-700 transition-colors hover:bg-blue-50"
            >
              Edit Details
            </button>
          ) : (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setEditing(false)}
                className="rounded-md px-2.5 py-1 text-[12px] font-medium text-slate-500 transition-colors hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={savingEdit}
                className="rounded-md bg-blue-600 px-3 py-1 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {savingEdit ? "Saving…" : "Save Changes"}
              </button>
            </div>
          )}
        </div>

        {!editing ? (
          <div className="grid grid-cols-2 gap-px bg-slate-200/60 sm:grid-cols-4">
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
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Dates</div>
              <div className="tnum mt-1 text-[13px] font-semibold text-slate-900">
                {load.pickup_date ? `${load.pickup_date} → ${load.delivery_date}` : "—"}
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
          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">
                Pickup City
              </label>
              <input
                value={edit.pickup_city}
                onChange={(e) => setEdit({ ...edit, pickup_city: e.target.value })}
                placeholder="e.g. Dallas, TX"
                className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-[13px] shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">
                Delivery City
              </label>
              <input
                value={edit.delivery_city}
                onChange={(e) => setEdit({ ...edit, delivery_city: e.target.value })}
                placeholder="e.g. Atlanta, GA"
                className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-[13px] shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">
                Rate ($)
              </label>
              <input
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
              <label className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">
                Pickup Date
              </label>
              <input
                type="date"
                value={edit.pickup_date}
                onChange={(e) => setEdit({ ...edit, pickup_date: e.target.value })}
                className="tnum w-full rounded-md border border-slate-300 px-3 py-1.5 text-[13px] shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">
                Delivery Date
              </label>
              <input
                type="date"
                value={edit.delivery_date}
                onChange={(e) => setEdit({ ...edit, delivery_date: e.target.value })}
                className="tnum w-full rounded-md border border-slate-300 px-3 py-1.5 text-[13px] shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
          </div>
        )}
        {error && editing && (
          <div className="border-t border-slate-100 px-4 py-2 text-[12.5px] text-red-600">{error}</div>
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
                <button
                  onClick={() => deleteFile(f.id)}
                  title="Delete file"
                  className="rounded-md p-1.5 text-slate-300 opacity-0 transition-all hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
                >
                  <IconTrash className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <form
          onSubmit={uploadFiles}
          className="border-t border-slate-200/80 bg-slate-50/50 px-5 py-3.5"
        >
          <div className="flex flex-wrap items-center gap-2.5">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
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
                id="file-input"
                type="file"
                multiple
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
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
              disabled={files.length === 0 || uploading}
              className="rounded-md bg-blue-600 px-4 py-1.5 text-[12.5px] font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {uploading
                ? "Uploading…"
                : files.length > 1
                  ? `Upload ${files.length} Files`
                  : "Upload"}
            </button>
          </div>
          {files.length > 1 && (
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
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    className="ml-0.5 text-slate-400 hover:text-red-600"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && <div className="mt-2 text-[12.5px] text-red-600">{error}</div>}
        </form>
      </div>

      {/* Notes */}
      <div className="overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm">
        <div className="border-b border-slate-200/80 bg-slate-50/60 px-5 py-3">
          <h2 className="text-[13px] font-semibold text-slate-800">Dispatch Notes</h2>
        </div>
        <div className="p-5">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Notes for this load — lumper info, detention, check calls…"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-[13px] shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
          <div className="mt-2.5 flex items-center gap-3">
            <button
              onClick={saveNotes}
              className="rounded-md bg-slate-800 px-4 py-1.5 text-[12.5px] font-medium text-white shadow-sm transition-colors hover:bg-slate-900"
            >
              Save Notes
            </button>
            {notesSaved && <span className="text-[12.5px] font-medium text-emerald-600">Saved ✓</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

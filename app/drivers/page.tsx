"use client";

import { useState, type FormEvent } from "react";
import { initials } from "@/lib/constants";
import { requestJson } from "@/lib/client-api";
import { errorMessage } from "@/lib/errors";
import type { DriverRecord, DriverSummary } from "@/lib/models";
import { useActionLock } from "@/lib/use-action-lock";
import { useDriverRoster } from "@/lib/use-driver-roster";
import { IconPlus, IconTrash, IconTruck, IconUsers } from "@/components/icons";
import { useStorageStatus } from "@/components/StorageStatusProvider";

export default function DriversPage() {
  const { canWrite } = useStorageStatus();
  const { drivers, loading, error: rosterError, refresh } = useDriverRoster();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [truck, setTruck] = useState("");
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [edit, setEdit] = useState({ name: "", phone: "", truck: "" });
  const [editError, setEditError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const { pending, begin, finish } = useActionLock();
  const busy = pending !== null;

  async function addDriver(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canWrite) return;
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (!begin("add")) return;
    setError("");
    try {
      await requestJson<DriverRecord>("/api/drivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), phone: phone.trim(), truck: truck.trim() }),
      });
      setName("");
      setPhone("");
      setTruck("");
      await refresh();
    } catch (failure: unknown) {
      setError(errorMessage(failure));
    } finally {
      finish();
    }
  }

  function startEdit(d: DriverSummary) {
    if (busy) return;
    setEditingId(d.id);
    setEdit({ name: d.name, phone: d.phone || "", truck: d.truck || "" });
    setEditError("");
  }

  async function saveEdit(id: number) {
    if (!edit.name.trim()) {
      setEditError("Name is required");
      return;
    }
    if (!begin(`edit:${id}`)) return;
    setEditError("");
    try {
      await requestJson<DriverRecord>(`/api/drivers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: edit.name.trim(),
          phone: edit.phone.trim(),
          truck: edit.truck.trim(),
        }),
      });
      setEditingId(null);
      await refresh();
    } catch (failure: unknown) {
      setEditError(errorMessage(failure));
    } finally {
      finish();
    }
  }

  async function deleteDriver(d: DriverSummary) {
    if (!canWrite || busy) return;
    setDeleteError("");
    if (d.load_count > 0) {
      setDeleteError(`${d.name} has ${d.load_count} assigned load(s), including archived loads. Reassign them first; archived loads must be restored before reassignment. Archiving does not remove a driver's assignments.`);
      return;
    }
    if (!confirm(`Remove driver ${d.name}? The driver's existing storage folder will be kept.`)) return;
    if (!begin(`delete:${d.id}`)) return;
    try {
      await requestJson<{ ok: boolean }>(`/api/drivers/${d.id}`, { method: "DELETE" });
      await refresh();
    } catch (failure: unknown) {
      setDeleteError(errorMessage(failure));
    } finally {
      finish();
    }
  }

  return (
    <div className="mx-auto max-w-[860px]">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-slate-900">Drivers</h1>
          <p className="mt-0.5 text-[12.5px] text-slate-500">
            Each driver gets a folder in storage — load paperwork files under it automatically.
          </p>
        </div>
      </div>

      {/* Add driver */}
      {canWrite && <div className="mb-5 overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm">
        <div className="border-b border-slate-200/80 bg-slate-50/60 px-5 py-3">
          <h2 className="text-[13px] font-semibold text-slate-800">Add Driver</h2>
        </div>
        <form onSubmit={addDriver} className="flex flex-wrap items-end gap-3 p-5">
          <div className="min-w-[180px] flex-1">
            <label htmlFor="driver-name" className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">
              Full Name <span className="text-red-500">*</span>
            </label>
            <input
              id="driver-name"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g. John Carter"
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-[13px] shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div className="min-w-[140px] flex-1">
            <label htmlFor="driver-phone" className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">
              Phone
            </label>
            <input
              id="driver-phone"
              value={phone}
              disabled={busy}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(555) 000-0000"
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-[13px] shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div className="min-w-[110px] flex-1">
            <label htmlFor="driver-truck" className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">
              Truck #
            </label>
            <input
              id="driver-truck"
              value={truck}
              disabled={busy}
              onChange={(e) => setTruck(e.target.value)}
              placeholder="e.g. 204"
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-[13px] shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-[7px] text-[12.5px] font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            <IconPlus className="h-3.5 w-3.5" />
            {pending === "add" ? "Adding…" : "Add Driver"}
          </button>
          {error && <div role="alert" className="w-full text-[12.5px] text-red-600">{error}</div>}
        </form>
      </div>}

      {/* Roster */}
      <div className="overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200/80 bg-slate-50/60 px-5 py-3">
          <h2 className="text-[13px] font-semibold text-slate-800">
            Roster <span className="tnum ml-1 font-normal text-slate-400">{loading || rosterError ? "—" : drivers.length}</span>
          </h2>
          <span className="text-[11.5px] text-slate-500">Load counts include archives</span>
        </div>

        {deleteError && <div role="alert" className="border-b border-red-200 bg-red-50 px-5 py-3 text-[12.5px] text-red-800">{deleteError}</div>}
        {loading ? (
          <div role="status" className="px-5 py-10 text-center text-[13px] text-slate-400">Loading…</div>
        ) : rosterError ? (
          <div role="alert" className="px-5 py-8 text-center text-[13px] text-red-800">
            <p>Unable to load the driver roster: {rosterError}</p>
            <button onClick={() => void refresh()} disabled={busy} className="mt-3 rounded-md border border-red-200 px-3 py-1.5 font-semibold hover:bg-red-50 disabled:opacity-50">Retry roster</button>
          </div>
        ) : drivers.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <IconUsers className="mx-auto mb-2 h-6 w-6 text-slate-300" />
            <div className="text-[13px] text-slate-400">
              {canWrite ? "No drivers yet. Add your first driver above." : "No drivers yet. Use Sync Storage on the load board to import existing driver folders."}
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {drivers.map((d) => (
              <li key={d.id} className="group px-5 py-3.5 transition-colors hover:bg-slate-50/70">
                {editingId === d.id ? (
                  <form onSubmit={(event) => { event.preventDefault(); void saveEdit(d.id); }} className="flex flex-wrap items-end gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-full bg-slate-800 text-[11px] font-semibold text-white">
                      {initials(edit.name || d.name)}
                    </span>
                    <div className="min-w-[160px] flex-1">
                      <label htmlFor={`edit-driver-name-${d.id}`} className="mb-1 block text-[10.5px] font-medium uppercase tracking-wide text-slate-500">Name</label>
                      <input
                        id={`edit-driver-name-${d.id}`}
                        value={edit.name}
                        required
                        disabled={busy || !canWrite}
                        onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                        className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px] shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                      />
                    </div>
                    <div className="min-w-[120px] flex-1">
                      <label htmlFor={`edit-driver-phone-${d.id}`} className="mb-1 block text-[10.5px] font-medium uppercase tracking-wide text-slate-500">Phone</label>
                      <input
                        id={`edit-driver-phone-${d.id}`}
                        value={edit.phone}
                        disabled={busy}
                        onChange={(e) => setEdit({ ...edit, phone: e.target.value })}
                        className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px] shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                      />
                    </div>
                    <div className="min-w-[90px] w-28">
                      <label htmlFor={`edit-driver-truck-${d.id}`} className="mb-1 block text-[10.5px] font-medium uppercase tracking-wide text-slate-500">Truck #</label>
                      <input
                        id={`edit-driver-truck-${d.id}`}
                        value={edit.truck}
                        disabled={busy}
                        onChange={(e) => setEdit({ ...edit, truck: e.target.value })}
                        className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px] shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                      />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        disabled={busy}
                        className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={busy}
                        className="rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50"
                      >
                        {pending === `edit:${d.id}` ? "Saving…" : "Save"}
                      </button>
                    </div>
                    {editError && <div role="alert" className="w-full text-[12.5px] text-red-600">{editError}</div>}
                    {edit.name.trim() !== d.name && (
                      <div className="w-full text-[11.5px] text-amber-600">
                        Renaming will also rename this driver&apos;s folder in storage.
                      </div>
                    )}
                  </form>
                ) : (
                  <div className="flex items-center gap-3.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[11px] font-semibold text-white">
                      {initials(d.name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-semibold text-slate-900">{d.name}</div>
                      <div className="mt-0.5 flex items-center gap-3 text-[12px] text-slate-500">
                        {d.phone && <span className="tnum">{d.phone}</span>}
                        {d.truck && (
                          <span className="inline-flex items-center gap-1">
                            <IconTruck className="h-3.5 w-3.5 text-slate-400" />
                            Truck {d.truck}
                          </span>
                        )}
                      </div>
                    </div>
                    <span title="Includes active and archived loads" className="tnum rounded-full bg-slate-100 px-2.5 py-0.5 text-[11.5px] font-medium text-slate-600">
                      {d.load_count} load{d.load_count === 1 ? "" : "s"}
                    </span>
                    <button
                      onClick={() => startEdit(d)}
                      disabled={busy}
                      className="rounded-md px-2 py-1 text-[12px] font-medium text-slate-400 transition-all hover:bg-slate-100 hover:text-blue-700 focus:opacity-100 disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteDriver(d)}
                      disabled={busy || !canWrite}
                      title="Remove driver"
                      aria-label={`Remove driver ${d.name}`}
                      className="rounded-md p-1.5 text-slate-400 transition-all hover:bg-red-50 hover:text-red-600 focus:opacity-100 disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100"
                    >
                      {pending === `delete:${d.id}` ? <span className="text-[11px]">Removing…</span> : <IconTrash className="h-4 w-4" />}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

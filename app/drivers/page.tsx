"use client";

import { useCallback, useEffect, useState } from "react";
import { initials } from "@/lib/constants";
import { IconPlus, IconTrash, IconTruck, IconUsers } from "@/components/icons";

interface Driver {
  id: number;
  name: string;
  phone: string;
  truck: string;
  load_count: number;
}

export default function DriversPage() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [truck, setTruck] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [edit, setEdit] = useState({ name: "", phone: "", truck: "" });
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState("");

  const refresh = useCallback(async () => {
    const res = await fetch("/api/drivers");
    if (res.ok) setDrivers(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function addDriver(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError("");
    const res = await fetch("/api/drivers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), phone: phone.trim(), truck: truck.trim() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Failed to add driver");
    } else {
      setName("");
      setPhone("");
      setTruck("");
    }
    setSaving(false);
    refresh();
  }

  function startEdit(d: Driver) {
    setEditingId(d.id);
    setEdit({ name: d.name, phone: d.phone || "", truck: d.truck || "" });
    setEditError("");
  }

  async function saveEdit(id: number) {
    if (!edit.name.trim()) {
      setEditError("Name is required");
      return;
    }
    setSavingEdit(true);
    setEditError("");
    const res = await fetch(`/api/drivers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: edit.name.trim(),
        phone: edit.phone.trim(),
        truck: edit.truck.trim(),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setEditError(data.error || "Failed to save changes");
    } else {
      setEditingId(null);
    }
    setSavingEdit(false);
    refresh();
  }

  async function deleteDriver(d: Driver) {
    if (d.load_count > 0) {
      alert(`${d.name} has ${d.load_count} load(s) on the board. Remove or reassign those loads first.`);
      return;
    }
    if (!confirm(`Remove driver ${d.name}?`)) return;
    const res = await fetch(`/api/drivers/${d.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to delete driver");
    }
    refresh();
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
      <div className="mb-5 overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm">
        <div className="border-b border-slate-200/80 bg-slate-50/60 px-5 py-3">
          <h2 className="text-[13px] font-semibold text-slate-800">Add Driver</h2>
        </div>
        <form onSubmit={addDriver} className="flex flex-wrap items-end gap-3 p-5">
          <div className="min-w-[180px] flex-1">
            <label className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">
              Full Name <span className="text-red-500">*</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g. John Carter"
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-[13px] shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div className="min-w-[140px] flex-1">
            <label className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">
              Phone
            </label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(555) 000-0000"
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-[13px] shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div className="min-w-[110px] flex-1">
            <label className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-slate-500">
              Truck #
            </label>
            <input
              value={truck}
              onChange={(e) => setTruck(e.target.value)}
              placeholder="e.g. 204"
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-[13px] shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-[7px] text-[12.5px] font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            <IconPlus className="h-3.5 w-3.5" />
            {saving ? "Adding…" : "Add Driver"}
          </button>
          {error && <div className="w-full text-[12.5px] text-red-600">{error}</div>}
        </form>
      </div>

      {/* Roster */}
      <div className="overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200/80 bg-slate-50/60 px-5 py-3">
          <h2 className="text-[13px] font-semibold text-slate-800">
            Roster <span className="tnum ml-1 font-normal text-slate-400">{drivers.length}</span>
          </h2>
        </div>

        {loading ? (
          <div className="px-5 py-10 text-center text-[13px] text-slate-400">Loading…</div>
        ) : drivers.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <IconUsers className="mx-auto mb-2 h-6 w-6 text-slate-300" />
            <div className="text-[13px] text-slate-400">
              No drivers yet. Add your first driver above.
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {drivers.map((d) => (
              <li key={d.id} className="group px-5 py-3.5 transition-colors hover:bg-slate-50/70">
                {editingId === d.id ? (
                  <div className="flex flex-wrap items-end gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-full bg-slate-800 text-[11px] font-semibold text-white">
                      {initials(edit.name || d.name)}
                    </span>
                    <div className="min-w-[160px] flex-1">
                      <label className="mb-1 block text-[10.5px] font-medium uppercase tracking-wide text-slate-500">Name</label>
                      <input
                        value={edit.name}
                        onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                        className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px] shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                      />
                    </div>
                    <div className="min-w-[120px] flex-1">
                      <label className="mb-1 block text-[10.5px] font-medium uppercase tracking-wide text-slate-500">Phone</label>
                      <input
                        value={edit.phone}
                        onChange={(e) => setEdit({ ...edit, phone: e.target.value })}
                        className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px] shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                      />
                    </div>
                    <div className="min-w-[90px] w-28">
                      <label className="mb-1 block text-[10.5px] font-medium uppercase tracking-wide text-slate-500">Truck #</label>
                      <input
                        value={edit.truck}
                        onChange={(e) => setEdit({ ...edit, truck: e.target.value })}
                        className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px] shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                      />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setEditingId(null)}
                        className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-slate-500 transition-colors hover:bg-slate-100"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => saveEdit(d.id)}
                        disabled={savingEdit}
                        className="rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50"
                      >
                        {savingEdit ? "Saving…" : "Save"}
                      </button>
                    </div>
                    {editError && <div className="w-full text-[12.5px] text-red-600">{editError}</div>}
                    {edit.name.trim() !== d.name && (
                      <div className="w-full text-[11.5px] text-amber-600">
                        Renaming will also rename this driver&apos;s folder in storage.
                      </div>
                    )}
                  </div>
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
                    <span className="tnum rounded-full bg-slate-100 px-2.5 py-0.5 text-[11.5px] font-medium text-slate-600">
                      {d.load_count} load{d.load_count === 1 ? "" : "s"}
                    </span>
                    <button
                      onClick={() => startEdit(d)}
                      className="rounded-md px-2 py-1 text-[12px] font-medium text-slate-400 opacity-0 transition-all hover:bg-slate-100 hover:text-blue-700 group-hover:opacity-100"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteDriver(d)}
                      title="Remove driver"
                      className="rounded-md p-1.5 text-slate-300 opacity-0 transition-all hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
                    >
                      <IconTrash className="h-4 w-4" />
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

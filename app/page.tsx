"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import StatusBadge from "@/components/StatusBadge";
import { STATUSES, fmtMoney, loadTypeLabel, initials } from "@/lib/constants";
import { IconPlus, IconSearch, IconSync, IconTruck, IconRoute, IconDollar, IconFile, IconChevronDown } from "@/components/icons";

interface LoadRow {
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
}

export default function Dashboard() {
  const router = useRouter();
  const [loads, setLoads] = useState<LoadRow[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (q) params.set("q", q);
    const res = await fetch(`/api/loads?${params}`);
    setLoads(await res.json());
    setLoading(false);
  }, [statusFilter, q]);

  useEffect(() => {
    const t = setTimeout(refresh, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [refresh, q]);

  async function updateStatus(id: number, status: string) {
    await fetch(`/api/loads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    refresh();
  }

  async function syncFromStorage() {
    setSyncing(true);
    setSyncMsg("");
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const s = await res.json();
      if (!res.ok) throw new Error(s.error || "Sync failed");
      let msg = `Sync complete: ${s.loadsImported} load(s) imported, ${s.filesImported} file(s) imported.`;
      if (s.errors?.length) msg += ` ${s.errors.length} error(s): ${s.errors.join("; ")}`;
      setSyncMsg(msg);
      refresh();
    } catch (e: any) {
      setSyncMsg(`Sync failed: ${e.message}`);
    }
    setSyncing(false);
  }

  const totals = STATUSES.map((s) => ({
    ...s,
    count: loads.filter((l) => l.status === s.value).length,
  }));

  const activeCount = loads.filter((l) => l.status !== "paid").length;
  const inTransit = loads.filter((l) => l.status === "picked_up").length;
  const awaitingPay = loads.filter((l) => l.status === "invoiced").length;
  const totalBooked = loads.reduce((sum, l) => sum + (l.rate_amount || 0), 0);

  const kpis = [
    { label: "Active Loads", value: String(activeCount), icon: IconTruck, tint: "bg-blue-50 text-blue-600" },
    { label: "In Transit", value: String(inTransit), icon: IconRoute, tint: "bg-amber-50 text-amber-600" },
    { label: "Awaiting Payment", value: String(awaitingPay), icon: IconFile, tint: "bg-violet-50 text-violet-600" },
    { label: "Total Booked", value: fmtMoney(totalBooked), icon: IconDollar, tint: "bg-emerald-50 text-emerald-600" },
  ];

  return (
    <div>
      {/* Page header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-slate-900">Load Board</h1>
          <p className="mt-0.5 text-[13px] text-slate-500">
            Track every load from booking to payment.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            onClick={syncFromStorage}
            disabled={syncing}
            title="Import load folders created manually in storage under registered drivers"
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-[13px] font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            <IconSync className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : "Sync Storage"}
          </button>
          <Link
            href="/loads/new"
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3.5 py-2 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-blue-700"
          >
            <IconPlus className="h-3.5 w-3.5" />
            Book Load
          </Link>
        </div>
      </div>

      {syncMsg && (
        <div className="mb-5 rounded-md border border-blue-200 bg-blue-50 px-4 py-2.5 text-[13px] text-blue-900">
          {syncMsg}
        </div>
      )}

      {/* KPI strip */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpis.map((k) => {
          const Icon = k.icon;
          return (
            <div key={k.label} className="flex items-center gap-3.5 rounded-lg border border-slate-200/80 bg-white px-4 py-3.5 shadow-sm">
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${k.tint}`}>
                <Icon className="h-4.5 w-4.5" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-[11px] font-medium uppercase tracking-wide text-slate-500">{k.label}</div>
                <div className="tnum text-lg font-semibold leading-tight text-slate-900">{k.value}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setStatusFilter("")}
          className={`rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
            statusFilter === ""
              ? "bg-slate-900 text-white"
              : "text-slate-600 hover:bg-slate-200/70"
          }`}
        >
          All{statusFilter === "" ? ` · ${loads.length}` : ""}
        </button>
        {totals.map((s) => (
          <button
            key={s.value}
            onClick={() => setStatusFilter(statusFilter === s.value ? "" : s.value)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
              statusFilter === s.value
                ? "bg-slate-900 text-white"
                : "text-slate-600 hover:bg-slate-200/70"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
            {s.label}
            {statusFilter === "" && <span className="tnum text-slate-400">{s.count}</span>}
          </button>
        ))}
        <div className="relative ml-auto">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search load #, city, driver…"
            className="w-72 rounded-md border border-slate-300 bg-white py-1.5 pl-9 pr-3 text-[13px] shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2.5">Load</th>
              <th className="px-4 py-2.5">Driver</th>
              <th className="px-4 py-2.5">Route</th>
              <th className="px-4 py-2.5">Pickup</th>
              <th className="px-4 py-2.5">Delivery</th>
              <th className="px-4 py-2.5 text-right">Rate</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="w-10 px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-16 text-center text-[13px] text-slate-400">
                  Loading loads…
                </td>
              </tr>
            ) : loads.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-16 text-center">
                  <IconTruck className="mx-auto mb-3 h-8 w-8 text-slate-300" />
                  <div className="text-[14px] font-medium text-slate-600">No loads found</div>
                  <div className="mt-1 text-[13px] text-slate-400">
                    Book a load or sync existing folders from storage.
                  </div>
                </td>
              </tr>
            ) : (
              loads.map((l) => (
                <tr
                  key={l.id}
                  onClick={() => router.push(`/loads/${l.id}`)}
                  className="group cursor-pointer border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50/70"
                >
                  <td className="px-4 py-3">
                    <span className="font-mono text-[13px] font-semibold text-slate-900">
                      {l.load_number}
                    </span>
                    {l.load_type === "loadout" && (
                      <span className="ml-2 rounded bg-orange-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-700 ring-1 ring-inset ring-orange-200">
                        Loadout
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-[10px] font-semibold text-slate-600">
                        {initials(l.driver_name)}
                      </span>
                      <span className="font-medium text-slate-800">{l.driver_name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {l.pickup_city ? (
                      <span className="inline-flex items-center gap-1.5">
                        {l.pickup_city}
                        <svg className="h-3 w-3 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12h14M13 6l6 6-6 6" />
                        </svg>
                        {l.delivery_city}
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="tnum px-4 py-3 text-slate-600">{l.pickup_date || <span className="text-slate-400">—</span>}</td>
                  <td className="tnum px-4 py-3 text-slate-600">{l.delivery_date || <span className="text-slate-400">—</span>}</td>
                  <td className="tnum px-4 py-3 text-right font-semibold text-slate-900">
                    {l.rate_amount ? fmtMoney(l.rate_amount) : <span className="font-normal text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={l.status} />
                  </td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <div className="relative opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                      <select
                        value={l.status}
                        onChange={(e) => updateStatus(l.id, e.target.value)}
                        title="Update status"
                        className="w-7 cursor-pointer appearance-none rounded-md border border-slate-300 bg-white py-1 pl-2 text-transparent shadow-sm hover:bg-slate-50 focus:outline-none"
                      >
                        {STATUSES.map((s) => (
                          <option key={s.value} value={s.value} className="text-slate-900">
                            {s.label}
                          </option>
                        ))}
                      </select>
                      <IconChevronDown className="pointer-events-none absolute left-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

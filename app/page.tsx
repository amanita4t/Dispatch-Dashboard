"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import StatusBadge from "@/components/StatusBadge";
import { useStorageStatus } from "@/components/StorageStatusProvider";
import { STATUSES, LOAD_TYPE_OPTIONS, fmtMoney, loadTypeLabel, initials } from "@/lib/constants";
import { BOARD_FILTER_DEFAULTS, boardUrl, readBoardFilters, withBoardReturn, type BoardFilters } from "@/lib/board-navigation";
import { requestJson } from "@/lib/client-api";
import { overdueLabel } from "@/lib/dates";
import { errorMessage } from "@/lib/errors";
import type { LoadDetail, LoadStatus, LoadWithDriver, SyncResponse, SyncSummary } from "@/lib/models";
import { useActionLock } from "@/lib/use-action-lock";
import { useDriverRoster } from "@/lib/use-driver-roster";
import { useLocalToday } from "@/lib/use-local-today";
import { IconPlus, IconSearch, IconSync, IconTruck, IconRoute, IconDollar, IconFile, IconChevronDown } from "@/components/icons";

const filterCls = "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[13px] shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20";
const filterLabelCls = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500";
const MAX_SYNC_BATCHES_PER_RUN = 250;

function syncSummaryMessage(summary: SyncSummary): string {
  let message = summary.errors.length
    ? "Sync finished with issues. Check storage access and try again."
    : "Sync complete.";
  if (summary.loadsArchived) message += ` ${summary.loadsArchived} load${summary.loadsArchived === 1 ? "" : "s"} archived.`;
  return message;
}

function SortableHeading({
  field, label, sort, order, onSort, right = false,
}: {
  field: string;
  label: string;
  sort: string;
  order: string;
  onSort: (field: string) => void;
  right?: boolean;
}) {
  return (
    <th scope="col" className={`px-4 py-2.5 ${right ? "text-right" : ""}`} aria-sort={sort === field ? (order === "asc" ? "ascending" : "descending") : "none"}>
      <button onClick={() => onSort(field)} className="whitespace-nowrap text-left uppercase hover:text-blue-700 focus-visible:outline-blue-600">
        {label}<span className="ml-1" aria-hidden="true">{sort === field ? (order === "asc" ? "↑" : "↓") : "↕"}</span>
      </button>
    </th>
  );
}

export default function Dashboard() {
  return (
    <Suspense fallback={<div className="py-24 text-center text-[13px] text-slate-400">Loading load board…</div>}>
      <LoadBoard />
    </Suspense>
  );
}

function LoadBoard() {
  const { canWrite } = useStorageStatus();
  const router = useRouter();
  const searchParams = useSearchParams();
  const navigationUrl = boardUrl(readBoardFilters(searchParams));
  const [filters, setFilters] = useState(() => readBoardFilters(searchParams));
  const { status: statusFilter, driver_id: driverFilter, load_type: loadTypeFilter, q } = filters;
  const returnTo = boardUrl(filters);
  const query = returnTo.slice(1);
  const [loads, setLoads] = useState<LoadWithDriver[]>([]);
  const { drivers, loading: driversLoading, error: driverError, refresh: refreshDrivers } = useDriverRoster();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [syncMsg, setSyncMsg] = useState("");
  const [syncCursor, setSyncCursor] = useState<string | null>(null);
  const syncRequest = useRef<AbortController | null>(null);
  const { pending, begin, finish } = useActionLock();
  const syncing = pending === "sync";
  const today = useLocalToday();
  const searchHistoryStarted = useRef(false);

  const refresh = useCallback(() => setRefreshVersion((version) => version + 1), []);

  useEffect(() => () => syncRequest.current?.abort(), []);

  useEffect(() => {
    const current = readBoardFilters(new URLSearchParams(window.location.search));
    // Ignore an older router transition after a newer filter edit updated native history.
    if (boardUrl(current) === navigationUrl) setFilters(current);
  }, [navigationUrl]);

  useEffect(() => {
    const resetSearchHistory = () => {
      searchHistoryStarted.current = false;
      setFilters(readBoardFilters(new URLSearchParams(window.location.search)));
    };
    window.addEventListener("popstate", resetSearchHistory);
    return () => window.removeEventListener("popstate", resetSearchHistory);
  }, []);

  function changeFilters(changes: Partial<BoardFilters>, replace = false) {
    const current = readBoardFilters(new URLSearchParams(window.location.search));
    const next = { ...current, ...changes };
    const url = boardUrl(next);
    setFilters(next);
    if (url !== window.location.pathname + window.location.search) {
      if (replace) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
    }
    if (!("q" in changes)) searchHistoryStarted.current = false;
  }

  function sortBy(field: string) {
    changeFilters({ sort: field, order: filters.sort === field && filters.order === "asc" ? "desc" : "asc" });
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    async function fetchLoads() {
      try {
        const data = await requestJson<LoadWithDriver[]>(`/api/loads${query}`, { signal: controller.signal });
        if (!controller.signal.aborted) setLoads(data);
      } catch (failure: unknown) {
        if (!controller.signal.aborted) setLoadError(errorMessage(failure));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    const t = setTimeout(fetchLoads, q ? 250 : 0);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [query, q, refreshVersion]);

  async function updateStatus(load: LoadWithDriver, status: LoadStatus) {
    if (load.archived_at || load.status === status || !begin(`status:${load.id}`)) return;
    setActionError("");
    try {
      await requestJson<LoadDetail>(`/api/loads/${load.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      refresh();
    } catch (failure: unknown) {
      setActionError(`Could not update ${loadTypeLabel(load.load_type)} #${load.load_number}: ${errorMessage(failure)}`);
    } finally {
      finish();
    }
  }

  async function syncFromStorage(startNew = false) {
    if (!begin("sync")) return;
    const controller = new AbortController();
    syncRequest.current = controller;
    let cursor = startNew ? null : syncCursor;
    if (startNew) setSyncCursor(null);
    setSyncMsg(cursor ? "Resuming sync…" : "Syncing storage…");
    setActionError("");
    try {
      for (let batch = 1; batch <= MAX_SYNC_BATCHES_PER_RUN; batch++) {
        const summary = await requestJson<SyncResponse>("/api/sync", {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cursor ? { cursor } : {}),
        });
        if (controller.signal.aborted) return;
        if (!summary || (summary.cursor !== null && (typeof summary.cursor !== "string" || !summary.cursor.trim()))) {
          throw new Error("The server returned an invalid sync cursor. Refresh the application before retrying.");
        }
        cursor = summary.cursor;
        setSyncCursor(cursor);
        setSyncMsg(cursor ? "Syncing storage…" : syncSummaryMessage(summary));
        if (cursor === null) return;
      }
      throw new Error("The per-run batch limit was reached. Continue the saved sync to process the remaining folders.");
    } catch (failure: unknown) {
      if (!controller.signal.aborted) {
        console.error(`[dispatch sync] ${errorMessage(failure)}`);
        setSyncMsg("");
        setActionError(cursor
          ? "Sync paused. Resume sync or start a new run."
          : "Sync failed. Refresh the dashboard and try again.");
      }
    } finally {
      if (!controller.signal.aborted) {
        refresh();
        await refreshDrivers();
        if (!controller.signal.aborted) finish();
      }
      if (syncRequest.current === controller) syncRequest.current = null;
    }
  }

  const resultsReady = !loading && !loadError;
  const visibleLoads = resultsReady ? loads : [];
  const totals = STATUSES.map((s) => ({
    ...s,
    count: visibleLoads.filter((l) => l.status === s.value).length,
  }));

  const activeCount = visibleLoads.filter((l) => !l.archived_at && l.status !== "paid").length;
  const inTransit = visibleLoads.filter((l) => !l.archived_at && l.status === "picked_up").length;
  const awaitingPay = visibleLoads.filter((l) => !l.archived_at && l.status === "invoiced").length;
  const totalBooked = visibleLoads.reduce((sum, l) => sum + l.rate_amount, 0);

  const kpis = [
    { label: "Active Loads", value: String(activeCount), icon: IconTruck, tint: "bg-blue-50 text-blue-600" },
    { label: "In Transit", value: String(inTransit), icon: IconRoute, tint: "bg-amber-50 text-amber-600" },
    { label: "Awaiting Payment", value: String(awaitingPay), icon: IconFile, tint: "bg-violet-50 text-violet-600" },
    { label: "Total Booked", value: fmtMoney(totalBooked), icon: IconDollar, tint: "bg-emerald-50 text-emerald-600" },
  ];

  return (
    <div>
      {/* Page header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-slate-900">Load Board</h1>
          <p className="mt-0.5 text-[13px] text-slate-500">
            Track every load from booking to payment.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => syncFromStorage()}
            disabled={pending !== null}
            title="Import drivers, loads, and documents in resumable batches, and archive loads whose folders were deleted"
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-[13px] font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            <IconSync className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : syncCursor ? "Resume Sync" : "Sync Storage"}
          </button>
          {syncCursor && !syncing && (
            <button
              onClick={() => syncFromStorage(true)}
              disabled={pending !== null}
              title="Start a new scan instead of continuing the saved run"
              className="rounded-md px-2 py-2 text-[12px] font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            >
              Start new sync
            </button>
          )}
          {canWrite && <Link
            href={withBoardReturn("/loads/new", returnTo)}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3.5 py-2 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-blue-700"
          >
            <IconPlus className="h-3.5 w-3.5" />
            Book Load
          </Link>}
        </div>
      </div>

      {syncMsg && (
        <div role="status" aria-live="polite" aria-busy={syncing} className="mb-4 text-[12px] text-slate-500">
          {syncMsg}
        </div>
      )}

      {/* KPI strip */}
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Filtered totals</h2>
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
                <div className="tnum text-lg font-semibold leading-tight text-slate-900">{resultsReady ? k.value : "—"}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">View</span>
        {[
          { value: "active", label: "Active" },
          { value: "archived", label: "Archived" },
          { value: "all", label: "All loads" },
        ].map((view) => (
          <button
            key={view.value}
            aria-pressed={filters.archived === view.value}
            onClick={() => changeFilters({ archived: view.value })}
            className={`rounded-md border px-3 py-1.5 text-[12.5px] font-medium transition-colors ${filters.archived === view.value ? "border-blue-200 bg-blue-50 text-blue-800" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            {view.label}
          </button>
        ))}
        <button
          onClick={() => changeFilters(BOARD_FILTER_DEFAULTS)}
          disabled={returnTo === "/"}
          className="ml-auto rounded-md px-3 py-1.5 text-[12.5px] font-medium text-slate-600 hover:bg-slate-200/70 disabled:opacity-40"
        >
          Clear filters
        </button>
      </div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="driver-filter" className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Driver
          </label>
          <select
            id="driver-filter"
            value={driverFilter}
            onChange={(e) => changeFilters({ driver_id: e.target.value })}
            disabled={driversLoading || Boolean(driverError)}
            className="w-48 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[13px] shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          >
            <option value="">All drivers</option>
            {driverFilter && !drivers.some((driver) => String(driver.id) === driverFilter) && (
              <option value={driverFilter}>Driver #{driverFilter}{driversLoading ? " (loading…)" : ""}</option>
            )}
            {drivers.map((driver) => (
              <option key={driver.id} value={driver.id}>
                {driver.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="load-type-filter" className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Load Type
          </label>
          <select
            id="load-type-filter"
            value={loadTypeFilter}
            onChange={(e) => changeFilters({ load_type: e.target.value })}
            className="w-44 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[13px] shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          >
            <option value="">All load types</option>
            {LOAD_TYPE_OPTIONS.map((type) => (
              <option key={type.value} value={type.value}>
                {loadTypeLabel(type.value)}
              </option>
            ))}
          </select>
        </div>
        <div className="relative ml-auto">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => {
              changeFilters({ q: e.target.value }, searchHistoryStarted.current);
              searchHistoryStarted.current = true;
            }}
            onBlur={() => { searchHistoryStarted.current = false; }}
            placeholder="Search load #, city, driver…"
            aria-label="Search loads"
            className="w-72 rounded-md border border-slate-300 bg-white py-1.5 pl-9 pr-3 text-[13px] shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="date-field-filter" className={filterLabelCls}>Date field</label>
          <select id="date-field-filter" value={filters.date_field} onChange={(e) => changeFilters({ date_field: e.target.value })} className={filterCls}>
            <option value="pickup_date">Pickup date</option>
            <option value="delivery_date">Delivery date</option>
            <option value="invoice_due_date">Invoice due date</option>
          </select>
        </div>
        <div>
          <label htmlFor="date-from-filter" className={filterLabelCls}>From (inclusive)</label>
          <input id="date-from-filter" type="date" value={filters.date_from} onChange={(e) => changeFilters({ date_from: e.target.value })} className={`${filterCls} tnum`} />
        </div>
        <div>
          <label htmlFor="date-to-filter" className={filterLabelCls}>To (inclusive)</label>
          <input id="date-to-filter" type="date" value={filters.date_to} min={filters.date_from || undefined} onChange={(e) => changeFilters({ date_to: e.target.value })} className={`${filterCls} tnum`} />
        </div>
        <div className="sm:ml-auto">
          <label htmlFor="sort-filter" className={filterLabelCls}>Sort by</label>
          <select id="sort-filter" value={filters.sort} onChange={(e) => changeFilters({ sort: e.target.value })} className={filterCls}>
            <option value="created_at">Created date</option>
            <option value="load_number">Load number</option>
            <option value="driver_name">Driver</option>
            <option value="pickup_date">Pickup date</option>
            <option value="delivery_date">Delivery date</option>
            <option value="invoice_due_date">Invoice due date</option>
            <option value="rate_amount">Rate</option>
            <option value="status">Status</option>
          </select>
        </div>
        <div>
          <label htmlFor="order-filter" className={filterLabelCls}>Order</label>
          <select id="order-filter" value={filters.order} onChange={(e) => changeFilters({ order: e.target.value })} className={filterCls}>
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </div>
      </div>
      {driverError && (
        <div role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-800">
          Driver filter unavailable: {driverError}{" "}
          <button onClick={() => void refreshDrivers()} className="font-semibold underline">Retry drivers</button>
        </div>
      )}
      {loadError && (
        <div role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-800">
          {loadError}{" "}
          <button onClick={refresh} className="font-semibold underline">Retry loads</button>
        </div>
      )}
      {actionError && (
        <div role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-800">
          {actionError}
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => changeFilters({ status: "" })}
          aria-pressed={statusFilter === ""}
          className={`rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
            statusFilter === ""
              ? "bg-slate-900 text-white"
              : "text-slate-600 hover:bg-slate-200/70"
          }`}
        >
          All statuses{statusFilter === "" && resultsReady ? ` · ${loads.length}` : ""}
        </button>
        {totals.map((s) => (
          <button
            key={s.value}
            onClick={() => changeFilters({ status: statusFilter === s.value ? "" : s.value })}
            aria-pressed={statusFilter === s.value}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
              statusFilter === s.value
                ? "bg-slate-900 text-white"
                : "text-slate-600 hover:bg-slate-200/70"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
            {s.label}
            {statusFilter === "" && resultsReady && <span className="tnum text-slate-400">{s.count}</span>}
          </button>
        ))}
      </div>

      {/* Table */}
      {pending?.startsWith("status:") && <p role="status" className="mb-2 text-[12px] text-slate-500">Updating status…</p>}
      <div className="overflow-x-auto rounded-lg border border-slate-200/80 bg-white shadow-sm">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <SortableHeading field="load_number" label="Load" sort={filters.sort} order={filters.order} onSort={sortBy} />
              <SortableHeading field="driver_name" label="Driver" sort={filters.sort} order={filters.order} onSort={sortBy} />
              <th scope="col" className="px-4 py-2.5">Route</th>
              <SortableHeading field="pickup_date" label="Pickup" sort={filters.sort} order={filters.order} onSort={sortBy} />
              <SortableHeading field="delivery_date" label="Delivery" sort={filters.sort} order={filters.order} onSort={sortBy} />
              <SortableHeading field="invoice_due_date" label="Invoice due" sort={filters.sort} order={filters.order} onSort={sortBy} />
              <SortableHeading field="rate_amount" label="Rate" sort={filters.sort} order={filters.order} onSort={sortBy} right />
              <SortableHeading field="status" label="Status" sort={filters.sort} order={filters.order} onSort={sortBy} />
              <th scope="col" className="w-10 px-4 py-2.5"><span className="sr-only">Update status</span></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} className="px-4 py-16 text-center text-[13px] text-slate-400">
                  Loading loads…
                </td>
              </tr>
            ) : loadError ? (
              <tr>
                <td colSpan={9} className="px-4 py-16 text-center text-[13px] text-red-600">
                  Unable to display loads. Please try again.
                </td>
              </tr>
            ) : loads.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-16 text-center">
                  <IconTruck className="mx-auto mb-3 h-8 w-8 text-slate-300" />
                  <div className="text-[14px] font-medium text-slate-600">No loads found</div>
                  <div className="mt-1 text-[13px] text-slate-400">
                    {returnTo !== "/"
                      ? "Try changing your filters or search."
                      : "Book a load or sync existing folders from storage."}
                  </div>
                </td>
              </tr>
            ) : (
              loads.map((l) => {
                const overdue = today ? overdueLabel(l, today) : "";
                const href = withBoardReturn(`/loads/${l.id}`, returnTo);
                return (
                <tr
                  key={l.id}
                  onClick={() => router.push(href)}
                  className="group cursor-pointer border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50/70"
                >
                  <td className="px-4 py-3">
                    <Link href={href} onClick={(e) => e.stopPropagation()} className="font-mono text-[13px] font-semibold text-slate-900 hover:text-blue-700 hover:underline">
                      {l.load_number}
                    </Link>
                    {l.load_type === "loadout" && (
                      <span className="ml-2 rounded bg-orange-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-700 ring-1 ring-inset ring-orange-200">
                        Loadout
                      </span>
                    )}
                    {l.archived_at && (
                      <span className="mt-1 block w-fit rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 ring-1 ring-inset ring-slate-200">Archived</span>
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
                  <td className="tnum px-4 py-3 text-slate-600">{l.invoice_due_date || <span className="text-slate-400">—</span>}</td>
                  <td className="tnum px-4 py-3 text-right font-semibold text-slate-900">
                    {l.rate_amount ? fmtMoney(l.rate_amount) : <span className="font-normal text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={l.status} />
                    {overdue && <span className="mt-1 block whitespace-nowrap text-[11px] font-semibold text-red-700">{overdue}</span>}
                  </td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    {l.archived_at ? (
                      <span className="whitespace-nowrap text-[11px] text-slate-400">Read only</span>
                    ) : (
                    <div className="relative transition-opacity focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
                      <select
                        value={l.status}
                        onChange={(e) => updateStatus(l, e.target.value as LoadStatus)}
                        disabled={pending !== null}
                        title="Update status"
                        aria-label={`Update status for ${loadTypeLabel(l.load_type)} #${l.load_number}`}
                        className="w-7 cursor-pointer appearance-none rounded-md border border-slate-300 bg-white py-1 pl-2 text-transparent shadow-sm hover:bg-slate-50 focus:outline-none disabled:cursor-wait disabled:opacity-50"
                      >
                        {STATUSES.map((s) => (
                          <option key={s.value} value={s.value} className="text-slate-900">
                            {s.label}
                          </option>
                        ))}
                      </select>
                      <IconChevronDown className="pointer-events-none absolute left-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                    </div>
                    )}
                  </td>
                </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

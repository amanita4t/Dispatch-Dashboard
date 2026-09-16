"use client";

import { Suspense, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { STATUSES, LOAD_TYPE_OPTIONS } from "@/lib/constants";
import { sanitizeBoardReturnUrl, withBoardReturn } from "@/lib/board-navigation";
import { requestJson } from "@/lib/client-api";
import { errorMessage } from "@/lib/errors";
import type { LoadRecord } from "@/lib/models";
import { useActionLock } from "@/lib/use-action-lock";
import { useDriverRoster } from "@/lib/use-driver-roster";
import { IconArrowLeft, IconFile, IconUpload } from "@/components/icons";

const inputCls =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-[13px] shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20";
const labelCls = "mb-1.5 block text-[12.5px] font-medium text-slate-700";

function FilePicker({
  name,
  label,
  required = false,
}: {
  name: string;
  label: string;
  required?: boolean;
}) {
  const [fileName, setFileName] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  return (
    <div>
      <label htmlFor={name} className={labelCls}>
        {label}{" "}
        {required ? (
          <span className="font-normal text-red-500">*</span>
        ) : (
          <span className="font-normal text-slate-400">· optional</span>
        )}
      </label>
      <label
        htmlFor={name}
        className={`flex cursor-pointer items-center gap-3 rounded-md border border-dashed px-3.5 py-3 transition-colors ${
          fileName
            ? "border-blue-300 bg-blue-50/50"
            : "border-slate-300 bg-slate-50/50 hover:border-slate-400 hover:bg-slate-50"
        }`}
      >
        <input
          ref={ref}
          id={name}
          type="file"
          name={name}
          required={required}
          className="sr-only"
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? "")}
        />
        {fileName ? (
          <>
            <IconFile className="h-4 w-4 shrink-0 text-blue-600" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-slate-800">{fileName}</span>
            <span className="text-[12px] font-medium text-blue-600">Change</span>
          </>
        ) : (
          <>
            <IconUpload className="h-4 w-4 shrink-0 text-slate-400" />
            <span className="flex-1 text-[13px] text-slate-500">
              Choose a file…
            </span>
            <span className="rounded border border-slate-300 bg-white px-2 py-1 text-[11.5px] font-medium text-slate-600 shadow-sm">
              Browse
            </span>
          </>
        )}
      </label>
    </div>
  );
}

export default function NewLoadPage() {
  return (
    <Suspense fallback={<div className="py-24 text-center text-[13px] text-slate-400">Loading booking form…</div>}>
      <NewLoadForm />
    </Suspense>
  );
}

function NewLoadForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = sanitizeBoardReturnUrl(searchParams.get("returnTo"));
  const { drivers, loading: driversLoading, error: driverError, refresh: refreshDrivers } = useDriverRoster();
  const [error, setError] = useState("");
  const { pending, begin, finish } = useActionLock();
  const submitting = pending !== null;
  const [pickupDate, setPickupDate] = useState("");
  const [created, setCreated] = useState<{ load: LoadRecord; uploadErrors: string[] } | null>(null);
  const hasCreatedLoad = useRef(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (hasCreatedLoad.current || driversLoading || driverError || drivers.length === 0 || !begin("booking")) return;
    setError("");
    try {
      const form = new FormData(e.currentTarget);
      const data = await requestJson<{ load: LoadRecord; uploadErrors?: string[] }>("/api/loads", { method: "POST", body: form });
      hasCreatedLoad.current = true;
      setCreated({ load: data.load, uploadErrors: data.uploadErrors || [] });
      if (!data.uploadErrors?.length) router.push(withBoardReturn(`/loads/${data.load.id}`, returnTo));
    } catch (failure: unknown) {
      setError(errorMessage(failure));
    } finally {
      finish();
    }
  }

  return (
    <div className="mx-auto max-w-[720px]">
      <Link
        href={returnTo}
        className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-slate-500 transition-colors hover:text-slate-800"
      >
        <IconArrowLeft className="h-3.5 w-3.5" />
        Load Board
      </Link>

      <div className="mb-6">
        <h1 className="text-[22px] font-semibold tracking-tight text-slate-900">Book a Load</h1>
        <p className="mt-0.5 text-[13px] text-slate-500">
          A folder is created automatically in the driver&apos;s Loads or Loadout directory.
        </p>
      </div>

      {driversLoading && (
        <p role="status" className="mb-5 rounded-md border border-slate-200 bg-white px-4 py-3 text-[13px] text-slate-500">Loading driver roster…</p>
      )}
      {driverError && (
        <div role="alert" className="mb-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800">
          Unable to load the driver roster: {driverError}{" "}
          <button onClick={() => void refreshDrivers()} disabled={submitting} className="font-semibold underline disabled:opacity-50">Retry drivers</button>
        </div>
      )}
      {!driversLoading && !driverError && drivers.length === 0 && (
        <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
          No drivers in the system yet.{" "}
          <Link href="/drivers" className="font-semibold underline underline-offset-2">
            Add a driver first
          </Link>{" "}
          — load folders are filed under the driver&apos;s folder.
        </div>
      )}

      {error && (
        <div role="alert" className="mb-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800">
          {error}
        </div>
      )}

      {created && (
        <div role="status" className={`mb-5 rounded-md border px-4 py-3 text-[13px] ${created.uploadErrors.length ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>
          <p className="font-semibold">{created.load.load_type === "loadout" ? "Loadout" : "Load"} #{created.load.load_number} was created. Do not book it again.</p>
          {created.uploadErrors.length > 0 && (
            <>
              <p className="mt-1">The required rate confirmation is saved, but these optional uploads failed:</p>
              <ul className="mt-1 list-inside list-disc">{created.uploadErrors.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
              <p className="mt-2">Open the load to review its documents and upload only the failed files.</p>
            </>
          )}
          <Link href={withBoardReturn(`/loads/${created.load.id}`, returnTo)} className="mt-2 inline-block font-semibold underline underline-offset-2">Open load and documents</Link>
        </div>
      )}

      <form onSubmit={onSubmit}>
        <fieldset disabled={submitting || created !== null} className="min-w-0">
        {/* Section: booking */}
        <div className="overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm">
          <div className="border-b border-slate-200/80 bg-slate-50/60 px-5 py-3">
            <h2 className="text-[13px] font-semibold text-slate-800">Booking Details</h2>
          </div>
          <div className="grid grid-cols-1 gap-x-5 gap-y-4 p-5 sm:grid-cols-2">
            <div>
              <label htmlFor="load-type" className={labelCls}>
                Load Type <span className="font-normal text-red-500">*</span>
              </label>
              <select id="load-type" name="load_type" required defaultValue="load" className={inputCls}>
                {LOAD_TYPE_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="load-number" className={labelCls}>
                Load Number <span className="font-normal text-red-500">*</span>
              </label>
              <input id="load-number" name="load_number" required placeholder="45812" className={`${inputCls} font-mono`} />
            </div>
            <div>
              <label htmlFor="load-driver" className={labelCls}>
                Driver <span className="font-normal text-red-500">*</span>
              </label>
              <select id="load-driver" name="driver_id" required disabled={driversLoading || Boolean(driverError)} className={inputCls} defaultValue="">
                <option value="" disabled>
                  {driversLoading ? "Loading drivers…" : driverError ? "Driver roster unavailable" : "Assign a driver…"}
                </option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="load-rate" className={labelCls}>
                Rate (USD) <span className="font-normal text-red-500">*</span>
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-slate-400">
                  $
                </span>
                <input
                  id="load-rate"
                  name="rate_amount"
                  required
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="2,500.00"
                  className={`${inputCls} tnum pl-7`}
                />
              </div>
            </div>
            <div>
              <label htmlFor="load-pickup-city" className={labelCls}>
                Pickup City <span className="font-normal text-red-500">*</span>
              </label>
              <input id="load-pickup-city" name="pickup_city" required placeholder="Dallas, TX" className={inputCls} />
            </div>
            <div>
              <label htmlFor="load-delivery-city" className={labelCls}>
                Delivery City <span className="font-normal text-red-500">*</span>
              </label>
              <input id="load-delivery-city" name="delivery_city" required placeholder="Atlanta, GA" className={inputCls} />
            </div>
            <div>
              <label htmlFor="load-pickup-date" className={labelCls}>
                Pickup Date <span className="font-normal text-red-500">*</span>
              </label>
              <input id="load-pickup-date" name="pickup_date" required type="date" value={pickupDate} onChange={(e) => setPickupDate(e.target.value)} className={`${inputCls} tnum`} />
            </div>
            <div>
              <label htmlFor="load-delivery-date" className={labelCls}>
                Delivery Date <span className="font-normal text-red-500">*</span>
              </label>
              <input id="load-delivery-date" name="delivery_date" required type="date" min={pickupDate || undefined} className={`${inputCls} tnum`} />
            </div>
            <div>
              <label htmlFor="load-status" className={labelCls}>Initial Status</label>
              <select id="load-status" name="status" required defaultValue="scheduled" className={inputCls}>
                {STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="load-invoice-due-date" className={labelCls}>Invoice Due Date <span className="font-normal text-slate-400">· optional</span></label>
              <input id="load-invoice-due-date" name="invoice_due_date" type="date" className={`${inputCls} tnum`} />
              <p className="mt-1 text-[11.5px] text-slate-500">Use the agreed payment date. Leave blank if it is not yet known.</p>
            </div>
          </div>
        </div>

        {/* Section: documents */}
        <div className="mt-5 overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm">
          <div className="border-b border-slate-200/80 bg-slate-50/60 px-5 py-3">
            <h2 className="text-[13px] font-semibold text-slate-800">Paperwork</h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              Rate confirmation is required to book. More documents can be added later.
            </p>
          </div>
          <div className="space-y-4 p-5">
            <FilePicker name="rate_confirmation" label="Rate Confirmation" required />
            <FilePicker name="bol" label="BOL" />
            <FilePicker name="other_1" label="Other Document" />
            <FilePicker name="other_2" label="Other Document 2" />
          </div>
        </div>
        </fieldset>

        <div className="mt-5 flex items-center justify-end gap-3">
          <Link
            href={returnTo}
            className="rounded-md px-4 py-2 text-[13px] font-medium text-slate-600 transition-colors hover:bg-slate-200/70"
          >
            {created ? "Back to Load Board" : "Cancel"}
          </Link>
          <button
            type="submit"
            disabled={submitting || created !== null || driversLoading || Boolean(driverError) || drivers.length === 0}
            className="rounded-md bg-blue-600 px-5 py-2 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "Creating load & folder…" : created ? "Load Created" : "Book Load"}
          </button>
        </div>
      </form>
    </div>
  );
}

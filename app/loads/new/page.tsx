"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { STATUSES, LOAD_TYPE_OPTIONS } from "@/lib/constants";
import { IconArrowLeft, IconFile, IconUpload } from "@/components/icons";

interface Driver {
  id: number;
  name: string;
}

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
      <label className={labelCls}>
        {label}{" "}
        {required ? (
          <span className="font-normal text-red-500">*</span>
        ) : (
          <span className="font-normal text-slate-400">· optional</span>
        )}
      </label>
      <label
        className={`flex cursor-pointer items-center gap-3 rounded-md border border-dashed px-3.5 py-3 transition-colors ${
          fileName
            ? "border-blue-300 bg-blue-50/50"
            : "border-slate-300 bg-slate-50/50 hover:border-slate-400 hover:bg-slate-50"
        }`}
      >
        <input
          ref={ref}
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
              Choose a file<span className="hidden sm:inline"> or drop it here</span>…
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
  const router = useRouter();
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/drivers")
      .then((r) => r.json())
      .then(setDrivers);
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/loads", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create load");
        setSubmitting(false);
        return;
      }
      if (data.uploadErrors?.length) {
        alert("Load created, but some files failed to upload:\n" + data.uploadErrors.join("\n"));
      }
      router.push(`/loads/${data.load.id}`);
    } catch (err: any) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-[720px]">
      <Link
        href="/"
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

      {drivers.length === 0 && (
        <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
          No drivers in the system yet.{" "}
          <Link href="/drivers" className="font-semibold underline underline-offset-2">
            Add a driver first
          </Link>{" "}
          — load folders are filed under the driver&apos;s folder.
        </div>
      )}

      {error && (
        <div className="mb-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800">
          {error}
        </div>
      )}

      <form onSubmit={onSubmit}>
        {/* Section: booking */}
        <div className="overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm">
          <div className="border-b border-slate-200/80 bg-slate-50/60 px-5 py-3">
            <h2 className="text-[13px] font-semibold text-slate-800">Booking Details</h2>
          </div>
          <div className="grid grid-cols-1 gap-x-5 gap-y-4 p-5 sm:grid-cols-2">
            <div>
              <label className={labelCls}>
                Load Type <span className="font-normal text-red-500">*</span>
              </label>
              <select name="load_type" required defaultValue="load" className={inputCls}>
                {LOAD_TYPE_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>
                Load Number <span className="font-normal text-red-500">*</span>
              </label>
              <input name="load_number" required placeholder="45812" className={`${inputCls} font-mono`} />
            </div>
            <div>
              <label className={labelCls}>
                Driver <span className="font-normal text-red-500">*</span>
              </label>
              <select name="driver_id" required className={inputCls} defaultValue="">
                <option value="" disabled>
                  Assign a driver…
                </option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>
                Rate (USD) <span className="font-normal text-red-500">*</span>
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-slate-400">
                  $
                </span>
                <input
                  name="rate_amount"
                  required
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="2,500.00"
                  className={`${inputCls} tnum pl-7`}
                />
              </div>
            </div>
            <div>
              <label className={labelCls}>
                Pickup City <span className="font-normal text-red-500">*</span>
              </label>
              <input name="pickup_city" required placeholder="Dallas, TX" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>
                Delivery City <span className="font-normal text-red-500">*</span>
              </label>
              <input name="delivery_city" required placeholder="Atlanta, GA" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>
                Pickup Date <span className="font-normal text-red-500">*</span>
              </label>
              <input name="pickup_date" required type="date" className={`${inputCls} tnum`} />
            </div>
            <div>
              <label className={labelCls}>
                Delivery Date <span className="font-normal text-red-500">*</span>
              </label>
              <input name="delivery_date" required type="date" className={`${inputCls} tnum`} />
            </div>
            <div className="sm:col-span-2">
              <label className={labelCls}>Initial Status</label>
              <select name="status" required defaultValue="scheduled" className={inputCls}>
                {STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
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

        <div className="mt-5 flex items-center justify-end gap-3">
          <Link
            href="/"
            className="rounded-md px-4 py-2 text-[13px] font-medium text-slate-600 transition-colors hover:bg-slate-200/70"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={submitting || drivers.length === 0}
            className="rounded-md bg-blue-600 px-5 py-2 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "Creating load & folder…" : "Book Load"}
          </button>
        </div>
      </form>
    </div>
  );
}

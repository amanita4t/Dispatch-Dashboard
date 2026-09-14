export const STATUSES = [
  { value: "scheduled", label: "Scheduled", color: "bg-slate-100 text-slate-700 ring-slate-200", dot: "bg-slate-400" },
  { value: "picked_up", label: "Picked Up", color: "bg-amber-50 text-amber-800 ring-amber-200", dot: "bg-amber-500" },
  { value: "unloaded", label: "Unloaded", color: "bg-blue-50 text-blue-800 ring-blue-200", dot: "bg-blue-500" },
  { value: "invoiced", label: "Invoiced", color: "bg-violet-50 text-violet-800 ring-violet-200", dot: "bg-violet-500" },
  { value: "paid", label: "Paid", color: "bg-emerald-50 text-emerald-800 ring-emerald-200", dot: "bg-emerald-500" },
] as const;

export const CATEGORIES = [
  { value: "rate_confirmation", label: "Rate Confirmation" },
  { value: "updated_rate_confirmation", label: "Updated Rate Confirmation" },
  { value: "bol", label: "BOL" },
  { value: "lumper_receipt", label: "Lumper Receipt" },
  { value: "invoice", label: "Invoice" },
  { value: "other", label: "Other" },
] as const;

export const LOAD_TYPE_OPTIONS = [
  { value: "load", label: "Load" },
  { value: "loadout", label: "Loadout Trailer" },
] as const;

export function loadTypeLabel(value: string) {
  return value === "loadout" ? "Loadout" : "Load";
}

export function statusInfo(value: string) {
  return STATUSES.find((s) => s.value === value) ?? STATUSES[0];
}

export function categoryLabel(value: string) {
  return CATEGORIES.find((c) => c.value === value)?.label ?? "Other";
}

export function fmtMoney(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
}

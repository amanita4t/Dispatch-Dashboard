import { RequestError } from "./api";
import { LOAD_STATUSES, LOAD_TYPES, FILE_CATEGORIES } from "./models";
import type { LoadRecord } from "./models";

export function text(value: unknown, label: string, required = false): string {
  if (typeof value !== "string") throw new RequestError(`${label} must be text`);
  const result = value.trim();
  if (required && !result) throw new RequestError(`${label} is required`);
  return result;
}

export function positiveId(value: unknown, label = "ID"): number {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new RequestError(`Invalid ${label}`);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) throw new RequestError(`Invalid ${label}`);
  return id;
}

export function dateValue(value: unknown, label: string, required = false): string {
  const result = text(value, label, required);
  if (!result && !required) return "";
  const timestamp = Date.parse(`${result}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== result) {
    throw new RequestError(`${label} must be a valid date (YYYY-MM-DD)`);
  }
  return result;
}

export function rateValue(value: unknown, positive = false): number {
  if ((typeof value !== "string" && typeof value !== "number") || (typeof value === "string" && !value.trim())) {
    throw new RequestError("Rate must be a number");
  }
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || (positive && result === 0)) {
    throw new RequestError(positive ? "Rate must be greater than zero" : "Rate cannot be negative");
  }
  if (!Number.isSafeInteger(Math.round(result * 100)) ||
      Math.abs(result * 100 - Math.round(result * 100)) > 0.000001) {
    throw new RequestError("Rate must be a valid amount with at most two decimal places");
  }
  return result;
}

export function enumValue<T extends string>(value: unknown, options: readonly T[], label: string): T {
  const found = options.find((option) => option === value);
  if (!found) throw new RequestError(`Invalid ${label}`);
  return found;
}

export function validateDateOrder(pickup: string, delivery: string) {
  if (pickup && delivery && pickup > delivery) {
    throw new RequestError("Delivery date cannot be before pickup date");
  }
}

export function uploadFile(value: FormDataEntryValue | null, label: string): File {
  if (!(value instanceof File) || value.size === 0) {
    throw new RequestError(`${label} file is required`);
  }
  return value;
}

export function bookingFields(form: FormData) {
  const result = {
    load_number: text(form.get("load_number"), "Load number", true),
    load_type: enumValue(form.get("load_type") || "load", LOAD_TYPES, "load type"),
    driver_id: positiveId(form.get("driver_id"), "driver ID"),
    pickup_city: text(form.get("pickup_city"), "Pickup city", true),
    delivery_city: text(form.get("delivery_city"), "Delivery city", true),
    pickup_date: dateValue(form.get("pickup_date"), "Pickup date", true),
    delivery_date: dateValue(form.get("delivery_date"), "Delivery date", true),
    rate_amount: rateValue(form.get("rate_amount"), true),
    status: enumValue(form.get("status") || "scheduled", LOAD_STATUSES, "status"),
    invoice_due_date: dateValue(form.get("invoice_due_date") ?? "", "Invoice due date"),
  };
  validateDateOrder(result.pickup_date, result.delivery_date);
  return result;
}

export function loadChanges(body: Record<string, unknown>, current: LoadRecord) {
  const allowed = ["driver_id", "pickup_city", "delivery_city", "pickup_date", "delivery_date", "rate_amount", "status", "notes", "invoice_due_date"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new RequestError("Unsupported load field");
  }
  const next = {
    driver_id: body.driver_id === undefined ? current.driver_id : positiveId(body.driver_id, "driver ID"),
    pickup_city: body.pickup_city === undefined ? current.pickup_city : text(body.pickup_city, "Pickup city"),
    delivery_city: body.delivery_city === undefined ? current.delivery_city : text(body.delivery_city, "Delivery city"),
    pickup_date: body.pickup_date === undefined ? current.pickup_date : dateValue(body.pickup_date, "Pickup date"),
    delivery_date: body.delivery_date === undefined ? current.delivery_date : dateValue(body.delivery_date, "Delivery date"),
    rate_amount: body.rate_amount === undefined ? current.rate_amount : rateValue(body.rate_amount),
    status: body.status === undefined ? current.status : enumValue(body.status, LOAD_STATUSES, "status"),
    notes: body.notes === undefined ? current.notes : text(body.notes, "Notes"),
    invoice_due_date: body.invoice_due_date === undefined ? current.invoice_due_date : dateValue(body.invoice_due_date, "Invoice due date"),
  };
  validateDateOrder(next.pickup_date, next.delivery_date);
  return next;
}

export function fileCategory(value: unknown) {
  return enumValue(value, FILE_CATEGORIES, "document category");
}

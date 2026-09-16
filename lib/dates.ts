import type { LoadWithDriver } from "./models";

export function todayLocal(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function overdueLabel(load: Pick<LoadWithDriver, "archived_at" | "status" | "delivery_date" | "invoice_due_date">, today: string): string {
  if (load.archived_at) return "";
  if (load.status === "invoiced" && load.invoice_due_date && load.invoice_due_date < today) {
    return "Payment overdue";
  }
  if ((load.status === "scheduled" || load.status === "picked_up") && load.delivery_date && load.delivery_date < today) {
    return "Delivery overdue";
  }
  return "";
}

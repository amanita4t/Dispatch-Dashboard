import { statusInfo } from "@/lib/constants";

export default function StatusBadge({ status }: { status: string }) {
  const info = statusInfo(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-semibold ring-1 ring-inset ${info.color}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${info.dot}`} />
      {info.label}
    </span>
  );
}

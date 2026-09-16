"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconTruck, IconPlus, IconUsers } from "./icons";

const nav = [
  { href: "/", label: "Load Board", icon: IconTruck },
  { href: "/loads/new", label: "Book Load", icon: IconPlus },
  { href: "/drivers", label: "Drivers", icon: IconUsers },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [storageMode, setStorageMode] = useState<string>("");

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((d) => setStorageMode(d.storage))
      .catch(() => {});
  }, []);

  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-[232px] flex-col border-r border-[#1d2939] bg-[#101828]">
      <div className="flex h-16 items-center gap-3 border-b border-[#1d2939] px-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-blue-600 text-white">
          <IconTruck className="h-5 w-5" />
        </div>
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight text-white">DispatchBoard</div>
          <div className="text-[11px] font-medium text-slate-500">Load Management</div>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 px-3 py-4">
        <div className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Operations
        </div>
        {nav.map((item) => {
          const active = pathname === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`group flex items-center gap-3 rounded-md px-3 py-2 text-[13px] font-medium transition-colors ${
                active
                  ? "bg-white/[0.06] text-white"
                  : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
              }`}
            >
              <span
                className={`-ml-3 h-5 w-0.5 rounded-full transition-colors ${
                  active ? "bg-blue-500" : "bg-transparent"
                }`}
              />
              <Icon className={`h-4 w-4 ${active ? "text-blue-400" : "text-slate-500 group-hover:text-slate-400"}`} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-[#1d2939] px-5 py-4">
        {storageMode === "drive" ? (
          <div className="flex items-center gap-2 text-[11px] font-medium text-emerald-400">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            Google Drive mode
          </div>
        ) : storageMode === "local" ? (
          <div
            className="flex items-center gap-2 text-[11px] font-medium text-slate-500"
            title="Files are stored locally. Set STORAGE_MODE=drive with Google credentials to enable Drive."
          >
            <span className="inline-flex h-2 w-2 rounded-full bg-slate-600" />
            Local storage mode
          </div>
        ) : null}
      </div>
    </aside>
  );
}

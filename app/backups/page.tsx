import { IconFolder } from "@/components/icons";
import { BACKUP_GUIDANCE } from "@/lib/backup";

export default function BackupsPage() {
  return (
    <div className="mx-auto max-w-[860px]">
      <div className="mb-6">
        <h1 className="text-[20px] font-semibold tracking-tight text-slate-900">Backups &amp; recovery</h1>
        <p className="mt-0.5 text-[12.5px] text-slate-500">
          PostgreSQL stores dashboard records. Google Drive stores paperwork. Protect and recover both separately.
        </p>
      </div>

      <section className="mb-5 rounded-lg border border-slate-200/80 bg-white p-5 shadow-sm">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-slate-800">
          <IconFolder className="h-4 w-4 text-blue-600" /> PostgreSQL records
        </h2>
        <p className="mt-3 text-[13px] leading-relaxed text-slate-600">{BACKUP_GUIDANCE.database}</p>
        <ul className="mt-3 list-inside list-disc space-y-2 text-[13px] leading-relaxed text-slate-600">
          <li>Provider retention and point-in-time restore availability depend on your plan; this page does not verify or enable backups.</li>
          <li>Before recovery, pause application writes and record the database, environment, and Google Drive root being recovered.</li>
          <li>Restore into a separate Neon branch or PostgreSQL database first. Check drivers, active and archived loads, statuses, notes, and document references.</li>
          <li>Validate a restored branch against the matching Drive root with <code>GOOGLE_DRIVE_READ_ONLY=true</code>. A database branch does not copy or isolate Drive documents.</li>
          <li>Restrict access and switch every deployment that writes to that root to the same recovered database. Independent PostgreSQL databases must not write to the same Drive folders.</li>
        </ul>
      </section>

      <section className="mb-5 rounded-lg border border-slate-200/80 bg-white p-5 shadow-sm">
        <h2 className="text-[14px] font-semibold text-slate-800">Documents and credentials</h2>
        <p className="mt-3 text-[13px] leading-relaxed text-slate-600">{BACKUP_GUIDANCE.documents}</p>
        <p className="mt-2 text-[13px] leading-relaxed text-slate-600">
          Preserve folder IDs and the existing driver/load layout. Sync storage registers available documents; it does not recreate deleted files.
          Development-only local documents also need their own protected copy.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-slate-600">
          Keep OAuth tokens, database passwords, and environment files in private secret storage, not in source control or shared backup links.
        </p>
      </section>

      <section className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-[13px] leading-relaxed text-amber-900">
        <h2 className="text-[14px] font-semibold">Recovery is managed outside the dashboard</h2>
        <p className="mt-2">{BACKUP_GUIDANCE.application}</p>
        <p className="mt-2">
          Database records and documents are not read, changed, or deleted by this page. The retired backup API URLs
          return an explicit unsupported-operation error in every storage mode.
        </p>
      </section>
    </div>
  );
}

# DispatchBoard 🚛

A dispatching dashboard for organizing load paperwork and status. Dispatchers can:

- **Add loads** with load number, pickup/delivery cities & dates, rate, driver, and status
- **Require a rate confirmation** upload at load creation (BOL / other docs optional)
- **Track status**: Scheduled → Picked Up → Unloaded → Invoiced → Paid
- **Filter the load board** by driver and load type (Load or Loadout), together with status and search
- **Manage drivers** — each driver gets a folder in storage
- **Auto-create a folder per load**: `Driver Name\Loads\Load #<load number>\` or `Driver Name\Loadout\Loadout #<load number>\`
- **Manage documents** per load from the dashboard: upload BOL, updated rate cons, lumper receipts, invoices, etc.; download & delete

## Running it

Use **Node 24.20.0** (pinned in `.nvmrc` and `.node-version`). Other Node majors
are rejected by the project npm configuration because `better-sqlite3` includes a native addon.
After changing Node versions, run `npm rebuild better-sqlite3` if the addon reports
a Node module-version mismatch.

```bash
npm ci
npm run dev
```

Open http://localhost:3000

Local storage is the default. For explicit local testing, set this in `.env.local`
(or copy `.env.example` if `.env.local` does not exist):

```env
STORAGE_MODE=local
```

Restart the server after changing storage mode. Existing Google credentials can
remain in `.env.local`; local mode does not use them.

Real environment files, databases, uploaded documents, and local backups are
excluded from Git. Pushing the project to GitHub does not back up your dispatch
data or paperwork; keep a separate local-data backup. Store downloaded Google
credential key files outside the checkout.

## Storage modes

| Mode | Selection | Database | Where files go |
|------|-----------|----------|----------------|
| **Local** (default) | `STORAGE_MODE=local`, or unset | `data\dispatch-local.db` | `storage\<Driver Name>\Loads\Load #<num>\` |
| **Google Drive** | `STORAGE_MODE=drive` and Google credentials | `data\dispatch.db` | Your Drive folder: `<Root>\<Driver Name>\Loads\Load #<num>\` |

Loadout trailers use `Loadout\Loadout #<num>\` instead of `Loads\Load #<num>\`.
The sidebar shows which storage mode is selected; it is not a live Drive health indicator.

Local testing starts with a separate, empty database. The existing
`data\dispatch.db` is left intact and is reopened only in Drive mode. Switching
modes does not copy, migrate, or delete either dataset or its documents. Older
local records stored in `dispatch.db` are also preserved, but are not imported
into the new local-test database automatically.

Add a driver, book a load with a rate confirmation, and use the load's detail
page to manage its documents and status. **Sync Storage** can import folders
and register new drivers found in storage, but does not extract trip details from documents.

After adding folders manually, click **Sync Storage**. Both layouts are supported
for local storage and Google Drive:

```text
Driver Name\Loads\Load #123\rate-confirmation.pdf
Driver Name\Load #123\rate-confirmation.pdf
Driver Name\Loadout\Loadout #456\rate-confirmation.pdf
Driver Name\Loadout #456\rate-confirmation.pdf
```

Sync keeps existing folders and documents in place and reports newly imported
drivers, loads, and files. A load number must be supplied by the load folder name;
placing a PDF directly in a driver's root folder does not identify a load.
New driver records have blank phone/truck details, and imported loads have blank
trip details and a zero rate until edited. Repeated syncs do not duplicate records.
Duplicate driver names or duplicate load folders across layouts are reported as
conflicts rather than merged.

Sync also moves active loads to **Archived** when their linked load folders are
confirmed missing. The sync summary reports how many were archived. Load details,
status, notes, and document records are kept; deleted folders/documents are not
recreated, and other folders are not moved or deleted.

Deletion reconciliation is skipped after failed scans or ambiguous folder matches.
An unavailable storage root or whole driver folder is reported instead of being
treated as proof that its loads were deleted. Drive folders are auto-archived only
when Drive confirms they are in Trash; a not-found/access error alone is ambiguous
and leaves the record unchanged.

## Archiving, restoring, and reassignment

Archiving replaces permanent load deletion. The load, status, notes, and existing
documents are retained, but the load leaves the active board. Archiving from the
dashboard renames an existing storage folder:

```text
Driver Name\Loads\Archived - Load #123\
Driver Name\Loadout\Archived - Loadout #123\
```

Individual document filenames do not change. Select the **Archived** view, open a
load, and choose **Restore** to return it to the active board and remove the folder
prefix. Archived loads are read-only, including document uploads/deletions, until
restored. Documents still present in storage remain available to open/download.
Manually imported load folders directly under a driver retain that layout when
archived and restored.

If a folder was deleted outside the dashboard, its original reference is retained
without trying to rename a nonexistent folder. Recover the original folder and its
paperwork at that location before choosing **Restore**. Sync never automatically
reactivates an archived load when a folder reappears.

**Edit Details** can reassign an active load to a different driver. The entire load
folder moves, and local document references update with it. Renaming a driver also
updates that driver's active and archived folder references. Existing destination
folders are never merged or overwritten. If a database save fails after a folder
move, the application attempts to move it back and reports any recovery failure.

Storage sync ignores archived folder names and archived records. Conflicting load
numbers under another driver's folder produce an error instead of mixing paperwork.

## Filters, dates, and saving

Driver, load type, status, search, archived view, date range, and sorting are carried
in the board URL so returning from a load retains the selected view. Date ranges
are inclusive and can use pickup, delivery, or invoice due dates. KPI cards are
**filtered totals**, not company-wide totals.

Delivery is overdue only when its delivery date is before today and the load is
still Scheduled or Picked Up. Payment is overdue only when an Invoiced load's
explicit **Invoice Due Date** is before today. Today uses the dispatcher's browser
local date. There is no automatic 30-day payment assumption; set the due date when
booking or editing the load. Paid and archived loads are not flagged overdue.

Booking is only committed after the required rate confirmation is saved. Optional
document failures are reported separately. Rates and calendar dates are validated
on the server, and edits either save together or leave all previous values intact.
Imported loads can retain incomplete trip details until a dispatcher fills them in.
Status transitions remain manual; Invoiced/Paid do not generate invoices or process payments.

Run one application server per dataset. Data operations use a shared lock to avoid
folder moves, imports, and restores colliding. If a process is forcibly terminated
while an operation is in progress, stop all application servers before removing
the corresponding `data\dispatch-local.db.lock` (or `data\dispatch.db.lock`) file.
Inspect any interrupted operation before retrying.

## Local backups and restore

Open **Backups** in the sidebar and select **Create Backup** to save a dated
snapshot under `backups\local\`. Each snapshot includes a standalone SQLite
database, all local storage files (including archived and untracked paperwork),
and a versioned inventory with integrity hashes. Credentials and the separate
Google Drive database are never included. Copy the entire dated backup directory
to another disk; keeping backups only on this disk does not protect against disk failure.

To restore, select a backup and type **RESTORE LOCAL DATA**. Restore replaces the
current local database records and documents, after creating a fresh pre-restore
safety backup. Document references are adjusted to the current checkout, so a
complete backup directory can also be copied into another checkout's `backups\local\`
directory and restored there.

Linked/reparse-point files, damaged or incompatible snapshots, and missing tracked
documents are refused rather than silently omitted. Stop external document edits
during backup/restore. If the current dataset is incomplete, restore stops until
a complete safety backup can be made. The feature is disabled in Drive mode.
Archiving a missing-folder load does not waive this safeguard: recover its tracked
paperwork before creating or restoring a complete backup.

If a restore is interrupted, the app blocks access while
`data\dispatch-local.db.restore-recovery.json` exists. Stop the servers and preserve
that marker, its named recovery directory, and the safety backup. Do not simply
delete the marker: the database and document tree must first be recovered as a pair.

## Development commands

```text
npm run lint
npm test
npm run build
```

Regression scenarios use Node's built-in runner, isolated SQLite/document fixtures,
and mocked Drive calls. They do not modify the live dataset or contact Google Drive.

## Enabling Google Drive (~10 minutes)

1. Go to [Google Cloud Console](https://console.cloud.google.com) → create a project (or use an existing one).
2. **APIs & Services → Library** → search "Google Drive API" → **Enable**.
3. **APIs & Services → Credentials → Create Credentials → Service Account.**
   - Give it a name like `dispatch-dashboard`. No roles needed.
4. Open the service account → **Keys → Add Key → Create new key → JSON**. A key file downloads.
5. In Google Drive, create (or pick) the root folder that holds all driver folders.
   - **Share** that folder with the service account's email (looks like `dispatch-dashboard@<project>.iam.gserviceaccount.com`) and give it **Editor** access.
6. Copy the folder ID from the URL: `https://drive.google.com/drive/folders/`**`<FOLDER_ID>`**
7. Create `.env.local` in the project root (see `.env.example`):

```env
STORAGE_MODE=drive
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=C:\path\to\service-account-key.json
GOOGLE_DRIVE_ROOT_FOLDER_ID=your_folder_id_here
```

8. Restart the dev server. The sidebar should now read **Google Drive mode**, and new loads will create `Driver Name\Loads\Load #123` folders in Drive automatically.

OAuth is also supported using `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN` together with the
root folder ID. The one-time helper is `scripts\get-refresh-token.js`.

> **Note:** keep the SQLite database backed up separately. Drive stores documents, not the application's trip details, statuses, or notes.

## Tech

- Next.js 14 (App Router) + TypeScript + Tailwind CSS
- SQLite (`better-sqlite3`) — separate local-test and Drive databases under `data\`
- Optional Google Drive API via OAuth or service account (`googleapis`)

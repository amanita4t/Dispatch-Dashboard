# DispatchBoard 🚛

A dispatching dashboard for organizing load paperwork and status. Dispatchers can:

- **Add loads** with load number, pickup/delivery cities & dates, rate, driver, and status
- **Require a rate confirmation** upload at load creation (BOL / other docs optional)
- **Track status**: Scheduled → Picked Up → Unloaded → Invoiced → Paid
- **Filter the load board** by driver and load type (Load or Loadout), together with status and search
- **Manage drivers** — each driver gets a folder in storage
- **Auto-create a folder per load** following the driver's existing layout: directly under the driver, or inside their `Loads` / `Loadout` folder
- **Manage documents** per load from the dashboard: upload BOL, updated rate cons, lumper receipts, invoices, etc.; download & delete

## Running it

Use **Node 24.x** (see `.nvmrc` and `.node-version`) and a PostgreSQL database.
PostgreSQL is the only application database, including local development.
A new database starts empty; there is no file-based database or legacy import step.

```powershell
npm ci
```

Copy `.env.example` to `.env.local` only if `.env.local` does not already exist.
Configure a dedicated development database before starting the application:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require
STORAGE_MODE=local
```

Use the pooled Neon connection for `DATABASE_URL`. Optionally set
`DATABASE_URL_UNPOOLED` to the direct connection for schema changes.
The Vercel integration aliases `POSTGRES_URL` and `POSTGRES_URL_NON_POOLING` are
also supported. Keep each pooled/direct pair on the same database and branch.
The runtime prefers `DATABASE_URL` over `POSTGRES_URL`. Local PostgreSQL connection
settings may differ from the hosted example.
The operator CLI loads the project's private environment through Next's environment
loader and selects its connection in this order: `DATABASE_URL_UNPOOLED`,
`POSTGRES_URL_NON_POOLING`, `DATABASE_URL`, then `POSTGRES_URL`.

```powershell
npm run db:migrate
npm run dev
```

Open http://localhost:3000. Schema migration is explicit: `npm run build` does
not apply database migrations. Restart after changing database or storage settings.
`npm run db:migrate` applies the schema and binds that database to the exact
configured storage mode and root. Builds, application startup, and request handlers
never run migrations automatically.

Local document storage is the default for development and does not use Google
credentials. It is rejected on Vercel because function filesystems are not durable.
Hosted deployments must use Google Drive for documents.

Real environment files, uploaded documents, and backups are
excluded from Git. Pushing the project does not back up PostgreSQL records or
paperwork. Keep database backups and document recovery independent, and store
credential files outside the checkout.

## Private Vercel testing with Neon

**No application authentication has been added. Do not expose this dashboard
publicly.** Configure Vercel Deployment Protection **before any deployment**.
Verify that unauthenticated access is denied on **both production and preview
URLs**, including their aliases/custom domains. Vercel's **Standard Protection**
excludes production domains: choose the **All Deployments** protection scope,
with a protection method and plan that support it. Enabling a setting alone is
not proof that either URL is private; verify actual unauthenticated requests.
If both cannot be protected, leave the project undeployed.

1. Select **Node 24.x** in Vercel. Database and Drive handlers use the Node
   runtime, not Edge. Writes and sync batches allow up to 300 seconds; sync
   remains bounded and resumable rather than depending on background execution.
2. Connect Neon through Vercel and create a dedicated private-test database,
   separate from live production. A Neon branch isolates PostgreSQL records,
   **not Google Drive**. All deployments that mutate the same test Drive root must
   share the **same test database** so their PostgreSQL locks coordinate writes.
   An independent preview database using that root must set
   `GOOGLE_DRIVE_READ_ONLY=true`; for independent writable previews, provision a
   separate test Drive root and its own empty, correctly bound database instead.
   Never point a private trial at live production data.
3. Set the pooled `DATABASE_URL` (or `POSTGRES_URL`) and, for operator-run schema
   commands, the matching optional direct connection. The application
   uses a finite connection pool per instance; use Neon pooling for serverless
   instances instead of opening an unbounded number of database connections.
   The pool has a fixed maximum of five connections per instance, with five-second
   idle and connection timeouts.
4. Set `STORAGE_MODE=drive`, the **test** `GOOGLE_DRIVE_ROOT_FOLDER_ID`, and private
   OAuth credentials in the appropriate Vercel environment scopes. Preserve the
   existing account/token and root layout when moving the same dataset; changing
   the database does not require reauthorizing Google. Never use `NEXT_PUBLIC_`
   for database URLs, OAuth credentials, tokens, or service-account keys.
5. Keep access to real dispatch data blocked until access protection is configured
   and both URL types are verified private. If protection needs a deployment to
   verify, use an empty, non-sensitive test database with no Drive credentials,
   only after protection has been configured. Do not connect production paperwork
   or expose live records to an unverified URL.
6. Run `npm run db:migrate` from a trusted operator
   environment against that same private-test database. Confirm the root binding
   before testing sync or document changes. Use only the approved test Drive root;
   production roots must remain untouched during private testing.
7. Use `npm run build` as Vercel's build command, not a direct `next build`
   override. The build also checks deployment traces for private/local-only files.

The schema command creates empty application tables without dummy records.
No deployment command or build step applies it automatically, and a successful
build does not prove that a database is ready or a URL is protected.

Private documents, snapshots, test fixtures, and operator scripts
are not deployment inputs. The deployment exclusions keep `data\`, `storage\`,
`backups\`, `tests\`, and operator scripts out of Vercel uploads and function
traces. Only `scripts\check-build-traces.cjs` is uploaded for the build step; it
also removes private references missed by Next 14's Windows glob matching.
Keep Next's exclusions scoped to API routes: a global `*` key also filters shared
dependencies and can accidentally remove packages such as `gcp-metadata`.
This guard supports Vercel serverless builds, not standalone output.
Run migration tools from a trusted operator checkout, not from a deployed function bundle.
Keep credentials private and review deployment inputs before publishing.

### Deploying from GitHub

1. Commit the application changes and push the desired branch to GitHub.
   Do not commit `.env.local`, credentials, uploaded documents, or test data.
2. In Vercel, configure **Vercel Authentication / All Deployments** protection
   before deploying. Set a team default first if the project import screen does
   not expose this setting. Standard Protection does not protect production domains.
3. Choose **Add New > Project**, connect GitHub, and select this repository.
   Choose **Next.js**, repository root, **Node 24.x**, install command `npm ci`,
   and build command `npm run build`. Leave Output Directory at the framework default.
4. Install **Neon** from Vercel's Marketplace and connect a fresh test database
   to the project. Use the same database for all writable deployments sharing the
   test Drive root. Confirm that Vercel provides the pooled `DATABASE_URL`.
5. Add these private server environment variables to the intended deployment:
   `STORAGE_MODE=drive`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`,
   `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
   `GOOGLE_OAUTH_REFRESH_TOKEN`, and `GOOGLE_DRIVE_READ_ONLY=false`.
   Reuse the existing test account and root values from the local private
   environment. Do not add a `NEXT_PUBLIC_` prefix or post credentials in GitHub.
6. Set the same pooled `DATABASE_URL` and optional direct
   `DATABASE_URL_UNPOOLED` in local `.env.local`, retaining the same
   `STORAGE_MODE=drive` and Drive root. Run `npm run db:migrate` locally.
   This creates empty PostgreSQL tables and records the storage binding; it does
   not contact or change Google Drive.
7. Deploy the GitHub branch, or redeploy after changing environment variables.
   In a signed-out browser, verify that both production and preview URLs require
   authentication before allowing anyone to use the dashboard.
8. Sign in and open the dashboard. It starts with no application records.
   Use **Sync Storage** to discover drivers, load folders, and documents already
   in the selected test Drive root. Sync does not reconstruct rates, trip details,
   notes, payment status, or deleted paperwork; enter those details separately.

If protection cannot be configured before deployment, leave the project undeployed.
Do not point this trial at production folders.

## Storage modes

| Mode | Selection | Database | Where files go |
|------|-----------|----------|----------------|
| **Local** (development only) | `STORAGE_MODE=local`, or unset | Dedicated PostgreSQL database | `storage\<Driver Name>\Loads\Load #<num>\` |
| **Google Drive** | `STORAGE_MODE=drive` and Google credentials | Dedicated PostgreSQL database bound to this root | Your Drive folder: `<Root>\<Driver Name>\Loads\Load #<num>\` |

Loadout trailers use `Loadout\Loadout #<num>\` instead of `Loads\Load #<num>\`.
The sidebar shows which storage mode is selected; it is not a live Drive health indicator.

New bookings reuse the matching `Loads` or `Loadout` grouping folder when it exists.
Otherwise, if the driver already has load folders directly underneath it, new
`Load #<num>` and `Loadout #<num>` folders are created alongside them; no extra
grouping folder is created. Direct archived load folders also preserve that layout.
A driver with no direct load folders retains the grouped default, including a
brand-new driver. Reassignment follows the destination driver's layout as well.
Existing folders and their documents are never reorganized to change layouts.

Runtime database binding rejects a different storage mode or Drive root rather
than mixing its folders with existing records. Use a separate, empty database
for a different root or storage mode; select the corresponding database connection
and root together. A branch cloned from a populated dataset retains its original
binding and document IDs. Do not bypass binding by editing database metadata.
Switching settings never copies or migrates documents automatically.
Drive binding uses the trimmed `GOOGLE_DRIVE_ROOT_FOLDER_ID`; development-only
local binding uses the absolute `storage\` path resolved from the project's
working directory, normalized to lowercase on Windows.
Moving a local checkout therefore changes its storage binding.

**Independent databases do not coordinate writes to a shared Drive root.** Cloning
a Neon branch does not copy documents, change their IDs, or isolate Drive folder
operations. Deployments that write to the same test root must use one shared test
database. If a preview uses an independent database but the same root, require
`GOOGLE_DRIVE_READ_ONLY=true`. To test independent writes, use a separate test Drive
root with its own empty/bound dataset; do not merely relabel a cloned database's
root metadata while leaving its old folder/document IDs in place.

All records and runtime coordination are stored in PostgreSQL.

### Read-only production Drive

Use `GOOGLE_DRIVE_READ_ONLY=true` before connecting existing production paperwork.
Sync and document viewing remain available, but the server blocks all Drive
uploads, deletions, folder creation, renames, and moves. Booking, manual archive/
restore, reassignment, and driver-name changes are disabled in the interface.
New drivers are discovered through sync rather than created or removed manually.
Statuses, trip details, notes, and driver phone/truck details remain editable
because those changes affect only PostgreSQL dashboard records, not Google Drive.

For a second layer of protection, connect with the OAuth helper's `--read-only`
option, which requests Google's `drive.readonly` permission rather than write
access. Changing a dashboard flag cannot turn that token into a write-capable
token. Local document storage ignores Drive settings and remains development-only,
with its own PostgreSQL database.

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

The board awaits sequential, bounded sync batches and displays cumulative
progress. `POST /api/sync` without a body starts a run; subsequent requests send
JSON `{ "cursor": "<returned cursor>" }` until the response has `cursor: null`.
Counters and errors are cumulative for the run, not values to add across pages.
After a transient error, **Resume Sync** continues the saved cursor. Runs expire
after 24 hours; use **Start new sync** if a saved run has expired. The browser
pauses after 250 batches per action as a safety limit; resume to continue a larger
scan. Leaving the board aborts its pending request and stops automatic continuation.
Do not assume that an aborted response rolled back the last server batch.

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

### Upload limits

Dashboard uploads are limited to **4 MB of document files combined per request**:
4,000,000 bytes, counting file bytes only. This is not 4 MiB and not a per-file
allowance within a booking. A booking's required rate confirmation and all optional
documents share one inclusive limit, checked before submission and again on the
server: exactly 4,000,000 file bytes are allowed; 4,000,001 are rejected.

Form text, field names, and multipart framing do not consume that document-byte
allowance. The server independently caps the **entire serialized incoming request**
at 4,250,000 bytes, including text and multipart metadata, leaving room below
Vercel's 4.5 MB request limit. A 4,000,000-byte file with ordinary booking fields
therefore fits, but excessive text/metadata can still exceed the encoded-request
cap. Oversized text-only requests are rejected by that separate guard as well.

On a load's detail page, selected files upload sequentially, each in a separate
request. The 4 MB combined document-file limit applies to each such request, even
if the whole selection is larger; category text is covered by the separate
encoded-request cap. Successful uploads are retained and only failed
file objects stay selected for retry; oversized files are rejected before a network
request. Add larger documents directly to the correct existing Google Drive load
folder, then use **Sync Storage**. If the required rate confirmation is too large
to book through the dashboard, create the matching load folder and add the document
in Drive, sync it, and then fill in the imported load's trip details. The dashboard
does not implement browser-to-Drive direct uploads.

Dashboard reads and Drive document redirects do not take mutation locks. Local
downloads share a storage guard, allowing simultaneous readers while avoiding
folder-move races. Ordinary load edits do not block document reads. Conflicting mutations use PostgreSQL
transaction guards; ordinary failures undo SQL and attempt storage rollback while
those guards are still held. PostgreSQL and Drive are not one atomic system:
an unconfirmed final commit, interrupted function, or failed cleanup requires
inspection before retrying.

## Backups and recovery

Open **Backups & recovery** for guidance, not an in-app snapshot/restore tool.
Use Neon/provider backups and restore facilities for PostgreSQL. Confirm your
plan's retention and point-in-time restore availability; the dashboard does not
enable or verify provider backups. Alternatively, run `pg_dump` from a trusted
operator environment using the provider's direct connection and private credential
configuration, then store the export encrypted and access-controlled outside Git.

Pause writes before recovery. Test a provider restore or `pg_restore` of a
`pg_dump` custom-format export in a separate Neon branch/database first. Validate
the data and its matching Drive root with `GOOGLE_DRIVE_READ_ONLY=true` while
the original database/deployments still exist. Before enabling writes, switch
every deployment that mutates that root to the same recovered database. Never
allow independent original and restored databases to write to the same Drive
folders. A separate branch does not copy paperwork, and a database rollback
does not roll back documents.

Google Drive stores paperwork, not the application's trip details, statuses, or
notes. Protect and recover those original Drive folders/documents separately,
preserving their IDs and layout. Sync can register available files but cannot
recover deleted paperwork. Development-only local documents also require an
independent protected copy. Keep credentials in private secret storage.

The old `GET/POST /api/backups` and `POST /api/backups/<id>/restore` URLs return
**410 Gone** with actionable PostgreSQL guidance in every storage mode.
These endpoints do not read or change records, documents, or credentials.
Backups and restores must be managed through PostgreSQL or the database provider.

## Development commands

```text
npm run lint
npm test
npm run build
npm run db:migrate
```

Test files run sequentially to avoid simultaneous native PostgreSQL startup on
resource-constrained machines; concurrency scenarios still use multiple clients
and processes inside the tests.

Regression scenarios use Node's built-in runner, embedded real PostgreSQL with
isolated fixture databases, document fixtures, and mocked Drive calls. They do not modify the live dataset,
connect to Neon, or contact Google Drive. Neon credentials are not required to
finish and test the code. Configure the real database connection separately before
starting the dashboard or running operator migration commands; do not substitute
a live dataset for test fixtures. `npm run build` does not run migrations.

On Windows, the embedded PostgreSQL test executables need a modern **Visual C++
2015–2022 x64 runtime**. The test helper can automatically use compatible runtime
DLLs from an existing x64 Edge/Office installation when the system runtime is too
old. Alternatively, set `POSTGRES_TEST_RUNTIME_DIR` in the shell running `npm test`
to a trusted directory containing the compatible x64 runtime DLLs. The fallback
stages private test fixtures inside the project; it does not install system
components or modify `node_modules`. This requirement is only for embedded
PostgreSQL tests, not the application's `pg` client or its migration CLI.

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
DATABASE_URL=postgresql://USER:PASSWORD@POOLED_HOST/DATABASE?sslmode=require
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=C:\path\to\service-account-key.json
GOOGLE_DRIVE_ROOT_FOLDER_ID=your_folder_id_here
```

8. Use a dedicated PostgreSQL database for this root and apply `npm run db:migrate`.
   Restart the dev server. The sidebar should now read **Google Drive mode**, and
   new load folders will follow each driver's existing layout in Drive.

The key-file option is for a trusted local machine. Hosted deployments should
store OAuth credentials or `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` in private server
environment variables, not upload a key file into the repository.

OAuth is also supported using `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN` together with the
root folder ID. To connect or switch Google accounts, keep the OAuth client
ID/secret in `.env.local` and run:

```powershell
node scripts\get-refresh-token.js --read-only --root-folder <FOLDER_ID>
```

Open the local sign-in link from the helper and select the account that can read
the parent folder containing your drivers. The OAuth client's authorized redirect
must include `http://localhost:53682/callback`. The helper validates folder access,
saves credentials privately without printing tokens, and preserves a copy of the
previous environment configuration under ignored `data\oauth-backups\`.
The helper leaves all PostgreSQL connection settings unchanged. Select a separate PostgreSQL
database or Neon branch for a different root before restarting the dashboard.
Use **Sync Storage** only after confirming that database, the selected folder, and
private access. Authorizing the connection itself does not
create, rename, move, upload, or delete anything in Drive.

> **Note:** protect PostgreSQL independently from Google Drive. Changing database
> technology does not copy documents, switch the Google account, or require a new
> OAuth token for the same root.

## Tech

- Next.js 14 (App Router) + TypeScript + Tailwind CSS
- PostgreSQL (`pg`) — Neon through Vercel or a compatible PostgreSQL server
- Node 24.x runtime; explicit PostgreSQL schema migrations
- Optional Google Drive API via OAuth or service account (`googleapis`)

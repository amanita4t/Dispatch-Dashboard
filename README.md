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

```bash
npm install
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
under registered drivers, but does not restore trip details from documents.

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

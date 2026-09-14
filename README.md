# DispatchBoard 🚛

A dispatching dashboard for organizing load paperwork and status. Dispatchers can:

- **Add loads** with load number, pickup/delivery cities & dates, rate, driver, and status
- **Require a rate confirmation** upload at load creation (BOL / other docs optional)
- **Track status**: Scheduled → Picked Up → Unloaded → Invoiced → Paid
- **Manage drivers** — each driver gets a folder in storage
- **Auto-create a folder per load**: `Driver Name/Load #<load number>/`
- **Manage documents** per load from the dashboard: upload BOL, updated rate cons, lumper receipts, invoices, etc.; download & delete

## Running it

```bash
npm install
npm run dev
```

Open http://localhost:3000

## Storage modes

| Mode | When | Where files go |
|------|------|----------------|
| **Local** (default) | No Google credentials configured | `./storage/<Driver Name>/Load #<num>/` |
| **Google Drive** | Credentials configured in `.env.local` | Your Drive folder: `<Root>/<Driver Name>/Load #<num>/` |

The header shows which mode is active.

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
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=C:\path\to\service-account-key.json
GOOGLE_DRIVE_ROOT_FOLDER_ID=your_folder_id_here
```

8. Restart the dev server. The header badge should now read **Google Drive connected**, and new loads will create `Driver Name/Load #123` folders in Drive automatically.

> **Note:** loads/files created in local mode stay local; new uploads after switching go to Drive.

## Tech

- Next.js 14 (App Router) + TypeScript + Tailwind CSS
- SQLite (`better-sqlite3`) — data stored in `./data/dispatch.db`
- Google Drive API via service account (`googleapis`)

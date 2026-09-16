import fs from "fs";
import path from "path";
import { Readable } from "stream";
import type { LoadType } from "./db";
import { getStorageMode, type StorageMode } from "./config";

export interface SavedFile {
  storageRef: string; // local path or Drive file id
  webLink: string; // Drive view link (empty for local)
}

export interface StorageLoadFolder {
  loadNumber: string;
  folderRef: string;
  createdAt: string; // 'YYYY-MM-DD HH:MM:SS' (UTC)
}

export interface StorageFileEntry {
  filename: string;
  storageRef: string;
  webLink: string;
  size: number;
  createdAt: string;
}

export interface StorageProvider {
  readonly mode: StorageMode;
  /** True if the load/loadout folder already exists in storage. */
  loadFolderExists(driverName: string, loadNumber: string, loadType: LoadType): Promise<boolean>;
  /** Ensures Driver/<Loads|Loadout>/<Load|Loadout> #<num> folder exists; returns a folder ref. */
  ensureLoadFolder(driverName: string, loadNumber: string, loadType: LoadType): Promise<string>;
  /** Lists all load/loadout folders inside a driver's Loads or Loadout subfolder. */
  listLoadFolders(driverName: string, loadType: LoadType): Promise<StorageLoadFolder[]>;
  /** Lists files inside a load folder. */
  listFolderFiles(folderRef: string): Promise<StorageFileEntry[]>;
  /**
   * Renames a driver's root folder. Returns old/new path prefixes when stored
   * refs need updating (local paths), or null when refs are stable (Drive ids).
   */
  renameDriverFolder(
    oldName: string,
    newName: string
  ): Promise<{ oldPrefix: string; newPrefix: string } | null>;
  saveFile(
    driverName: string,
    loadNumber: string,
    loadType: LoadType,
    filename: string,
    data: Buffer,
    mimeType: string
  ): Promise<SavedFile>;
  deleteFile(storageRef: string): Promise<void>;
  readFile(storageRef: string): Promise<Buffer>;
}

export function sanitizeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
}

/** Subfolder inside the driver's folder that groups this type. */
export function typeFolderName(loadType: LoadType): string {
  return loadType === "loadout" ? "Loadout" : "Loads";
}

/** e.g. "Load #123" or "Loadout #123" */
export function loadFolderName(loadNumber: string, loadType: LoadType): string {
  const prefix = loadType === "loadout" ? "Loadout" : "Load";
  return `${prefix} #${sanitizeName(loadNumber)}`;
}

const LOAD_FOLDER_RES: Record<LoadType, RegExp> = {
  load: /^Load #(.+)$/,
  loadout: /^Loadout #(.+)$/,
};

function toSqlDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/* ---------------- Local storage ---------------- */

const LOCAL_ROOT = path.join(process.cwd(), "storage");

class LocalStorage implements StorageProvider {
  readonly mode = "local" as const;

  private folderPath(driverName: string, loadNumber: string, loadType: LoadType) {
    return path.join(
      LOCAL_ROOT,
      sanitizeName(driverName),
      typeFolderName(loadType),
      loadFolderName(loadNumber, loadType)
    );
  }

  async loadFolderExists(driverName: string, loadNumber: string, loadType: LoadType) {
    return fs.existsSync(this.folderPath(driverName, loadNumber, loadType));
  }

  async listLoadFolders(driverName: string, loadType: LoadType): Promise<StorageLoadFolder[]> {
    const typeDir = path.join(LOCAL_ROOT, sanitizeName(driverName), typeFolderName(loadType));
    if (!fs.existsSync(typeDir)) return [];
    const out: StorageLoadFolder[] = [];
    for (const entry of fs.readdirSync(typeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const m = entry.name.match(LOAD_FOLDER_RES[loadType]);
      if (!m) continue;
      const full = path.join(typeDir, entry.name);
      const stat = fs.statSync(full);
      out.push({
        loadNumber: m[1].trim(),
        folderRef: full,
        createdAt: toSqlDate(stat.birthtime),
      });
    }
    return out;
  }

  async listFolderFiles(folderRef: string): Promise<StorageFileEntry[]> {
    if (!fs.existsSync(folderRef)) return [];
    const out: StorageFileEntry[] = [];
    for (const entry of fs.readdirSync(folderRef, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const full = path.join(folderRef, entry.name);
      const stat = fs.statSync(full);
      out.push({
        filename: entry.name,
        storageRef: full,
        webLink: "",
        size: stat.size,
        createdAt: toSqlDate(stat.birthtime),
      });
    }
    return out;
  }

  async ensureLoadFolder(driverName: string, loadNumber: string, loadType: LoadType) {
    const dir = this.folderPath(driverName, loadNumber, loadType);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async renameDriverFolder(oldName: string, newName: string) {
    const oldDir = path.join(LOCAL_ROOT, sanitizeName(oldName));
    const newDir = path.join(LOCAL_ROOT, sanitizeName(newName));
    if (oldDir === newDir || !fs.existsSync(oldDir)) return null;
    if (fs.existsSync(newDir)) {
      throw new Error(`A storage folder named "${sanitizeName(newName)}" already exists`);
    }
    fs.renameSync(oldDir, newDir);
    return { oldPrefix: oldDir, newPrefix: newDir };
  }

  async saveFile(
    driverName: string,
    loadNumber: string,
    loadType: LoadType,
    filename: string,
    data: Buffer
  ): Promise<SavedFile> {
    const dir = await this.ensureLoadFolder(driverName, loadNumber, loadType);
    let target = path.join(dir, sanitizeName(filename));
    const parsed = path.parse(target);
    let i = 1;
    while (fs.existsSync(target)) {
      target = path.join(parsed.dir, `${parsed.name} (${i++})${parsed.ext}`);
    }
    fs.writeFileSync(target, data);
    return { storageRef: target, webLink: "" };
  }

  async deleteFile(storageRef: string) {
    if (fs.existsSync(storageRef)) fs.unlinkSync(storageRef);
  }

  async readFile(storageRef: string) {
    return fs.readFileSync(storageRef);
  }
}

/* ---------------- Google Drive storage ---------------- */

class DriveStorage implements StorageProvider {
  readonly mode = "drive" as const;
  private drivePromise: Promise<any> | null = null;

  private async drive() {
    if (!this.drivePromise) {
      this.drivePromise = (async () => {
        const { google } = await import("googleapis");
        const oauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
        const oauthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
        const oauthRefreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
        if (oauthClientId && oauthClientSecret && oauthRefreshToken) {
          // OAuth: act as the user's own Google account (uses their storage quota)
          const oauth2 = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
          oauth2.setCredentials({ refresh_token: oauthRefreshToken });
          return google.drive({ version: "v3", auth: oauth2 });
        }
        const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
        const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
        const auth = new google.auth.GoogleAuth({
          scopes: ["https://www.googleapis.com/auth/drive"],
          ...(keyJson ? { credentials: JSON.parse(keyJson) } : { keyFile }),
        });
        return google.drive({ version: "v3", auth });
      })();
    }
    return this.drivePromise;
  }

  private rootFolderId() {
    const id = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    if (!id) throw new Error("GOOGLE_DRIVE_ROOT_FOLDER_ID is not set");
    return id;
  }

  private async findFolder(drive: any, name: string, parentId: string): Promise<string | null> {
    const escaped = name.replace(/'/g, "\\'");
    const res = await drive.files.list({
      q: `name = '${escaped}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return res.data.files?.length ? (res.data.files[0].id as string) : null;
  }

  private async findOrCreateFolder(drive: any, name: string, parentId: string) {
    const existing = await this.findFolder(drive, name, parentId);
    if (existing) return existing;
    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      },
      fields: "id",
      supportsAllDrives: true,
    });
    return created.data.id as string;
  }

  /** Resolves Driver/<Loads|Loadout> folder id without creating anything. */
  private async findTypeFolder(
    drive: any,
    driverName: string,
    loadType: LoadType
  ): Promise<string | null> {
    const driverFolderId = await this.findFolder(
      drive,
      sanitizeName(driverName),
      this.rootFolderId()
    );
    if (!driverFolderId) return null;
    return this.findFolder(drive, typeFolderName(loadType), driverFolderId);
  }

  async loadFolderExists(driverName: string, loadNumber: string, loadType: LoadType) {
    const drive = await this.drive();
    // do not create folders while only checking
    const typeFolderId = await this.findTypeFolder(drive, driverName, loadType);
    if (!typeFolderId) return false;
    const loadFolderId = await this.findFolder(
      drive,
      loadFolderName(loadNumber, loadType),
      typeFolderId
    );
    return loadFolderId !== null;
  }

  async listLoadFolders(driverName: string, loadType: LoadType): Promise<StorageLoadFolder[]> {
    const drive = await this.drive();
    const typeFolderId = await this.findTypeFolder(drive, driverName, loadType);
    if (!typeFolderId) return [];
    const out: StorageLoadFolder[] = [];
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${typeFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: "nextPageToken, files(id, name, createdTime)",
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of res.data.files || []) {
        const m = (f.name as string).match(LOAD_FOLDER_RES[loadType]);
        if (!m) continue;
        out.push({
          loadNumber: m[1].trim(),
          folderRef: f.id as string,
          createdAt: toSqlDate(new Date(f.createdTime as string)),
        });
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
    return out;
  }

  async listFolderFiles(folderRef: string): Promise<StorageFileEntry[]> {
    const drive = await this.drive();
    const out: StorageFileEntry[] = [];
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${folderRef}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
        fields: "nextPageToken, files(id, name, size, webViewLink, createdTime)",
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of res.data.files || []) {
        out.push({
          filename: f.name as string,
          storageRef: f.id as string,
          webLink: (f.webViewLink as string) || "",
          size: Number(f.size || 0),
          createdAt: toSqlDate(new Date(f.createdTime as string)),
        });
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
    return out;
  }

  async ensureLoadFolder(driverName: string, loadNumber: string, loadType: LoadType) {
    const drive = await this.drive();
    const driverFolderId = await this.findOrCreateFolder(
      drive,
      sanitizeName(driverName),
      this.rootFolderId()
    );
    // reuse the existing Loads/Loadout subfolder if present, create otherwise
    const typeFolderId = await this.findOrCreateFolder(
      drive,
      typeFolderName(loadType),
      driverFolderId
    );
    return this.findOrCreateFolder(drive, loadFolderName(loadNumber, loadType), typeFolderId);
  }

  async renameDriverFolder(oldName: string, newName: string) {
    const drive = await this.drive();
    const oldFolderId = await this.findFolder(drive, sanitizeName(oldName), this.rootFolderId());
    if (!oldFolderId) return null;
    const clash = await this.findFolder(drive, sanitizeName(newName), this.rootFolderId());
    if (clash && clash !== oldFolderId) {
      throw new Error(`A Drive folder named "${sanitizeName(newName)}" already exists`);
    }
    await drive.files.update({
      fileId: oldFolderId,
      requestBody: { name: sanitizeName(newName) },
      supportsAllDrives: true,
    });
    return null; // Drive file ids are stable — no stored refs to rewrite
  }

  async saveFile(
    driverName: string,
    loadNumber: string,
    loadType: LoadType,
    filename: string,
    data: Buffer,
    mimeType: string
  ): Promise<SavedFile> {
    const drive = await this.drive();
    const folderId = await this.ensureLoadFolder(driverName, loadNumber, loadType);
    const res = await drive.files.create({
      requestBody: { name: sanitizeName(filename), parents: [folderId] },
      media: { mimeType, body: Readable.from(data) },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });
    return {
      storageRef: res.data.id as string,
      webLink: (res.data.webViewLink as string) || "",
    };
  }

  async deleteFile(storageRef: string) {
    const drive = await this.drive();
    await drive.files.delete({ fileId: storageRef, supportsAllDrives: true });
  }

  async readFile(storageRef: string): Promise<Buffer> {
    const drive = await this.drive();
    const res = await drive.files.get(
      { fileId: storageRef, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    );
    return Buffer.from(res.data as ArrayBuffer);
  }
}

/* ---------------- Selection ---------------- */

export function driveConfigured(): boolean {
  const hasOauth = Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
      process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  );
  const hasServiceAccount = Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON
  );
  return (hasOauth || hasServiceAccount) && Boolean(process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID);
}

let provider: StorageProvider | null = null;

export function getStorage(): StorageProvider {
  if (!provider) {
    const mode = getStorageMode();
    if (mode === "drive" && !driveConfigured()) {
      throw new Error("Google Drive mode requires Google credentials and GOOGLE_DRIVE_ROOT_FOLDER_ID");
    }
    provider = mode === "drive" ? new DriveStorage() : new LocalStorage();
  }
  return provider;
}

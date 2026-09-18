import fs from "fs";
import path from "path";
import { Readable } from "stream";
import type { drive_v3 } from "googleapis/build/src/apis/drive/v3";
import type { LoadType } from "./models";
import { getStoragePath, getDriveReadOnly, getStorageMode, type StorageMode } from "./config";
import { RequestError } from "./api";
import { errorMessage, hasErrorCode } from "./errors";

export interface SavedFile {
  filename: string;
  storageRef: string;
  webLink: string;
}

export interface StorageLoadFolder {
  loadNumber: string;
  folderRef: string;
  createdAt: string;
}

export interface StorageDriverFolder {
  name: string;
  folderRef: string;
}

export interface StorageFileEntry {
  filename: string;
  storageRef: string;
  webLink: string;
  size: number;
  createdAt: string;
}

export interface StorageMove {
  folderRef: string;
  localPrefixes: { oldPrefix: string; newPrefix: string } | null;
  rollback(): Promise<void>;
}

export interface StorageProvider {
  readonly mode: StorageMode;
  readonly readOnly: boolean;
  listDriverFolders(): Promise<StorageDriverFolder[]>;
  loadFolderPresent(driverName: string, folderRef: string): Promise<boolean>;
  loadFolderExists(driverName: string, loadNumber: string, loadType: LoadType): Promise<boolean>;
  createLoadFolder(driverName: string, loadNumber: string, loadType: LoadType): Promise<string>;
  removeEmptyLoadFolder(folderRef: string): Promise<void>;
  listLoadFolders(driverName: string, loadType: LoadType): Promise<StorageLoadFolder[]>;
  listFolderFiles(folderRef: string): Promise<StorageFileEntry[]>;
  renameDriverFolder(oldName: string, newName: string): Promise<StorageMove | null>;
  moveLoadFolder(folderRef: string, driverName: string, loadNumber: string, loadType: LoadType, archived: boolean): Promise<StorageMove>;
  saveFile(folderRef: string, filename: string, data: Buffer, mimeType: string): Promise<SavedFile>;
  deleteFile(storageRef: string): Promise<void>;
  readFile(storageRef: string): Promise<Buffer>;
}

export function assertStorageWritable(storage: Pick<StorageProvider, "readOnly">) {
  if (storage.readOnly) {
    throw new RequestError("Google Drive is read-only. Creating, uploading, deleting, renaming, and moving folders or documents are blocked.", 403);
  }
}

export function sanitizeName(name: string): string {
  const result = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().replace(/[. ]+$/, "");
  if (!result || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(result)) {
    throw new RequestError("The name cannot be used as a storage filename");
  }
  return result;
}

export function typeFolderName(loadType: LoadType): string {
  return loadType === "loadout" ? "Loadout" : "Loads";
}

export function loadFolderName(loadNumber: string, loadType: LoadType, archived = false): string {
  return `${archived ? "Archived - " : ""}${loadType === "loadout" ? "Loadout" : "Load"} #${sanitizeName(loadNumber)}`;
}

const LOAD_FOLDER_RES: Record<LoadType, RegExp> = { load: /^Load #(.+)$/, loadout: /^Loadout #(.+)$/ };
const toSqlDate = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");

function isLoadFolderName(name: string): boolean {
  const activeName = name.replace(/^Archived - /, "");
  return Object.values(LOAD_FOLDER_RES).some((pattern) => Boolean(activeName.match(pattern)?.[1].trim()));
}

function localPath(ref: string): string {
  const root = getStoragePath();
  const resolved = path.resolve(ref);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new RequestError("Storage path must be inside the document storage folder", 409);
  }
  let current = root;
  for (const part of ["", ...relative.split(path.sep)]) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new RequestError("Linked storage folders and files are not supported", 409);
    }
  }
  return resolved;
}

export function sameStorageRef(left: string, right: string): boolean {
  if (getStorageMode() === "drive") return left === right;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

export function movedReference(ref: string, move: StorageMove): string {
  if (!ref || !move.localPrefixes) return ref;
  const { oldPrefix, newPrefix } = move.localPrefixes;
  const relative = path.relative(oldPrefix, ref);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new RequestError("A document reference is outside its load folder; repair it before moving the folder", 409);
  }
  return path.join(newPrefix, relative);
}

export class LocalStorage implements StorageProvider {
  readonly mode = "local" as const;
  readonly readOnly = false;

  async listDriverFolders(): Promise<StorageDriverFolder[]> {
    const root = getStoragePath();
    if (!fs.existsSync(root)) return [];
    if (fs.lstatSync(root).isSymbolicLink()) throw new RequestError("Linked storage folders are not supported", 409);
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => ({
      name: entry.name,
      folderRef: localPath(path.join(root, entry.name)),
    }));
  }

  async loadFolderPresent(driverName: string, folderRef: string): Promise<boolean> {
    const driverDir = localPath(path.join(getStoragePath(), sanitizeName(driverName)));
    const folder = localPath(folderRef);
    const relative = path.relative(driverDir, folder);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new RequestError("The linked load folder is outside this driver's storage folder; resolve the reference first", 409);
    }
    try {
      fs.readdirSync(driverDir);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        throw new RequestError("The driver's storage folder is unavailable; restore access before syncing missing loads", 409);
      }
      throw error;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(folder);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return false;
      throw error;
    }
    if (!stat.isDirectory()) throw new RequestError("The linked load path is not a folder; resolve it before syncing", 409);
    return true;
  }

  private folderPath(driverName: string, loadNumber: string, loadType: LoadType, archived = false) {
    return localPath(path.join(getStoragePath(), sanitizeName(driverName), typeFolderName(loadType), loadFolderName(loadNumber, loadType, archived)));
  }

  private loadLocations(driverName: string, loadNumber: string, loadType: LoadType) {
    const driver = localPath(path.join(getStoragePath(), sanitizeName(driverName)));
    return [false, true].flatMap((archived) => [
      this.folderPath(driverName, loadNumber, loadType, archived),
      localPath(path.join(driver, loadFolderName(loadNumber, loadType, archived))),
    ]);
  }

  private loadParent(driverName: string, loadType: LoadType): string {
    const driver = localPath(path.join(getStoragePath(), sanitizeName(driverName)));
    const typed = localPath(path.join(driver, typeFolderName(loadType)));
    try {
      if (!fs.statSync(typed).isDirectory()) throw new RequestError("The load grouping path is not a folder", 409);
      return typed;
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
    try {
      const direct = fs.readdirSync(driver, { withFileTypes: true })
        .some((entry) => entry.isDirectory() && isLoadFolderName(entry.name));
      return direct ? driver : typed;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return typed;
      throw error;
    }
  }

  async loadFolderExists(driverName: string, loadNumber: string, loadType: LoadType) {
    return this.loadLocations(driverName, loadNumber, loadType).some((folder) => fs.existsSync(folder));
  }

  async createLoadFolder(driverName: string, loadNumber: string, loadType: LoadType) {
    if (await this.loadFolderExists(driverName, loadNumber, loadType)) {
      throw new RequestError("An active or archived folder for this load already exists", 409);
    }
    const folder = localPath(path.join(this.loadParent(driverName, loadType), loadFolderName(loadNumber, loadType)));
    fs.mkdirSync(path.dirname(folder), { recursive: true });
    fs.mkdirSync(folder);
    return folder;
  }

  async removeEmptyLoadFolder(folderRef: string) {
    fs.rmdirSync(localPath(folderRef));
  }

  async listLoadFolders(driverName: string, loadType: LoadType): Promise<StorageLoadFolder[]> {
    const driverDir = localPath(path.join(getStoragePath(), sanitizeName(driverName)));
    const typeDir = localPath(path.join(driverDir, typeFolderName(loadType)));
    const folders: StorageLoadFolder[] = [];
    for (const parent of [typeDir, driverDir]) {
      if (!fs.existsSync(parent)) continue;
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const match = entry.name.match(LOAD_FOLDER_RES[loadType]);
        if (!match || !match[1].trim()) continue;
        const full = localPath(path.join(parent, entry.name));
        folders.push({ loadNumber: match[1].trim(), folderRef: full, createdAt: toSqlDate(fs.statSync(full).birthtime) });
      }
    }
    return folders;
  }

  async listFolderFiles(folderRef: string): Promise<StorageFileEntry[]> {
    const folder = localPath(folderRef);
    return fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
      const full = localPath(path.join(folder, entry.name));
      const stat = fs.statSync(full);
      return { filename: entry.name, storageRef: full, webLink: "", size: stat.size, createdAt: toSqlDate(stat.birthtime) };
    });
  }

  private async moveFolder(oldFolder: string, newFolder: string): Promise<StorageMove> {
    const from = localPath(oldFolder);
    const to = localPath(newFolder);
    if (!fs.statSync(from).isDirectory()) throw new RequestError("The load folder is not a directory", 409);
    if (from === to) return { folderRef: to, localPrefixes: null, rollback: async () => {} };
    if (fs.existsSync(to) && !sameStorageRef(from, to)) {
      throw new RequestError("The destination folder already exists; no documents were moved", 409);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return {
      folderRef: to,
      localPrefixes: { oldPrefix: from, newPrefix: to },
      rollback: async () => { fs.renameSync(to, from); },
    };
  }

  async renameDriverFolder(oldName: string, newName: string): Promise<StorageMove | null> {
    const oldDir = localPath(path.join(getStoragePath(), sanitizeName(oldName)));
    if (!fs.existsSync(oldDir)) return null;
    return this.moveFolder(oldDir, path.join(getStoragePath(), sanitizeName(newName)));
  }

  async moveLoadFolder(folderRef: string, driverName: string, loadNumber: string, loadType: LoadType, archived: boolean) {
    for (const candidate of this.loadLocations(driverName, loadNumber, loadType)) {
      if (fs.existsSync(candidate) && !sameStorageRef(candidate, folderRef)) {
        throw new RequestError("An active or archived destination folder already exists; no documents were moved", 409);
      }
    }
    const driverDir = localPath(path.join(getStoragePath(), sanitizeName(driverName)));
    const destination = sameStorageRef(path.dirname(folderRef), driverDir)
      ? path.join(driverDir, loadFolderName(loadNumber, loadType, archived))
      : path.join(this.loadParent(driverName, loadType), loadFolderName(loadNumber, loadType, archived));
    return this.moveFolder(folderRef, destination);
  }

  async saveFile(folderRef: string, filename: string, data: Buffer): Promise<SavedFile> {
    const folder = localPath(folderRef);
    if (!fs.statSync(folder).isDirectory()) throw new RequestError("Document folder is missing", 409);
    const safeName = sanitizeName(filename);
    const parsed = path.parse(safeName);
    let target = localPath(path.join(folder, safeName));
    let descriptor: number;
    for (let index = 1; ; index++) {
      try {
        descriptor = fs.openSync(target, "wx");
        break;
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
        target = localPath(path.join(folder, `${parsed.name} (${index})${parsed.ext}`));
      }
    }
    try {
      fs.writeFileSync(descriptor, data);
    } catch (error) {
      fs.closeSync(descriptor);
      try {
        fs.unlinkSync(target);
      } catch (cleanupError) {
        throw new Error(`${errorMessage(error)}. Could not remove the incomplete file: ${errorMessage(cleanupError)}`);
      }
      throw error;
    }
    fs.closeSync(descriptor);
    return { filename: path.basename(target), storageRef: target, webLink: "" };
  }

  async deleteFile(storageRef: string) {
    try {
      fs.unlinkSync(localPath(storageRef));
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
  }

  async readFile(storageRef: string) {
    try {
      return fs.readFileSync(localPath(storageRef));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        throw new RequestError("This document is missing from storage. Recover the original file before downloading it.", 404);
      }
      throw error;
    }
  }
}

function requiredId(id: string | null | undefined): string {
  if (!id) throw new Error("Google Drive returned a response without a file ID");
  return id;
}

const escapeQuery = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export class DriveStorage implements StorageProvider {
  readonly mode = "drive" as const;
  get readOnly() { return getDriveReadOnly(); }
  private drivePromise: Promise<drive_v3.Drive> | null = null;

  private drive(): Promise<drive_v3.Drive> {
    if (!this.drivePromise) {
      this.drivePromise = (async () => {
        const { google } = await import("googleapis");
        const { GOOGLE_OAUTH_CLIENT_ID: clientId, GOOGLE_OAUTH_CLIENT_SECRET: clientSecret, GOOGLE_OAUTH_REFRESH_TOKEN: refreshToken } = process.env;
        if (clientId && clientSecret && refreshToken) {
          const auth = new google.auth.OAuth2({
            clientId, clientSecret,
            transporterOptions: { timeout: 20_000, retryConfig: { retry: 0 } },
          });
          auth.setCredentials({ refresh_token: refreshToken });
          return google.drive({ version: "v3", auth, timeout: 20_000, retry: false });
        }
        let credentials: { client_email: string; private_key: string } | undefined;
        if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
          let key: unknown;
          try {
            key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON);
          } catch (error) {
            if (error instanceof SyntaxError) throw new Error("Invalid Google service account JSON");
            throw error;
          }
          if (typeof key !== "object" || key === null || !("client_email" in key) ||
              !("private_key" in key) || typeof key.client_email !== "string" || typeof key.private_key !== "string") {
            throw new Error("Invalid Google service account credentials");
          }
          credentials = { client_email: key.client_email, private_key: key.private_key };
        }
        const auth = new google.auth.GoogleAuth({
          scopes: [this.readOnly ? "https://www.googleapis.com/auth/drive.readonly" : "https://www.googleapis.com/auth/drive"],
          clientOptions: { transporterOptions: { timeout: 20_000, retryConfig: { retry: 0 } } },
          ...(credentials ? { credentials } : { keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE }),
        });
        return google.drive({ version: "v3", auth, timeout: 20_000, retry: false });
      })();
    }
    return this.drivePromise;
  }

  private rootFolderId() {
    const id = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim();
    if (!id) throw new Error("GOOGLE_DRIVE_ROOT_FOLDER_ID is not set");
    return id;
  }

  private async findFolder(drive: drive_v3.Drive, name: string, parentId: string): Promise<string | null> {
    const response = await drive.files.list({
      q: `name = '${escapeQuery(name)}' and '${escapeQuery(parentId)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id)", supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const files = response.data.files ?? [];
    if (files.length > 1) throw new RequestError(`Multiple Drive folders are named "${name}"; resolve the duplicates first`, 409);
    return files.length ? requiredId(files[0].id) : null;
  }

  private async createFolder(drive: drive_v3.Drive, name: string, parentId: string) {
    assertStorageWritable(this);
    const response = await drive.files.create({
      requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
      fields: "id", supportsAllDrives: true,
    });
    return requiredId(response.data.id);
  }

  private async driverFolder(driverName: string, create: boolean): Promise<string | null> {
    const drive = await this.drive();
    const driver = await this.findFolder(drive, sanitizeName(driverName), this.rootFolderId());
    return driver || (create ? this.createFolder(drive, sanitizeName(driverName), this.rootFolderId()) : null);
  }

  async listDriverFolders(): Promise<StorageDriverFolder[]> {
    return (await this.listEntries(this.rootFolderId(), true)).map((entry) => ({
      name: entry.filename, folderRef: entry.storageRef,
    }));
  }

  async loadFolderPresent(driverName: string, folderRef: string): Promise<boolean> {
    try {
      if (!await this.driverFolder(driverName, false)) {
        throw new RequestError("The driver's Drive folder is unavailable; restore access before syncing missing loads", 409);
      }
      const response = await (await this.drive()).files.get({
        fileId: folderRef, fields: "mimeType, trashed", supportsAllDrives: true,
      });
      if (response.data.mimeType !== "application/vnd.google-apps.folder" || typeof response.data.trashed !== "boolean") {
        throw new RequestError("Drive did not confirm the load folder's state; no deletion was inferred", 409);
      }
      return !response.data.trashed;
    } catch (error) {
      if (hasErrorCode(error, 404)) {
        throw new RequestError("The Drive folder was not found or is inaccessible. Check its location and permissions before archiving.", 409);
      }
      throw error;
    }
  }

  private async typeFolder(driverName: string, loadType: LoadType, create: boolean): Promise<string | null> {
    const drive = await this.drive();
    const driver = await this.driverFolder(driverName, create);
    if (!driver) return null;
    const folder = await this.findFolder(drive, typeFolderName(loadType), driver);
    return folder || (create ? this.createFolder(drive, typeFolderName(loadType), driver) : null);
  }

  private async loadParent(driverName: string, loadType: LoadType): Promise<string> {
    const typed = await this.typeFolder(driverName, loadType, false);
    if (typed) return typed;
    const driver = requiredId(await this.driverFolder(driverName, true));
    const children = await this.listEntries(driver, true);
    if (children.some((entry) => isLoadFolderName(entry.filename))) return driver;
    return requiredId(await this.typeFolder(driverName, loadType, true));
  }

  async loadFolderExists(driverName: string, loadNumber: string, loadType: LoadType) {
    const drive = await this.drive();
    const driver = await this.driverFolder(driverName, false);
    if (!driver) return false;
    const typed = await this.typeFolder(driverName, loadType, false);
    for (const parent of Array.from(new Set(typed ? [typed, driver] : [driver]))) {
      for (const archived of [false, true]) {
        if (await this.findFolder(drive, loadFolderName(loadNumber, loadType, archived), parent)) return true;
      }
    }
    return false;
  }

  async createLoadFolder(driverName: string, loadNumber: string, loadType: LoadType) {
    assertStorageWritable(this);
    if (await this.loadFolderExists(driverName, loadNumber, loadType)) {
      throw new RequestError("An active or archived folder for this load already exists", 409);
    }
    const parent = await this.loadParent(driverName, loadType);
    return this.createFolder(await this.drive(), loadFolderName(loadNumber, loadType), parent);
  }

  async removeEmptyLoadFolder(folderRef: string) {
    assertStorageWritable(this);
    const drive = await this.drive();
    const response = await drive.files.list({
      q: `'${escapeQuery(folderRef)}' in parents and trashed = false`,
      fields: "files(id)", pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    if (response.data.files?.length) throw new Error("The new load folder is not empty; it was kept for recovery");
    await drive.files.delete({ fileId: folderRef, supportsAllDrives: true });
  }

  async listLoadFolders(driverName: string, loadType: LoadType): Promise<StorageLoadFolder[]> {
    const driver = await this.driverFolder(driverName, false);
    if (!driver) return [];
    const typed = await this.typeFolder(driverName, loadType, false);
    const folders: StorageLoadFolder[] = [];
    for (const parent of Array.from(new Set(typed ? [typed, driver] : [driver]))) {
      for (const entry of await this.listEntries(parent, true)) {
        const match = entry.filename.match(LOAD_FOLDER_RES[loadType]);
        if (match?.[1].trim()) folders.push({ loadNumber: match[1].trim(), folderRef: entry.storageRef, createdAt: entry.createdAt });
      }
    }
    return folders;
  }

  private async listEntries(parent: string, folders: boolean): Promise<StorageFileEntry[]> {
    const drive = await this.drive();
    const entries: StorageFileEntry[] = [];
    let pageToken: string | undefined;
    const deadline = Date.now() + 45_000;
    do {
      if (Date.now() >= deadline) {
        throw new RequestError("Google Drive listing exceeded the time limit. No partial folder listing was used; retry Sync storage.", 503);
      }
      const response = await drive.files.list({
        q: `'${escapeQuery(parent)}' in parents and mimeType ${folders ? "=" : "!="} 'application/vnd.google-apps.folder' and trashed = false`,
        fields: "nextPageToken, files(id, name, size, webViewLink, createdTime)",
        pageSize: 1000, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      for (const file of response.data.files ?? []) {
        if (!file.name || !file.createdTime) throw new Error("Google Drive returned incomplete file metadata");
        entries.push({
          filename: file.name, storageRef: requiredId(file.id), webLink: file.webViewLink ?? "",
          size: Number(file.size ?? 0), createdAt: toSqlDate(new Date(file.createdTime)),
        });
      }
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return entries;
  }

  async listFolderFiles(folderRef: string) {
    return this.listEntries(folderRef, false);
  }

  private async moveFolder(folderRef: string, name: string, parent: string, preserveParent?: string): Promise<StorageMove> {
    assertStorageWritable(this);
    const drive = await this.drive();
    const original = await drive.files.get({ fileId: folderRef, fields: "name, parents, mimeType", supportsAllDrives: true });
    if (original.data.mimeType !== "application/vnd.google-apps.folder" || !original.data.name || original.data.parents?.length !== 1) {
      throw new RequestError("The Drive folder cannot be moved safely", 409);
    }
    const oldName = original.data.name;
    const oldParent = original.data.parents[0];
    if (oldParent === preserveParent) parent = oldParent;
    const clash = await this.findFolder(drive, name, parent);
    if (clash && clash !== folderRef) throw new RequestError("The destination Drive folder already exists", 409);
    const changeParent = parent !== oldParent;
    await drive.files.update({
      fileId: folderRef, requestBody: { name },
      ...(changeParent ? { addParents: parent, removeParents: oldParent } : {}),
      supportsAllDrives: true,
    });
    return {
      folderRef, localPrefixes: null,
      rollback: async () => {
        await drive.files.update({
          fileId: folderRef, requestBody: { name: oldName },
          ...(changeParent ? { addParents: oldParent, removeParents: parent } : {}),
          supportsAllDrives: true,
        });
      },
    };
  }

  async renameDriverFolder(oldName: string, newName: string): Promise<StorageMove | null> {
    assertStorageWritable(this);
    const folder = await this.findFolder(await this.drive(), sanitizeName(oldName), this.rootFolderId());
    return folder ? this.moveFolder(folder, sanitizeName(newName), this.rootFolderId()) : null;
  }

  async moveLoadFolder(folderRef: string, driverName: string, loadNumber: string, loadType: LoadType, archived: boolean) {
    assertStorageWritable(this);
    const driver = requiredId(await this.driverFolder(driverName, true));
    const parent = await this.loadParent(driverName, loadType);
    const drive = await this.drive();
    for (const location of Array.from(new Set([parent, driver]))) {
      for (const state of [false, true]) {
        const existing = await this.findFolder(drive, loadFolderName(loadNumber, loadType, state), location);
        if (existing && existing !== folderRef) {
          throw new RequestError("An active or archived destination Drive folder already exists", 409);
        }
      }
    }
    return this.moveFolder(folderRef, loadFolderName(loadNumber, loadType, archived), parent, driver);
  }

  async saveFile(folderRef: string, filename: string, data: Buffer, mimeType: string): Promise<SavedFile> {
    assertStorageWritable(this);
    const safeName = sanitizeName(filename);
    const response = await (await this.drive()).files.create({
      requestBody: { name: safeName, parents: [folderRef] },
      media: { mimeType, body: Readable.from(data) }, fields: "id, webViewLink", supportsAllDrives: true,
    });
    return { filename: safeName, storageRef: requiredId(response.data.id), webLink: response.data.webViewLink ?? "" };
  }

  async deleteFile(storageRef: string) {
    assertStorageWritable(this);
    try {
      await (await this.drive()).files.delete({ fileId: storageRef, supportsAllDrives: true });
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== 404) throw error;
    }
  }

  async readFile(storageRef: string): Promise<Buffer> {
    const response = await (await this.drive()).files.get(
      { fileId: storageRef, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    );
    return Buffer.from(response.data as ArrayBuffer);
  }
}

export function driveConfigured(): boolean {
  const hasOauth = Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REFRESH_TOKEN);
  const hasServiceAccount = Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON);
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

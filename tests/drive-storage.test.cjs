require("./register.cjs");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { DriveStorage, loadFolderName, movedReference } = require("../lib/storage.ts");

function mockedDrive(t, parent = "original-parent") {
  const updates = [];
  const storage = new DriveStorage();
  const files = {
    get: async () => ({ data: { id: "load-id", name: "Load #100", mimeType: "application/vnd.google-apps.folder", parents: ["original-parent"] } }),
    list: async () => ({ data: { files: [] } }),
    update: async (request) => { updates.push(request); return { data: {} }; },
  };
  t.mock.method(storage, "drive", async () => ({ files }));
  t.mock.method(storage, "rootFolderId", () => "root-id");
  t.mock.method(storage, "driverFolder", async () => "driver-root");
  t.mock.method(storage, "typeFolder", async () => parent);
  return { storage, files, updates };
}

test("Drive archive keeps stable IDs and renames the actual folder", async (t) => {
  const { storage, updates } = mockedDrive(t);
  const move = await storage.moveLoadFolder("load-id", "Driver", "100", "load", true);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].requestBody, { name: "Archived - Load #100" });
  assert.equal(updates[0].fileId, "load-id");
  assert.equal(updates[0].addParents, undefined);
  assert.equal(move.folderRef, "load-id");
  assert.equal(movedReference("file-id", move), "file-id");
  await move.rollback();
  assert.deepEqual(updates[1].requestBody, { name: "Load #100" });
});

test("Drive reassignment and rollback move between the correct parent folders", async (t) => {
  const { storage, updates } = mockedDrive(t, "new-parent");
  const move = await storage.moveLoadFolder("load-id", "Other Driver", "100", "load", false);
  assert.equal(updates[0].addParents, "new-parent");
  assert.equal(updates[0].removeParents, "original-parent");
  await move.rollback();
  assert.equal(updates[1].addParents, "original-parent");
  assert.equal(updates[1].removeParents, "new-parent");
});

test("Drive folder conflicts never issue a move or overwrite", async (t) => {
  const { storage, files, updates } = mockedDrive(t);
  files.list = async () => ({ data: { files: [{ id: "another-load" }] } });
  await assert.rejects(storage.moveLoadFolder("load-id", "Driver", "100", "loadout", true), /already exists/);
  assert.equal(updates.length, 0);
  files.list = async () => ({ data: { files: [{ id: "one" }, { id: "two" }] } });
  await assert.rejects(storage.moveLoadFolder("load-id", "Driver", "100", "load", false), /Multiple Drive folders/);
  assert.equal(updates.length, 0);
});

test("Drive import scans both layouts, ignores archived names, and follows pagination", async (t) => {
  const { storage, files } = mockedDrive(t);
  const requests = [];
  files.list = async (request) => {
    requests.push(request);
    if (request.q.includes("'driver-root' in parents")) {
      return { data: { files: [
        { id: "direct", name: "Load #400", createdTime: "2026-09-02T12:00:00Z" },
        { id: "direct-archived", name: "Archived - Load #500", createdTime: "2026-09-02T12:00:00Z" },
        { id: "other-type", name: "Loadout #600", createdTime: "2026-09-02T12:00:00Z" },
      ] } };
    }
    return request.pageToken
      ? { data: { files: [{ id: "second", name: "Load #200", createdTime: "2026-09-02T12:00:00Z" }] } }
      : { data: { nextPageToken: "next", files: [
        { id: "first", name: "Load #100", createdTime: "2026-09-01T12:00:00Z" },
        { id: "archived", name: "Archived - Load #300", createdTime: "2026-09-01T12:00:00Z" },
      ] } };
  };
  const folders = await storage.listLoadFolders("Driver", "load");
  assert.deepEqual(folders.map((folder) => folder.loadNumber), ["100", "200", "400"]);
  assert.deepEqual(folders.map((folder) => folder.folderRef), ["first", "second", "direct"]);
  assert.equal(requests[1].pageToken, "next");
  assert.equal(requests.length, 3);
});

test("Drive discovery lists driver folder names and stable IDs across pages without creating folders", async (t) => {
  const { storage, files, updates } = mockedDrive(t);
  const requests = [];
  files.list = async (request) => {
    requests.push(request);
    assert.match(request.q, /'root-id' in parents/);
    assert.match(request.q, /mimeType = 'application\/vnd.google-apps.folder'/);
    assert.match(request.q, /trashed = false/);
    return request.pageToken
      ? { data: { files: [{ id: "williams-id", name: "Williams", createdTime: "2026-09-02T12:00:00Z" }] } }
      : { data: { nextPageToken: "next", files: [{ id: "aman-id", name: "Aman", createdTime: "2026-09-01T12:00:00Z" }] } };
  };
  assert.deepEqual(await storage.listDriverFolders(), [
    { name: "Aman", folderRef: "aman-id" }, { name: "Williams", folderRef: "williams-id" },
  ]);
  assert.equal(requests[1].pageToken, "next");
  assert.equal(updates.length, 0);
});

test("Drive discovers direct Loadout folders even without a typed container", async (t) => {
  for (const parent of [null, "loadout-parent"]) {
    const { storage, files, updates } = mockedDrive(t, parent);
    files.list = async (request) => ({ data: { files: request.q.includes("'driver-root' in parents") ? [
      { id: "direct", name: "Loadout #100", createdTime: "2026-09-01T12:00:00Z" },
      { id: "archived", name: "Archived - Loadout #200", createdTime: "2026-09-01T12:00:00Z" },
      { id: "other-type", name: "Load #300", createdTime: "2026-09-01T12:00:00Z" },
    ] : [
      { id: "nested", name: "Loadout #400", createdTime: "2026-09-01T12:00:00Z" },
    ] } });
    const folders = await storage.listLoadFolders("Driver", "loadout");
    assert.deepEqual(folders.map((folder) => folder.folderRef), parent ? ["nested", "direct"] : ["direct"]);
    assert.equal(updates.length, 0);
  }
});

test("Drive booking respects direct active and archived load folders", async (t) => {
  const { storage, files } = mockedDrive(t, null);
  for (const type of ["load", "loadout"]) {
    for (const archived of [false, true]) {
      files.list = async (request) => ({ data: {
        files: request.q.includes("'driver-root' in parents") && request.q.includes(`name = '${loadFolderName("100", type, archived)}'`)
          ? [{ id: "existing-load" }] : [],
      } });
      assert.equal(await storage.loadFolderExists("Driver", "100", type), true);
      assert.equal(await storage.loadFolderExists("Driver", "101", type), false);
      await assert.rejects(storage.createLoadFolder("Driver", "100", type), /already exists/);
    }
  }
});

test("Drive direct destination conflicts block moves before any folder update", async (t) => {
  const { storage, files, updates } = mockedDrive(t);
  files.list = async (request) => ({ data: {
    files: request.q.includes("'driver-root' in parents") && request.q.includes("name = 'Archived - Load #100'")
      ? [{ id: "other-load" }] : [],
  } });
  await assert.rejects(storage.moveLoadFolder("load-id", "Driver", "100", "load", true), /already exists/);
  assert.equal(updates.length, 0);
});

test("Drive archive and restore preserve directly imported parent folders", async (t) => {
  const { storage, files, updates } = mockedDrive(t);
  for (const archived of [true, false]) {
    files.get = async () => ({ data: {
      name: loadFolderName("100", "load", !archived),
      mimeType: "application/vnd.google-apps.folder", parents: ["driver-root"],
    } });
    const move = await storage.moveLoadFolder("load-id", "Driver", "100", "load", archived);
    const update = updates.at(-1);
    assert.equal(update.requestBody.name, loadFolderName("100", "load", archived));
    assert.equal(update.addParents, undefined);
    assert.equal(update.removeParents, undefined);
    assert.equal(move.folderRef, "load-id");
    await move.rollback();
    assert.equal(updates.at(-1).requestBody.name, loadFolderName("100", "load", !archived));
  }
});

test("Drive folder presence requires explicit metadata and recognizes confirmed Trash entries", async (t) => {
  const { storage, files, updates } = mockedDrive(t);
  for (const trashed of [false, true]) {
    files.get = async (request) => {
      assert.equal(request.fileId, "load-id");
      assert.equal(request.fields, "mimeType, trashed");
      assert.equal(request.supportsAllDrives, true);
      return { data: { mimeType: "application/vnd.google-apps.folder", trashed } };
    };
    assert.equal(await storage.loadFolderPresent("Driver", "load-id"), !trashed);
  }
  for (const metadata of [{}, { mimeType: "application/vnd.google-apps.folder" }, { mimeType: "text/plain", trashed: false }]) {
    files.get = async () => ({ data: metadata });
    await assert.rejects(storage.loadFolderPresent("Driver", "load-id"), /did not confirm/);
  }
  assert.equal(updates.length, 0);
});

test("Drive not-found, permission, and connection failures never count as deleted folders", async (t) => {
  const { storage, files, updates } = mockedDrive(t);
  for (const code of [404, 403, 500]) {
    files.get = async () => { throw Object.assign(new Error(`Drive failure ${code}`), { code }); };
    await assert.rejects(storage.loadFolderPresent("Driver", "load-id"),
      code === 404 ? /not found or is inaccessible/ : new RegExp(`Drive failure ${code}`));
  }
  t.mock.method(storage, "driverFolder", async () => null);
  files.get = async () => assert.fail("Do not infer load deletions when the driver folder is unavailable");
  await assert.rejects(storage.loadFolderPresent("Driver", "load-id"), /Drive folder is unavailable/);
  assert.equal(updates.length, 0);
});

test("Drive deletion tolerates already-missing files but propagates permission failures", async (t) => {
  const { storage, files } = mockedDrive(t);
  files.delete = async () => { throw Object.assign(new Error("Not found"), { code: 404 }); };
  await storage.deleteFile("file-id");
  files.delete = async () => { throw Object.assign(new Error("Permission denied"), { code: 403 }); };
  await assert.rejects(storage.deleteFile("file-id"), /Permission denied/);
});

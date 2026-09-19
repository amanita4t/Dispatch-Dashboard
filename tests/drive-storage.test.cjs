require("./register.cjs");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { DriveStorage, loadFolderName, movedReference } = require("../lib/storage.ts");

const rootMetadata = {
  mimeType: "application/vnd.google-apps.folder", trashed: false, capabilities: { canListChildren: true },
};

function mockedDrive(t, parent = "original-parent") {
  const updates = [];
  const creates = [];
  const storage = new DriveStorage();
  const files = {
    get: async (request) => ({ data: request.fileId === "root-id" ? rootMetadata
      : { id: "load-id", name: "Load #100", mimeType: "application/vnd.google-apps.folder", parents: ["original-parent"] } }),
    list: async () => ({ data: { files: [] } }),
    update: async (request) => { updates.push(request); return { data: {} }; },
    create: async (request) => { creates.push(request); return { data: { id: `created-${creates.length}` } }; },
  };
  t.mock.method(storage, "drive", async () => ({ files }));
  t.mock.method(storage, "rootFolderId", () => "root-id");
  t.mock.method(storage, "driverFolder", async () => "driver-root");
  t.mock.method(storage, "typeFolder", async () => parent);
  return { storage, files, updates, creates };
}

test("Drive creates both load types directly beside existing active or archived load folders", async (t) => {
  for (const seed of ["Load #EXISTING", "Loadout #EXISTING", "Archived - Load #EXISTING", "Archived - Loadout #EXISTING"]) {
    const { storage, files, updates, creates } = mockedDrive(t, null);
    t.mock.method(storage, "typeFolder", async (_name, _type, create) => {
      assert.equal(create, false, "A flat driver layout must not acquire a grouping folder");
      return null;
    });
    files.list = async (request) => ({ data: { files: request.q.startsWith("name =") ? [] : [
      { id: "existing-load", name: seed, createdTime: "2026-09-01T12:00:00Z" },
    ] } });
    for (const type of ["load", "loadout"]) {
      const id = await storage.createLoadFolder("Driver", "NEW", type);
      assert.equal(id, `created-${creates.length}`);
      assert.deepEqual(creates.at(-1).requestBody, {
        name: loadFolderName("NEW", type), mimeType: "application/vnd.google-apps.folder", parents: ["driver-root"],
      });
    }
    assert.equal(creates.length, 2);
    assert.equal(updates.length, 0);
  }
});

test("Drive booking uses an existing matching container without inspecting or changing the flat layout", async (t) => {
  const { storage, creates, updates } = mockedDrive(t, "typed-parent");
  t.mock.method(storage, "listEntries", async () => assert.fail("An existing matching container takes precedence"));
  for (const type of ["load", "loadout"]) {
    await storage.createLoadFolder("Driver", "NEW", type);
    assert.deepEqual(creates.at(-1).requestBody.parents, ["typed-parent"]);
    assert.equal(creates.at(-1).requestBody.name, loadFolderName("NEW", type));
  }
  assert.equal(creates.length, 2);
  assert.equal(updates.length, 0);
});

test("Drive retains the grouped default when no direct load folders exist", async (t) => {
  for (const existingNames of [[], ["Loads", "Documents"]]) {
    const { storage, files, creates } = mockedDrive(t);
    t.mock.method(storage, "typeFolder", DriveStorage.prototype.typeFolder.bind(storage));
    files.list = async (request) => ({ data: { files: request.q.startsWith("name =") ? [] : existingNames.map((name, index) => ({
      id: `existing-${index}`, name, createdTime: "2026-09-01T12:00:00Z",
    })) } });
    await storage.createLoadFolder("Driver", "NEW", "loadout");
    assert.equal(creates.length, 2);
    assert.deepEqual(creates[0].requestBody, {
      name: "Loadout", mimeType: "application/vnd.google-apps.folder", parents: ["driver-root"],
    });
    assert.deepEqual(creates[1].requestBody, {
      name: "Loadout #NEW", mimeType: "application/vnd.google-apps.folder", parents: ["created-1"],
    });
  }
});

test("Drive layout detection reads later pages before deciding to create a grouping folder", async (t) => {
  const { storage, files, creates } = mockedDrive(t, null);
  const pages = [];
  files.list = async (request) => {
    if (request.q.startsWith("name =")) return { data: { files: [] } };
    pages.push(request.pageToken);
    return request.pageToken ? { data: { files: [
      { id: "old-load", name: "Archived - Loadout #EXISTING", createdTime: "2026-09-01T12:00:00Z" },
    ] } } : { data: { files: [], nextPageToken: "next" } };
  };
  await storage.createLoadFolder("Driver", "NEW", "load");
  assert.deepEqual(pages, [undefined, "next"]);
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].requestBody.parents, ["driver-root"]);
});

test("Drive layout scan failures never create a load or an extra grouping folder", async (t) => {
  const { storage, creates } = mockedDrive(t, null);
  t.mock.method(storage, "listEntries", async () => { throw new Error("Driver layout is unavailable"); });
  await assert.rejects(storage.createLoadFolder("Driver", "NEW", "loadout"), /layout is unavailable/);
  assert.equal(creates.length, 0);
});

test("Drive reassignment joins direct destination loads without creating containers", async (t) => {
  const { storage, files, creates, updates } = mockedDrive(t, null);
  files.list = async (request) => ({ data: { files: request.q.startsWith("name =") ? [] : [
    { id: "existing-load", name: "Load #EXISTING", createdTime: "2026-09-01T12:00:00Z" },
  ] } });
  const move = await storage.moveLoadFolder("load-id", "Driver", "100", "loadout", false);
  assert.equal(creates.length, 0);
  assert.equal(updates[0].addParents, "driver-root");
  assert.equal(updates[0].removeParents, "original-parent");
  assert.equal(updates[0].requestBody.name, "Loadout #100");
  await move.rollback();
  assert.equal(updates[1].addParents, "original-parent");
  assert.equal(updates[1].removeParents, "driver-root");
});

test("read-only Drive blocks every document and folder mutation before issuing an API request", async (t) => {
  const previous = process.env.GOOGLE_DRIVE_READ_ONLY;
  process.env.GOOGLE_DRIVE_READ_ONLY = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.GOOGLE_DRIVE_READ_ONLY;
    else process.env.GOOGLE_DRIVE_READ_ONLY = previous;
  });
  const storage = new DriveStorage();
  const connection = t.mock.method(storage, "drive", async () => assert.fail("Read-only mutation reached Google Drive"));
  const rejected = (error) => error.status === 403 && /read-only/.test(error.message);
  for (const action of [
    () => storage.createLoadFolder("Driver", "100", "load"),
    () => storage.removeEmptyLoadFolder("load-id"),
    () => storage.renameDriverFolder("Driver", "New Driver"),
    () => storage.moveLoadFolder("load-id", "Driver", "100", "load", true),
    () => storage.moveLoadFolder("load-id", "Driver", "100", "load", false),
    () => storage.saveFile("load-id", "file.txt", Buffer.from("document"), "text/plain"),
    () => storage.deleteFile("file-id"),
  ]) await assert.rejects(action, rejected);
  assert.equal(connection.mock.callCount(), 0);
  assert.equal(storage.readOnly, true);
});

test("read-only Drive can list and read documents without issuing mutations", async (t) => {
  const previous = process.env.GOOGLE_DRIVE_READ_ONLY;
  process.env.GOOGLE_DRIVE_READ_ONLY = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.GOOGLE_DRIVE_READ_ONLY;
    else process.env.GOOGLE_DRIVE_READ_ONLY = previous;
  });
  const { storage, files, updates } = mockedDrive(t);
  files.list = async () => ({ data: { files: [
    { id: "existing-id", name: "rate.pdf", size: "10", createdTime: "2026-09-01T12:00:00Z" },
  ] } });
  const listed = await storage.listFolderFiles("load-id");
  assert.equal(listed[0].storageRef, "existing-id");
  files.get = async (request) => {
    assert.equal(request.fileId, "existing-id");
    assert.equal(request.alt, "media");
    return { data: Buffer.from("paperwork") };
  };
  assert.equal((await storage.readFile("existing-id")).toString(), "paperwork");
  assert.equal(updates.length, 0);
});

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
      if (request.fileId === "root-id") return { data: rootMetadata };
      assert.equal(request.fileId, "load-id");
      assert.equal(request.fields, "mimeType, trashed");
      assert.equal(request.supportsAllDrives, true);
      return { data: { mimeType: "application/vnd.google-apps.folder", trashed } };
    };
    assert.equal(await storage.loadFolderPresent("Driver", "load-id"), !trashed);
  }
  for (const metadata of [{}, { mimeType: "application/vnd.google-apps.folder" }, { mimeType: "text/plain", trashed: false }]) {
    files.get = async (request) => ({ data: request.fileId === "root-id" ? rootMetadata : metadata });
    await assert.rejects(storage.loadFolderPresent("Driver", "load-id"), /did not confirm/);
  }
  assert.equal(updates.length, 0);
});

test("Drive treats missing load and driver folders as absent when the storage root is readable", async (t) => {
  const { storage, files, updates, creates } = mockedDrive(t);
  const reads = [];
  files.get = async (request) => {
    reads.push(request.fileId);
    if (request.fileId === "root-id") return { data: rootMetadata };
    throw Object.assign(new Error("Load permanently deleted"), { code: 404 });
  };
  assert.equal(await storage.loadFolderPresent("Driver", "deleted-load-id"), false);
  assert.deepEqual(reads, ["root-id", "deleted-load-id"]);
  t.mock.method(storage, "driverFolder", async () => null);
  reads.length = 0;
  assert.equal(await storage.loadFolderPresent("Driver", "load-id"), false);
  assert.deepEqual(reads, ["root-id"]);
  assert.equal(updates.length, 0);
  assert.equal(creates.length, 0);
});

test("Drive refuses missing, trashed, unreadable, or unconfirmed roots before inferring folder deletion", async (t) => {
  const { storage, files } = mockedDrive(t);
  for (const metadata of [
    {}, { ...rootMetadata, trashed: true }, { ...rootMetadata, mimeType: "text/plain" },
    { ...rootMetadata, capabilities: {} }, { ...rootMetadata, capabilities: { canListChildren: false } },
  ]) {
    files.get = async (request) => {
      assert.equal(request.fileId, "root-id");
      return { data: metadata };
    };
    await assert.rejects(storage.loadFolderPresent("Driver", "load-id"), /storage root is unavailable/);
    await assert.rejects(storage.listDriverFolders(), /storage root is unavailable/);
  }
  for (const code of [404, 403, 500]) {
    files.get = async (request) => {
      assert.equal(request.fileId, "root-id");
      throw Object.assign(new Error(`Root request failed ${code}`), { code });
    };
    await assert.rejects(storage.loadFolderPresent("Driver", "load-id"), /Root request failed/);
    await assert.rejects(storage.listDriverFolders(), /Root request failed/);
  }
});

test("Drive permission and connection failures remain errors rather than missing folders", async (t) => {
  const { storage, files, updates } = mockedDrive(t);
  for (const code of [403, 429, 500, "ETIMEDOUT"]) {
    files.get = async (request) => {
      if (request.fileId === "root-id") return { data: rootMetadata };
      throw Object.assign(new Error(`Drive failure ${code}`), { code });
    };
    await assert.rejects(storage.loadFolderPresent("Driver", "load-id"),
      new RegExp(`Drive failure ${code}`));
  }
  assert.equal(updates.length, 0);
});

test("Drive deletion tolerates already-missing files but propagates permission failures", async (t) => {
  const { storage, files } = mockedDrive(t);
  files.delete = async () => { throw Object.assign(new Error("Not found"), { code: 404 }); };
  await storage.deleteFile("file-id");
  files.delete = async () => { throw Object.assign(new Error("Permission denied"), { code: 403 }); };
  await assert.rejects(storage.deleteFile("file-id"), /Permission denied/);
});

/* eslint-disable @typescript-eslint/no-require-imports -- The existing Node test harness uses CommonJS to register TypeScript imports. */
require("./register.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { BACKUP_GUIDANCE, LEGACY_BACKUP_ERROR } = require("../lib/backup.ts");
const api = require("../app/api/backups/route.ts");
const restoreApi = require("../app/api/backups/[id]/restore/route.ts");
const BackupsPage = require("../app/backups/page.tsx").default;

async function assertRetired(response) {
  assert.equal(response.status, 410);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.code, "LEGACY_BACKUPS_UNSUPPORTED");
  assert.equal(body.error, LEGACY_BACKUP_ERROR);
  assert.match(body.error, /In-app database backup and restore endpoints are not supported/);
  assert.match(body.error, /Neon\/provider restore or pg_dump/);
  assert.match(body.error, /Google Drive documents separately/);
  assert.deepEqual(body.guidance, BACKUP_GUIDANCE);
}

test("legacy backup URLs are permanently unavailable in every storage mode", async () => {
  const original = process.env.STORAGE_MODE;
  try {
    for (const mode of ["local", "drive", "invalid"]) {
      process.env.STORAGE_MODE = mode;
      await assertRetired(await api.GET());
      await assertRetired(await api.POST());
      await assertRetired(await restoreApi.POST());
    }
  } finally {
    if (original === undefined) delete process.env.STORAGE_MODE;
    else process.env.STORAGE_MODE = original;
  }
});

test("legacy confirmations, snapshot IDs and malformed bodies cannot enable a restore", async () => {
  const ids = ["local-20260901T100000000Z-aabbccddeeff", "../escape", "..\\escape", "%2e%2e", "", "local-invalid"];
  for (const id of ids) {
    for (const body of ['{"confirmation":"RESTORE LOCAL DATA"}', '{"confirmation":"yes"}', "not JSON"]) {
      const request = new Request("http://localhost/api/backups/legacy/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      await assertRetired(await restoreApi.POST(request, { params: { id } }));
      assert.equal(request.bodyUsed, false, "Retired endpoints must reject without reading uploaded data.");
    }
  }
});

test("backup URLs do not access snapshots, documents, database files or remote providers", async (t) => {
  const fail = () => assert.fail("A retired backup endpoint must not access storage or a provider.");
  for (const method of ["readFileSync", "writeFileSync", "openSync", "readdirSync", "statSync", "lstatSync",
    "mkdirSync", "renameSync", "unlinkSync", "rmSync", "cpSync"]) {
    t.mock.method(fs, method, fail);
  }
  for (const method of ["readFile", "writeFile", "open", "readdir", "stat", "lstat", "mkdir", "rename", "unlink", "rm", "cp"]) {
    t.mock.method(fs.promises, method, fail);
  }
  t.mock.method(globalThis, "fetch", fail);
  const unreadableRequest = {
    get body() { return fail(); },
    json: fail,
    formData: fail,
    text: fail,
  };
  await assertRetired(await api.GET());
  await assertRetired(await api.POST(unreadableRequest));
  await assertRetired(await restoreApi.POST(unreadableRequest, {
    get params() { return fail(); },
  }));
});

test("backup guidance separates PostgreSQL recovery from documents and serverless functions", () => {
  assert.match(BACKUP_GUIDANCE.database, /Neon/);
  assert.match(BACKUP_GUIDANCE.database, /PostgreSQL/);
  assert.match(BACKUP_GUIDANCE.database, /pg_dump/);
  assert.match(BACKUP_GUIDANCE.database, /separate database/);
  assert.match(BACKUP_GUIDANCE.database, /independent databases must not both write/);
  assert.match(BACKUP_GUIDANCE.documents, /does not recover deleted paperwork/);
  assert.match(BACKUP_GUIDANCE.application, /does not create or restore local database snapshots/);
  assert.match(BACKUP_GUIDANCE.application, /not inside a Vercel function/);
  const html = renderToStaticMarkup(React.createElement(BackupsPage));
  assert.match(html, /PostgreSQL stores dashboard records/);
  assert.match(html, /Google Drive stores paperwork/);
  assert.match(html, /does not verify or enable backups/);
  assert.match(html, /not read, changed, or deleted/);
  assert.match(html, /GOOGLE_DRIVE_READ_ONLY=true/);
  assert.match(html, /database branch does not copy or isolate Drive documents/);
  assert.match(html, /Independent PostgreSQL databases must not write to the same Drive folders/);
  assert.doesNotMatch(html, /<(?:button|form|input)\b/);
});

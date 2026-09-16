require("./register.cjs");
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { getStorageMode, getDataPaths } = require("../lib/config.ts");

test("local remains the default with Google credentials configured", () => {
  const keys = ["STORAGE_MODE", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN", "GOOGLE_DRIVE_ROOT_FOLDER_ID"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.STORAGE_MODE;
    for (const key of keys.slice(1)) process.env[key] = "unused-test-value";
    assert.equal(getStorageMode(), "local");
    assert.equal(path.basename(getDataPaths().database), "dispatch-local.db");
    const filename = require.resolve("../lib/storage.ts");
    delete require.cache[filename];
    assert.equal(require(filename).getStorage().mode, "local");
    process.env.STORAGE_MODE = "drive";
    assert.equal(getStorageMode(), "drive");
    assert.equal(path.basename(getDataPaths().database), "dispatch.db");
    delete require.cache[filename];
    assert.equal(require(filename).getStorage().mode, "drive");
    process.env.STORAGE_MODE = "unknown";
    assert.throws(getStorageMode, /STORAGE_MODE/);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

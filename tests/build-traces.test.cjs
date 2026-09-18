const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { checkBuildTraces } = require("../scripts/check-build-traces.cjs");

function fixture(t) {
  const data = path.resolve(__dirname, "..", "data");
  fs.mkdirSync(data, { recursive: true });
  const root = fs.mkdtempSync(path.join(data, "test-build-traces-"));
  t.after(() => {
    assert.equal(path.dirname(root), data);
    assert.ok(path.basename(root).startsWith("test-build-traces-"));
    fs.rmSync(root, { recursive: true });
  });
  return root;
}

test("deployment traces exclude private data without changing source files or runtime dependencies", (t) => {
  const root = fixture(t);
  const directory = path.join(root, ".next", "server", "app", "api", "loads");
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(root, "data"));
  const source = path.join(root, "data", "dispatch.db");
  fs.writeFileSync(source, "preserved private dataset");
  const privateFiles = ["data", "storage", "backups", "tests", "scripts", "migrations", ".git", ".vercel", ".dispatch-workflows-fixture"]
    .map((name) => path.join(root, name, "private-file"));
  privateFiles.push(source, path.join(root, ".env"), path.join(root, ".env.local"));
  const dependencies = [
    path.join(root, "node_modules", "googleapis", "build", "src", "apis", "storage", "v1.js"),
    path.join(root, ".next", "server", "chunks", "123.js"),
  ].map((file) => path.relative(directory, file));
  const manifest = path.join(directory, "route.js.nft.json");
  fs.writeFileSync(manifest, JSON.stringify({
    version: 1, files: [...privateFiles.map((file) => path.relative(directory, file)), ...dependencies], extra: "preserved",
  }));
  assert.deepEqual(checkBuildTraces(root), { traces: 1, excluded: privateFiles.length });
  assert.deepEqual(JSON.parse(fs.readFileSync(manifest, "utf8")), { version: 1, files: dependencies, extra: "preserved" });
  assert.equal(fs.readFileSync(source, "utf8"), "preserved private dataset");
  assert.deepEqual(checkBuildTraces(root), { traces: 1, excluded: 0 });
});

test("builds fail closed when traces are missing, malformed, or standalone data was already copied", (t) => {
  const root = fixture(t);
  const build = path.join(root, ".next");
  fs.mkdirSync(build);
  assert.throws(() => checkBuildTraces(root), /No Next.js function traces/);
  const manifest = path.join(build, "next-server.js.nft.json");
  fs.writeFileSync(manifest, JSON.stringify({ version: 2, files: [] }));
  assert.throws(() => checkBuildTraces(root), /Unsupported Next.js file trace/);
  fs.mkdirSync(path.join(build, "standalone"));
  assert.throws(() => checkBuildTraces(root), /not standalone copies/);
});

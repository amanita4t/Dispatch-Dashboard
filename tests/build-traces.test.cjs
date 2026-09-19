const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const picomatch = require("next/dist/compiled/picomatch");
const { checkBuildTraces } = require("../scripts/check-build-traces.cjs");

test("Next.js privacy exclusions cover API routes without pruning shared Google dependencies", async () => {
  const { default: config } = await import(pathToFileURL(path.resolve(__dirname, "..", "next.config.mjs")).href);
  const exclusions = config.experimental.outputFileTracingExcludes;
  const sharedExclusions = Object.entries(exclusions)
    .filter(([route]) => picomatch(route)("next-server"))
    .flatMap(([, patterns]) => patterns);
  const sharedIgnore = picomatch(sharedExclusions, { contains: true, dot: true });
  for (const dependency of [
    "node_modules/gcp-metadata/build/src/index.js",
    "node_modules/google-auth-library/node_modules/gcp-metadata/build/src/index.js",
    "node_modules/googleapis/build/src/apis/analyticsdata/v1beta.js",
    "node_modules/googleapis/build/src/apis/storage/v1.js",
  ]) {
    assert.equal(sharedIgnore(dependency), false, `Next's shared trace would omit ${dependency}`);
  }
  for (const route of ["/api/loads", "/api/loads/1/files", "/api/drivers", "/api/files/1", "/api/sync", "/api/status"]) {
    assert.ok(Object.keys(exclusions).some((pattern) => picomatch(pattern, { contains: true, dot: true })(route)),
      `Privacy exclusions must still cover ${route}`);
  }
});

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
    path.join(root, "node_modules", "googleapis", "build", "src", "apis", "analyticsdata", "v1beta.js"),
    path.join(root, "node_modules", "google-auth-library", "node_modules", "gcp-metadata", "build", "src", "index.js"),
    path.join(root, "node_modules", "gcp-metadata", "package.json"),
    path.join(root, "node_modules", "json-bigint", "index.js"),
    path.join(root, "node_modules", "bignumber.js", "bignumber.js"),
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

/* eslint-disable @typescript-eslint/no-require-imports -- This standalone Node build helper uses CommonJS. */
const fs = require("node:fs");
const path = require("node:path");

const LOCAL_DIRECTORIES = new Set(["data", "storage", "backups", "tests", "scripts", "migrations", ".git", ".vercel"]);

function isLocalOnly(root, filename) {
  let relative = path.relative(root, filename);
  if (process.platform === "win32") relative = relative.toLowerCase();
  const first = relative.split(path.sep)[0];
  return LOCAL_DIRECTORIES.has(first) || first.startsWith(".dispatch-workflows-") ||
    first === ".env" || first.startsWith(".env.");
}

function checkBuildTraces(root = process.cwd()) {
  const build = path.join(root, ".next");
  if (fs.existsSync(path.join(build, "standalone"))) {
    throw new Error("This build guard supports Vercel serverless output, not standalone copies. Remove output: 'standalone' and rebuild.");
  }
  let traces = 0;
  let excluded = 0;
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "cache") visit(filename);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".nft.json")) continue;
      const trace = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (trace.version !== 1 || !Array.isArray(trace.files) || trace.files.some((file) => typeof file !== "string")) {
        throw new Error(`Unsupported Next.js file trace: ${path.relative(root, filename)}`);
      }
      traces++;
      const files = trace.files.filter((file) => !isLocalOnly(root, path.resolve(directory, file)));
      excluded += trace.files.length - files.length;
      if (files.length !== trace.files.length) {
        // Next 14 resolves exclusion globs with backslashes on Windows, which its matcher treats as escapes.
        fs.writeFileSync(filename, JSON.stringify({ ...trace, files }));
      }
    }
  }
  visit(build);
  if (!traces) throw new Error("No Next.js function traces were found. Run next build before checking deployment artifacts.");
  return { traces, excluded };
}

if (require.main === module) {
  const result = checkBuildTraces();
  console.log(`Checked ${result.traces} deployment traces; excluded ${result.excluded} private/local-only file references.`);
}

module.exports = { checkBuildTraces };

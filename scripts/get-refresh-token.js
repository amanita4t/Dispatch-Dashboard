/* eslint-disable @typescript-eslint/no-require-imports -- This standalone Node helper uses CommonJS. */
/**
 * Connect a Google account without changing any Drive files.
 *
 * Usage:
 *   node scripts\get-refresh-token.js --read-only --root-folder <FOLDER_ID>
 *   node scripts\get-refresh-token.js
 *
 * Loads GOOGLE_OAUTH_CLIENT_ID/SECRET from the environment and .env.local.
 * The root defaults to GOOGLE_DRIVE_ROOT_FOLDER_ID. Without --read-only,
 * consent requests writable Drive access. Credentials are never accepted as
 * arguments or printed. After verification, an exclusive private backup is
 * retained in data\oauth-backups and .env.local is replaced atomically.
 * Open the printed localhost /connect URL yourself; authorization expires
 * after 15 minutes. No browser, database, or remote file is created or changed.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");

const PORT = 53682;
const HOST = "127.0.0.1";
const REDIRECT = `http://localhost:${PORT}/callback`;
const CONNECT_URL = `http://localhost:${PORT}/connect`;
const READ_ONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const WRITE_SCOPE = "https://www.googleapis.com/auth/drive";
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const RESPONSE_TIMEOUT_MS = 5 * 1000;
const ROOT_FIELDS = "name,mimeType,trashed,capabilities(canListChildren)";
const USAGE = "Usage: node scripts\\get-refresh-token.js [--read-only] [--root-folder <FOLDER_ID>]";
const DATABASE_GUIDANCE = "PostgreSQL connection settings were not changed. A different Drive root requires a separate PostgreSQL database or Neon branch and a matching dataset binding.";

class HelperError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function validateRoot(rootFolderId) {
  if (typeof rootFolderId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(rootFolderId)) {
    throw new HelperError("A valid root folder ID is required via --root-folder or GOOGLE_DRIVE_ROOT_FOLDER_ID.");
  }
  return rootFolderId;
}

function parseOptions(argv) {
  const options = { readOnly: false, rootFolderId: undefined, help: false };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { ...options, help: true };
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--read-only" && !options.readOnly) {
      options.readOnly = true;
    } else if (argv[i] === "--root-folder" && options.rootFolderId === undefined) {
      const rootFolderId = argv[++i];
      if (typeof rootFolderId !== "string" || rootFolderId.startsWith("--")) {
        throw new HelperError("--root-folder requires a folder ID, not another option.");
      }
      options.rootFolderId = validateRoot(rootFolderId);
    } else {
      throw new HelperError(`Unsupported arguments. Credentials must come from the environment. ${USAGE}`);
    }
  }
  return options;
}

function resolveRootFolder(rootFolderId, env) {
  return validateRoot(rootFolderId === undefined ? env.GOOGLE_DRIVE_ROOT_FOLDER_ID : rootFolderId);
}

function validToken(value) {
  return typeof value === "string" && value.length <= 8192 && /^[A-Za-z0-9._~+/-]+=*$/.test(value);
}

function readEnvSnapshot(cwd, filesystem = fs) {
  const filename = path.join(cwd, ".env.local");
  try {
    const stat = filesystem.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    const contents = filesystem.readFileSync(filename);
    if (!Buffer.from(contents.toString("utf8"), "utf8").equals(contents)) throw new Error();
    return contents;
  } catch {
    throw new HelperError("An existing, regular UTF-8 .env.local is required. No configuration was changed.");
  }
}

function updateEnvContents(contents, replacements) {
  const eol = contents.match(/\r\n|\n|\r/)?.[0] || "\n";
  const records = contents.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).filter(Boolean);
  const seen = new Set();
  let result = "";
  for (let i = 0; i < records.length; i++) {
    let record = records[i];
    const assignment = record.match(/^(\uFEFF?[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*(?:=[ \t]*|:[ \t]+))/);
    if (!assignment) {
      result += record;
      continue;
    }
    const [, prefix, key] = assignment;
    const start = prefix.length;
    const quote = record[start];
    let end = start;
    if (quote === '"' || quote === "'" || quote === "`") {
      end++;
      // Skip entire quoted values, including unrelated multiline assignments.
      while (true) {
        if (end >= record.length) {
          if (++i >= records.length) {
            throw new HelperError("Cannot safely update an unterminated quoted .env.local value. No configuration was changed.");
          }
          record += records[i];
          continue;
        }
        if (record[end] === "\\") {
          end += 2;
        } else if (record[end++] === quote) {
          break;
        }
      }
      if (!/^[ \t]*(?:#[^\r\n]*)?(?:\r\n|\r|\n)?$/.test(record.slice(end))) {
        throw new HelperError("Cannot safely update an ambiguous .env.local assignment. No configuration was changed.");
      }
    } else {
      const bare = record.slice(start).split(/[#\r\n]/, 1)[0];
      end += bare.trimEnd().length;
    }
    if (Object.hasOwn(replacements, key)) {
      result += prefix + replacements[key] + record.slice(end);
      seen.add(key);
    } else {
      result += record;
    }
  }
  const missing = Object.keys(replacements).filter((key) => !seen.has(key));
  if (missing.length) {
    if (result && !/[\r\n]$/.test(result)) result += eol;
    result += missing.map((key) => `${key}=${replacements[key]}`).join(eol) + eol;
  }
  return result;
}

function ensurePrivateDirectory(directory, filesystem) {
  try {
    filesystem.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = filesystem.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
}

function writeExclusive(filename, contents, filesystem) {
  let descriptor;
  let created = false;
  let complete = false;
  try {
    descriptor = filesystem.openSync(filename, "wx", 0o600);
    created = true;
    filesystem.writeFileSync(descriptor, contents);
    filesystem.fsyncSync(descriptor);
    filesystem.closeSync(descriptor);
    descriptor = undefined;
    complete = true;
  } finally {
    if (descriptor !== undefined) {
      try { filesystem.closeSync(descriptor); } catch { /* Keep the original failure. */ }
    }
    if (created && !complete) {
      try { filesystem.unlinkSync(filename); } catch { /* Never remove another file. */ }
    }
  }
}

function persistCredentials(
  { cwd, rootFolderId, readOnly, refreshToken, expectedContents, beforeCommit = () => {} },
  { filesystem = fs, randomId = randomUUID } = {},
) {
  let stagingPath;
  let staged = false;
  try {
    if (!validToken(refreshToken) || typeof readOnly !== "boolean") {
      throw new HelperError("Invalid OAuth credentials or mode. No configuration was changed.");
    }
    validateRoot(rootFolderId);
    const original = readEnvSnapshot(cwd, filesystem);
    if (expectedContents && !original.equals(expectedContents)) {
      throw new HelperError(".env.local changed while authorization was pending. Restart the helper; no configuration was changed.");
    }
    const updated = updateEnvContents(original.toString("utf8"), {
      GOOGLE_OAUTH_REFRESH_TOKEN: refreshToken,
      GOOGLE_DRIVE_ROOT_FOLDER_ID: rootFolderId,
      GOOGLE_DRIVE_READ_ONLY: String(readOnly),
      STORAGE_MODE: "drive",
    });
    const id = randomId();
    if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new Error();
    const dataDirectory = path.join(cwd, "data");
    const backupDirectory = path.join(dataDirectory, "oauth-backups");
    ensurePrivateDirectory(dataDirectory, filesystem);
    ensurePrivateDirectory(backupDirectory, filesystem);
    const backupPath = path.join(backupDirectory, `${id}.env.local`);
    writeExclusive(backupPath, original, filesystem);
    stagingPath = path.join(cwd, `.env.local.oauth-${id}.env.local`);
    writeExclusive(stagingPath, Buffer.from(updated, "utf8"), filesystem);
    staged = true;
    if (!readEnvSnapshot(cwd, filesystem).equals(original)) {
      throw new HelperError(".env.local changed during the update. It was not replaced; restart the helper.");
    }
    beforeCommit();
    // Same-directory rename is the commit point; never unlink the old config.
    filesystem.renameSync(stagingPath, path.join(cwd, ".env.local"));
    staged = false;
    return { backupPath };
  } catch (error) {
    if (error instanceof HelperError) throw error;
    throw new HelperError("OAuth configuration could not be saved safely. The original .env.local was not replaced.", 500);
  } finally {
    if (staged) {
      try { filesystem.unlinkSync(stagingPath); } catch { /* Preserve the original config and exclusive backup. */ }
    }
  }
}

function apiFailure(stage, error) {
  const candidate = error?.response?.status ?? error?.status ?? error?.code;
  const status = Number(candidate);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    const access = { 401: "authentication failed", 403: "access denied", 404: "not found or inaccessible" }[status];
    return new HelperError(`${stage} failed (HTTP ${status}${access ? `: ${access}` : ""}). No configuration was changed.`,
      status === 401 || status === 403 || status === 404 ? status : 502);
  }
  const timedOut = ["ETIMEDOUT", "ECONNABORTED", "ABORT_ERR"].includes(error?.code) || error?.name === "TimeoutError";
  return new HelperError(`${stage} ${timedOut ? "timed out" : "failed (network or service error)"}. No configuration was changed.`,
    timedOut ? 504 : 502);
}

function safeFolderName(name, sensitiveValues) {
  let safe = name;
  for (const value of sensitiveValues) {
    if (typeof value === "string" && value) safe = safe.replaceAll(value, "[redacted]");
  }
  return safe.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").slice(0, 160).trim() || "(unnamed folder)";
}

function matchesState(provided, expected) {
  if (typeof provided !== "string" || provided.length !== expected.length) return false;
  const received = Buffer.from(provided);
  const actual = Buffer.from(expected);
  return received.length === actual.length && timingSafeEqual(received, actual);
}

function respond(response, status, message, headers = {}) {
  if (response.destroyed || response.writableEnded) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => complete(true);
    const failed = () => complete(false);
    const closed = () => complete(response.writableFinished === true);
    const timer = setTimeout(() => {
      complete(false);
      response.destroy();
    }, RESPONSE_TIMEOUT_MS);
    function complete(flushed) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response.removeListener("finish", finish);
      response.removeListener("error", failed);
      response.removeListener("close", closed);
      resolve(flushed);
    }
    response.once("finish", finish);
    response.once("error", failed);
    response.once("close", closed);
    try {
      response.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        Connection: "close",
        ...headers,
      });
      response.end(message);
    } catch {
      complete(false);
    }
  });
}

function createOAuthSession({
  oauth2, drive, rootFolderId, readOnly = false, persist,
  logger = console, abortController = new AbortController(), sensitiveValues = [],
  timeoutMs = SESSION_TIMEOUT_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS,
}) {
  validateRoot(rootFolderId);
  const state = randomBytes(32).toString("base64url");
  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: false,
    scope: [readOnly ? READ_ONLY_SCOPE : WRITE_SCOPE],
    state,
  });
  const expiresAt = Date.now() + timeoutMs;
  let completed = false;
  let finishing = false;
  let processing = false;
  let committed = false;
  let activeResponse;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const deadline = setTimeout(() => { void stop("timeout"); }, timeoutMs);

  function complete(exitCode, message) {
    if (completed) return;
    completed = true;
    clearTimeout(deadline);
    abortController.abort();
    logger[exitCode === 0 ? "log" : "error"](message);
    resolveDone(exitCode);
  }

  async function fail(error) {
    if (completed || finishing) return;
    finishing = true;
    clearTimeout(deadline);
    abortController.abort(error);
    if (activeResponse) await respond(activeResponse, error.status, error.message);
    complete(1, error.message);
  }

  function stop(reason = "cancelled") {
    const messages = {
      timeout: "OAuth authorization timed out after the bounded waiting interval.",
      interrupted: "OAuth authorization was interrupted.",
      port: "The OAuth callback port 53682 is already in use.",
      server: "The loopback OAuth callback server failed.",
      cancelled: "OAuth authorization was cancelled.",
    };
    return fail(new HelperError(committed
      ? "Configuration was saved, but browser confirmation did not complete. Check configuration before retrying."
      : `${messages[reason] || messages.cancelled} No configuration was changed.`, reason === "timeout" ? 504 : 500));
  }

  function ensureActive() {
    if (completed || finishing || abortController.signal.aborted || Date.now() >= expiresAt) {
      throw new HelperError("OAuth authorization expired or was cancelled. No configuration was changed.", 504);
    }
  }

  async function request(stage, operation) {
    ensureActive();
    let timer;
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(abortController.signal.reason instanceof HelperError
        ? abortController.signal.reason
        : new HelperError(`${stage} was cancelled. No configuration was changed.`, 504));
      abortController.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        abortController.abort(new HelperError(`${stage} timed out. No configuration was changed.`, 504));
      }, Math.min(requestTimeoutMs, Math.max(1, expiresAt - Date.now())));
    });
    try {
      return await Promise.race([Promise.resolve().then(operation), cancelled]);
    } catch (error) {
      throw error instanceof HelperError ? error : apiFailure(stage, error);
    } finally {
      clearTimeout(timer);
      abortController.signal.removeEventListener("abort", onAbort);
    }
  }

  async function handleRequest(req, res) {
    if (req.method !== "GET") return respond(res, 405, "Only GET is supported.", { Allow: "GET" });
    if (![`localhost:${PORT}`, `${HOST}:${PORT}`].includes(req.headers?.host?.toLowerCase())) {
      return respond(res, 400, "Only the local OAuth callback host is accepted.");
    }
    let url;
    try {
      if (typeof req.url !== "string" || req.url.length > 8192 || !req.url.startsWith("/") || req.url.startsWith("//")) {
        throw new Error();
      }
      url = new URL(req.url, REDIRECT);
      if (url.hash || req.url.split("?")[0] !== url.pathname) throw new Error();
    } catch {
      return respond(res, 400, "Invalid local OAuth request.");
    }
    if (completed || finishing) return respond(res, 410, "This OAuth session has ended. Restart the helper.");
    if (url.pathname === "/health") return respond(res, 200, "OAUTH_READY\n");
    if (!["/connect", "/callback"].includes(url.pathname)) return respond(res, 404, "Not found.");
    if (processing) return respond(res, 409, "Authorization is already being processed.");
    if (url.pathname === "/connect") return respond(res, 302, "Continue in the Google account chooser.", { Location: authUrl });

    const states = url.searchParams.getAll("state");
    if (states.length !== 1 || !matchesState(states[0], state)) {
      return respond(res, 400, "Missing or invalid OAuth state. Start from the local /connect URL.");
    }
    const codes = url.searchParams.getAll("code");
    const errors = url.searchParams.getAll("error");
    if (errors.length) {
      if (errors.length !== 1 || codes.length) return respond(res, 400, "Invalid OAuth callback parameters.");
      activeResponse = res;
      return fail(new HelperError(errors[0] === "access_denied"
        ? "Google authorization was denied. No configuration was changed."
        : "Google authorization failed. No configuration was changed.", 403));
    }
    if (codes.length !== 1 || !codes[0].trim()) return respond(res, 400, "A single authorization code is required.");
    processing = true;
    activeResponse = res;
    try {
      const exchange = await request("OAuth token exchange", () => oauth2.getToken({ code: codes[0], redirect_uri: REDIRECT }));
      const tokens = exchange?.tokens;
      if (!validToken(tokens?.refresh_token) || !validToken(tokens?.access_token)) {
        throw new HelperError("Google did not return usable refresh and access tokens. Repeat consent from /connect in a new helper session. No configuration was changed.");
      }
      if (readOnly) {
        const info = await request("Granted-scope verification", () => oauth2.getTokenInfo(tokens.access_token));
        if (!Array.isArray(info?.scopes) || !info.scopes.length || !info.scopes.every((scope) => scope === READ_ONLY_SCOPE)) {
          throw new HelperError("Read-only verification failed: only drive.readonly may be granted, with no additional scopes. No configuration was changed.", 403);
        }
      }
      // Use only the verified access token; do not silently refresh to another grant.
      oauth2.setCredentials({ access_token: tokens.access_token });
      const metadata = await request("Root folder access check", () => drive.files.get({
        fileId: rootFolderId,
        fields: ROOT_FIELDS,
        supportsAllDrives: true,
      }, { timeout: requestTimeoutMs, retry: false, signal: abortController.signal }));
      const root = metadata?.data;
      if (root?.mimeType !== "application/vnd.google-apps.folder" || root?.trashed !== false) {
        throw new HelperError("The selected root is not a confirmed active Google Drive folder. No configuration was changed.", 403);
      }
      if (root.capabilities?.canListChildren !== true || typeof root.name !== "string" || !root.name.trim()) {
        throw new HelperError("The selected account could not confirm read access to the root folder's children. No configuration was changed.", 403);
      }
      const name = safeFolderName(root.name, [...sensitiveValues, tokens.access_token, tokens.refresh_token, codes[0], state]);
      ensureActive();
      persist({ rootFolderId, readOnly, refreshToken: tokens.refresh_token, beforeCommit: ensureActive });
      committed = true;
      clearTimeout(deadline);
      const message = `OAUTH_SUCCESS readOnly=${readOnly} root=${JSON.stringify(name)}. ${DATABASE_GUIDANCE}`;
      const flushed = await respond(res, 200, `${message}\nConfiguration saved. No Drive files were changed. Close this tab and return to the terminal.\n`);
      if (!finishing) complete(flushed ? 0 : 1, flushed ? message
        : "Configuration was saved, but browser confirmation could not be delivered. Check configuration before retrying.");
    } catch (error) {
      await fail(error instanceof HelperError ? error
        : new HelperError("OAuth account connection failed safely. No configuration was changed.", 500));
    }
  }

  return { handleRequest, done, stop };
}

function createGoogleClients(google, clientId, clientSecret, signal) {
  const oauth2 = new google.auth.OAuth2({
    clientId,
    clientSecret,
    redirectUri: REDIRECT,
    transporterOptions: { timeout: REQUEST_TIMEOUT_MS, retryConfig: { retry: 0 }, signal },
  });
  return { oauth2, drive: google.drive({ version: "v3", auth: oauth2 }) };
}

async function runServer(session, { createServer = http.createServer, logger = console, processEvents = process } = {}) {
  let server;
  const interrupted = () => { void session.stop("interrupted"); };
  try {
    server = createServer((req, res) => {
      session.handleRequest(req, res).catch(() => { void session.stop("server"); });
    });
    server.headersTimeout = 10 * 1000;
    server.requestTimeout = 10 * 1000;
    server.timeout = 3 * REQUEST_TIMEOUT_MS + RESPONSE_TIMEOUT_MS;
    server.keepAliveTimeout = 1000;
    server.maxConnections = 16;
    server.maxRequestsPerSocket = 8;
    processEvents.once("SIGINT", interrupted);
    processEvents.once("SIGTERM", interrupted);
    server.on("error", (error) => { void session.stop(error?.code === "EADDRINUSE" ? "port" : "server"); });
    server.listen(PORT, HOST, () => {
      logger.log(`Open ${CONNECT_URL} and select the Google account with access to the root folder.\nWaiting up to 15 minutes. No Drive files will be changed.`);
    });
    return await session.done;
  } catch {
    await session.stop("server");
    return await session.done;
  } finally {
    processEvents.removeListener("SIGINT", interrupted);
    processEvents.removeListener("SIGTERM", interrupted);
    if (server) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          server.closeAllConnections();
          resolve();
        }, RESPONSE_TIMEOUT_MS);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

async function main() {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      console.log(`${USAGE}\nCredentials are loaded privately from the environment and .env.local; never pass them as arguments.\n${DATABASE_GUIDANCE}`);
      return 0;
    }
    let envLoadFailed = false;
    // Next's default error logger can include file contents or parser errors.
    require("@next/env").loadEnvConfig(process.cwd(), false, {
      info() {},
      error() { envLoadFailed = true; },
    });
    if (envLoadFailed) throw new HelperError("Could not load the local environment safely. No configuration was changed.");
    const rootFolderId = resolveRootFolder(options.rootFolderId, process.env);
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId?.trim() || !clientSecret?.trim()) {
      throw new HelperError("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are required in the environment or .env.local.");
    }
    const cwd = process.cwd();
    const expectedContents = readEnvSnapshot(cwd);
    const abortController = new AbortController();
    const clients = createGoogleClients(require("googleapis").google, clientId, clientSecret, abortController.signal);
    const session = createOAuthSession({
      ...clients,
      rootFolderId,
      readOnly: options.readOnly,
      abortController,
      sensitiveValues: [clientId, clientSecret],
      persist: (settings) => persistCredentials({ ...settings, cwd, expectedContents }),
    });
    return await runServer(session);
  } catch (error) {
    console.error(error instanceof HelperError ? error.message : "OAuth helper failed safely. No credentials were displayed.");
    return 1;
  }
}

module.exports = {
  parseOptions, resolveRootFolder, updateEnvContents, persistCredentials,
  createOAuthSession, createGoogleClients, runServer,
  READ_ONLY_SCOPE, WRITE_SCOPE, REDIRECT, CONNECT_URL, REQUEST_TIMEOUT_MS, ROOT_FIELDS,
};

if (require.main === module) {
  main().then((exitCode) => { process.exitCode = exitCode; });
}

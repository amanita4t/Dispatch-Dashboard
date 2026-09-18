/* eslint-disable @typescript-eslint/no-require-imports -- Focused Node built-in tests use CommonJS. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const {
  parseOptions, resolveRootFolder, updateEnvContents, persistCredentials,
  createOAuthSession, createGoogleClients, runServer,
  READ_ONLY_SCOPE, WRITE_SCOPE, REDIRECT, CONNECT_URL, REQUEST_TIMEOUT_MS, ROOT_FIELDS,
} = require("../scripts/get-refresh-token.js");

const ROOT = "fixture_root_folder";
const ACCESS = "fixture-sensitive-access";
const REFRESH = "fixture-sensitive-refresh";
const CODE = "fixture-sensitive-code";
const CLIENT_SECRET = "fixture-sensitive-client-secret";
const AUTH_URL = "https://accounts.google.com/fixture?private=fixture-sensitive-auth-url";
const TOKENS = { access_token: ACCESS, refresh_token: REFRESH, scope: READ_ONLY_SCOPE };
const METADATA = {
  name: "Fixture root", mimeType: "application/vnd.google-apps.folder",
  trashed: false, capabilities: { canListChildren: true },
};

class Response extends EventEmitter {
  constructor(autoFlush = true) {
    super();
    this.autoFlush = autoFlush;
    this.writableEnded = false;
    this.writableFinished = false;
    this.destroyed = false;
    this.ended = new Promise((resolve) => { this.resolveEnded = resolve; });
  }
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
    return this;
  }
  end(body) {
    this.body = body;
    this.writableEnded = true;
    this.resolveEnded();
    if (this.autoFlush) queueMicrotask(() => this.flush());
    return this;
  }
  flush() {
    this.writableFinished = true;
    this.emit("finish");
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

function harness(t, overrides = {}) {
  const events = [];
  const output = [];
  const saved = [];
  let authorization;
  const oauth2 = {
    generateAuthUrl(options) { authorization = options; return AUTH_URL; },
    async getToken(options) {
      events.push(["token", options]);
      return { tokens: { ...TOKENS } };
    },
    async getTokenInfo(accessToken) {
      events.push(["tokeninfo", accessToken]);
      return { scopes: [READ_ONLY_SCOPE] };
    },
    setCredentials(credentials) { events.push(["credentials", credentials]); },
    ...overrides.oauth2,
  };
  const drive = { files: {
    async get(...args) { events.push(["root", ...args]); return { data: METADATA }; },
    ...overrides.files,
  } };
  const logger = {
    log(message) { output.push(message); },
    error(message) { output.push(message); },
  };
  const abortController = new AbortController();
  const session = createOAuthSession({
    oauth2, drive, logger, abortController, rootFolderId: ROOT, readOnly: true,
    sensitiveValues: [CLIENT_SECRET],
    persist(settings) { events.push(["persist"]); saved.push(settings); },
    ...overrides.session,
  });
  t.after(() => session.stop());
  const callback = (query = `code=${CODE}`) => `/callback?state=${authorization.state}&${query}`;
  const invoke = async (url, { method = "GET", host = "localhost:53682", response = new Response() } = {}) => {
    await session.handleRequest({ method, url, headers: { host } }, response);
    return response;
  };
  return { session, oauth2, drive, authorization, events, output, saved, logger, abortController, callback, invoke };
}

function assertPrivate(output) {
  const text = output.join("\n");
  for (const secret of [ACCESS, REFRESH, CODE, CLIENT_SECRET, AUTH_URL, "fixture-sensitive-http-error"]) {
    assert.equal(text.includes(secret), false, "Credentials, authorization URLs and raw errors must remain private");
  }
}

function fixture(t, contents = "# fixture configuration\nUNRELATED=keep\n") {
  const directory = path.resolve(__dirname, `.oauth-helper-fixture-${randomUUID()}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, ".env.local"), contents, { mode: 0o600 });
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(__dirname));
    assert.match(path.basename(directory), /^\.oauth-helper-fixture-[a-f0-9-]+$/);
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function settings(cwd, extra = {}) {
  return { cwd, rootFolderId: ROOT, readOnly: true, refreshToken: REFRESH, ...extra };
}

function backups(cwd) {
  const directory = path.join(cwd, "data", "oauth-backups");
  return fs.existsSync(directory) ? fs.readdirSync(directory).map((name) => path.join(directory, name)) : [];
}

test("options accept only flags, retain writable defaults, and resolve the root explicitly", () => {
  assert.deepEqual(parseOptions([]), { readOnly: false, rootFolderId: undefined, help: false });
  assert.deepEqual(parseOptions(["--root-folder", ROOT, "--read-only"]), { readOnly: true, rootFolderId: ROOT, help: false });
  assert.equal(parseOptions(["--help"]).help, true);
  assert.equal(resolveRootFolder(undefined, { GOOGLE_DRIVE_ROOT_FOLDER_ID: ROOT }), ROOT);
  assert.equal(resolveRootFolder(ROOT, { GOOGLE_DRIVE_ROOT_FOLDER_ID: "another_fixture" }), ROOT);
  assert.throws(() => resolveRootFolder(undefined, {}), /root folder ID is required/);
  for (const argv of [
    ["fixture-client-id", CLIENT_SECRET], ["--client-secret", CLIENT_SECRET],
    ["--unknown"], ["--read-only", "--read-only"], ["--root-folder"],
    ["--root-folder", "--read-only"], ["--read-only", "--root-folder", "--help"],
    ["--root-folder", ROOT, "--root-folder", ROOT], ["--root-folder", "https://drive.google.com/fixture"],
    ["--root-folder", "fixture\nSTORAGE_MODE=local"],
  ]) {
    assert.throws(() => parseOptions(argv), (error) => {
      assertPrivate([error.message]);
      return true;
    });
  }
});

test("health and connect expose only readiness and a stateful narrow account chooser", async (t) => {
  const h = harness(t);
  const health = await h.invoke("/health");
  assert.equal(health.status, 200);
  assert.equal(health.body, "OAUTH_READY\n");
  const connect = await h.invoke("/connect");
  assert.equal(connect.status, 302);
  assert.equal(connect.headers.Location, AUTH_URL);
  assert.equal(connect.headers["Cache-Control"], "no-store");
  assert.equal(connect.headers["Referrer-Policy"], "no-referrer");
  assert.deepEqual(h.authorization, {
    access_type: "offline", prompt: "consent select_account", include_granted_scopes: false,
    scope: [READ_ONLY_SCOPE], state: h.authorization.state,
  });
  assert.match(h.authorization.state, /^[A-Za-z0-9_-]{43}$/);
  const another = harness(t);
  assert.notEqual(h.authorization.state, another.authorization.state);
  assert.deepEqual(h.events, []);
  assertPrivate([...h.output, health.body, connect.body]);
});

test("wrong paths, methods, hosts, states, and malformed callbacks cannot exchange or persist", async (t) => {
  const h = harness(t);
  for (const [url, options, status] of [
    ["/other", {}, 404],
    [h.callback(), { method: "POST" }, 405],
    ["/connect", { method: "POST" }, 405],
    [h.callback(), { host: "untrusted.invalid:53682" }, 400],
    [`/callback?code=${CODE}`, {}, 400],
    [`/callback?state=wrong&code=${CODE}`, {}, 400],
    [`/callback?state=&code=${CODE}`, {}, 400],
    [`${h.callback()}&state=${h.authorization.state}`, {}, 400],
    [h.callback(""), {}, 400],
    [h.callback("code="), {}, 400],
    [h.callback(`code=${CODE}&code=second`), {}, 400],
    [h.callback(`code=${CODE}&error=access_denied`), {}, 400],
    ["/callback?state=wrong&error=access_denied", {}, 400],
    [`/wrong/../callback?state=${h.authorization.state}&code=${CODE}`, {}, 400],
    [`//untrusted.invalid/callback?state=${h.authorization.state}&code=${CODE}`, {}, 400],
  ]) {
    const response = await h.invoke(url, options);
    assert.equal(response.status, status);
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.saved, []);
    assertPrivate([...h.output, response.body]);
  }
  assert.equal((await h.invoke(h.callback())).status, 200, "Invalid attempts do not consume the legitimate state");
  assert.equal(await h.session.done, 0);
});

test("a valid denial is explicit, private, nonzero, and never saves credentials", async (t) => {
  const h = harness(t);
  const response = await h.invoke(h.callback(`error=access_denied&error_description=${CLIENT_SECRET}`));
  assert.equal(response.status, 403);
  assert.match(response.body, /authorization was denied/);
  assert.equal(await h.session.done, 1);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.saved, []);
  assertPrivate([...h.output, response.body]);
});

test("both tokens are required before tokeninfo, root metadata, or persistence", async (t) => {
  for (const tokens of [{ access_token: ACCESS }, { refresh_token: REFRESH }, { ...TOKENS, refresh_token: "bad\nVALUE=x" }]) {
    const h = harness(t, { oauth2: { async getToken() { return { tokens }; } } });
    const response = await h.invoke(h.callback());
    assert.equal(await h.session.done, 1);
    assert.match(response.body, /refresh and access tokens/);
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.saved, []);
    assertPrivate([...h.output, response.body]);
  }
});

test("read-only requires tokeninfo to confirm only the requested scope, not the exchange's scope field", async (t) => {
  for (const scopes of [
    undefined, [], READ_ONLY_SCOPE, [WRITE_SCOPE], [READ_ONLY_SCOPE, WRITE_SCOPE],
    [READ_ONLY_SCOPE, "https://www.googleapis.com/auth/drive.file"],
    [READ_ONLY_SCOPE, "https://www.googleapis.com/auth/drive.metadata"],
    [READ_ONLY_SCOPE, "https://www.googleapis.com/auth/drive.appdata"],
    [READ_ONLY_SCOPE, "https://www.googleapis.com/auth/drive.future-write-scope"],
    [READ_ONLY_SCOPE, "openid"],
  ]) {
    const h = harness(t, { oauth2: { async getTokenInfo() { return { scopes }; } } });
    const response = await h.invoke(h.callback());
    assert.equal(response.status, 403);
    assert.match(response.body, /only drive.readonly/);
    assert.equal(await h.session.done, 1);
    assert.deepEqual(h.events.map(([name]) => name), ["token"]);
    assert.deepEqual(h.saved, []);
    assertPrivate([...h.output, response.body]);
  }
});

test("token exchange and tokeninfo errors never disclose credential-bearing SDK errors", async (t) => {
  for (const method of ["getToken", "getTokenInfo"]) {
    const h = harness(t, { oauth2: { async [method]() {
      throw Object.assign(new Error(`fixture-sensitive-http-error ${CLIENT_SECRET} ${ACCESS}`), {
        response: { status: 400, config: { headers: { authorization: ACCESS }, data: CLIENT_SECRET } },
      });
    } } });
    const response = await h.invoke(h.callback());
    assert.match(response.body, /HTTP 400/);
    assert.equal(await h.session.done, 1);
    assert.equal(h.events.some(([name]) => name === "root"), false);
    assert.deepEqual(h.saved, []);
    assertPrivate([...h.output, response.body]);
  }
});

test("root HTTP and transport failures are distinguished without changing existing configuration", async (t) => {
  for (const [code, label, status] of [
    [401, /HTTP 401: authentication failed/, 401],
    [403, /HTTP 403: access denied/, 403],
    [404, /HTTP 404: not found or inaccessible/, 404],
    [503, /HTTP 503/, 502],
    ["ECONNREFUSED", /network or service error/, 502],
    ["ETIMEDOUT", /timed out/, 504],
  ]) {
    const cwd = fixture(t);
    const before = fs.readFileSync(path.join(cwd, ".env.local"));
    const h = harness(t, {
      files: { async get() {
        throw Object.assign(new Error(`fixture-sensitive-http-error ${REFRESH}`), {
          code, response: { status: typeof code === "number" ? code : undefined, config: { headers: { authorization: ACCESS } } },
        });
      } },
      session: { persist: (value) => persistCredentials({ ...value, cwd }) },
    });
    const response = await h.invoke(h.callback());
    assert.equal(response.status, status);
    assert.match(response.body, label);
    assert.match(h.output.join("\n"), label);
    assert.equal(await h.session.done, 1);
    assert.deepEqual(fs.readFileSync(path.join(cwd, ".env.local")), before);
    assert.deepEqual(backups(cwd), []);
    assertPrivate([...h.output, response.body]);
  }
});

test("root verification rejects nonfolders, Trash, missing metadata, and unreadable children", async (t) => {
  for (const data of [
    {}, { ...METADATA, mimeType: "text/plain" }, { ...METADATA, trashed: true },
    { ...METADATA, trashed: undefined }, { ...METADATA, capabilities: {} },
    { ...METADATA, capabilities: { canListChildren: false } }, { ...METADATA, name: undefined },
  ]) {
    const h = harness(t, { files: { async get() { return { data }; } } });
    const response = await h.invoke(h.callback());
    assert.equal(response.status, 403);
    assert.equal(await h.session.done, 1);
    assert.deepEqual(h.saved, []);
    assertPrivate([...h.output, response.body]);
  }
});

test("only verified metadata precedes private persistence, and success waits for HTTP flush", async (t) => {
  const h = harness(t, { files: { async get(...args) {
    h.events.push(["root", ...args]);
    return { data: { ...METADATA, name: `Fixture\n\u001b[31m<root>\u202e ${ACCESS} ${REFRESH} ${CODE} ${CLIENT_SECRET}` } };
  } } });
  const response = new Response(false);
  const handling = h.invoke(h.callback(), { response });
  await response.ended;
  assert.deepEqual(h.events.map(([name]) => name), ["token", "tokeninfo", "credentials", "root", "persist"]);
  assert.deepEqual(h.events[0][1], { code: CODE, redirect_uri: REDIRECT });
  assert.equal(h.events[1][1], ACCESS);
  assert.deepEqual(h.events[2][1], { access_token: ACCESS }, "Metadata must use the exact verified access token, without refresh");
  assert.deepEqual(h.events[3][1], { fileId: ROOT, fields: ROOT_FIELDS, supportsAllDrives: true });
  assert.equal(h.events[3][2].timeout, REQUEST_TIMEOUT_MS);
  assert.equal(h.events[3][2].retry, false);
  assert.equal(h.events[3][2].signal, h.abortController.signal);
  assert.equal(h.saved[0].refreshToken, REFRESH);
  assert.equal(h.saved[0].readOnly, true);
  assert.deepEqual(h.output, [], "Success cannot be printed before the response is flushed");
  let finished = false;
  h.session.done.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  response.flush();
  await handling;
  assert.equal(await h.session.done, 0);
  assert.equal(response.status, 200);
  assert.match(response.headers["Content-Type"], /^text\/plain/);
  assert.match(h.output[0], /^OAUTH_SUCCESS readOnly=true root=/);
  assert.match(h.output[0], /PostgreSQL connection settings were not changed/);
  assert.match(response.body, /separate PostgreSQL database or Neon branch/);
  assert.equal(/[\r\n\u001b\u202e]/.test(h.output[0]), false);
  assertPrivate([...h.output, response.body]);
  assert.equal((await h.invoke(h.callback())).status, 410);
  assert.equal(h.saved.length, 1);
});

test("writable consent remains available without bypassing the metadata check", async (t) => {
  const h = harness(t, { session: { readOnly: false } });
  assert.deepEqual(h.authorization.scope, [WRITE_SCOPE]);
  await h.invoke(h.callback());
  assert.equal(await h.session.done, 0);
  assert.deepEqual(h.events.map(([name]) => name), ["token", "credentials", "root", "persist"]);
  assert.equal(h.saved[0].readOnly, false);
  assert.match(h.output[0], /readOnly=false/);
});

test("concurrent callbacks cannot exchange a second code or save twice", async (t) => {
  let release;
  const exchange = new Promise((resolve) => { release = resolve; });
  const h = harness(t, { oauth2: { getToken() { return exchange; } } });
  const handling = h.invoke(h.callback());
  const duplicate = await h.invoke(h.callback("code=second"));
  assert.equal(duplicate.status, 409);
  release({ tokens: TOKENS });
  await handling;
  assert.equal(await h.session.done, 0);
  assert.equal(h.saved.length, 1);
});

test("bounded session and request timeouts close privately and cannot save a late exchange", async (t) => {
  const idle = harness(t, { session: { timeoutMs: 10 } });
  assert.equal(await idle.session.done, 1);
  assert.match(idle.output[0], /timed out/);
  assert.equal(idle.abortController.signal.aborted, true);
  assert.deepEqual(idle.saved, []);

  for (const [timeoutMs, requestTimeoutMs] of [[1000, 10], [10, 1000]]) {
    let release;
    const h = harness(t, {
      oauth2: { getToken() { return new Promise((resolve) => { release = resolve; }); } },
      session: { timeoutMs, requestTimeoutMs },
    });
    const response = await h.invoke(h.callback());
    assert.equal(await h.session.done, 1);
    assert.equal(response.status, 504);
    assert.match(response.body, /timed out/);
    release({ tokens: TOKENS });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.saved, []);
    assertPrivate([...h.output, response.body]);
  }
});

test("a disconnected success response is nonzero without claiming the saved config was unchanged", async (t) => {
  const h = harness(t);
  const response = new Response(false);
  const handling = h.invoke(h.callback(), { response });
  await response.ended;
  response.destroy();
  await handling;
  assert.equal(await h.session.done, 1);
  assert.equal(h.saved.length, 1);
  assert.match(h.output[0], /Configuration was saved.*confirmation could not be delivered/);
  assert.equal(h.output.join("").includes("OAUTH_SUCCESS"), false);
});

test("atomic persistence preserves unrelated bytes, CRLF, multiline values, and exclusive originals", (t) => {
  const original = "\uFEFF# fixture only\r\nGOOGLE_OAUTH_CLIENT_ID=fixture-client-id\r\n" +
    'DATABASE_URL="postgresql://fixture:fixture@localhost/existing?sslmode=require"\r\n' +
    'DATABASE_URL_UNPOOLED="postgresql://fixture:fixture@localhost/direct"\r\n' +
    'POSTGRES_URL="postgresql://fixture:fixture@localhost/alias"\r\n' +
    `GOOGLE_OAUTH_CLIENT_SECRET="${CLIENT_SECRET}"\r\n` +
    'UNRELATED="line one\r\nGOOGLE_OAUTH_REFRESH_TOKEN=not-an-assignment\r\nline three"\r\n' +
    'export GOOGLE_OAUTH_REFRESH_TOKEN = "old-fixture-token" # keep comment\r\n' +
    "GOOGLE_OAUTH_REFRESH_TOKEN=duplicate-fixture-token\r\nGOOGLE_DRIVE_ROOT_FOLDER_ID=old_fixture_root\r\n" +
    "GOOGLE_DRIVE_READ_ONLY=false\r\n" +
    'STORAGE_MODE = local # keep selection\r\nKEEP_LITERAL="a # b $HOME"\r\n# keep final comment';
  const cwd = fixture(t, original);
  fs.mkdirSync(path.join(cwd, "data"));
  fs.mkdirSync(path.join(cwd, "storage"));
  fs.writeFileSync(path.join(cwd, "data", "private-fixture.txt"), "untouched local data");
  fs.writeFileSync(path.join(cwd, "storage", "fixture.txt"), "untouched local document");
  const result = persistCredentials(settings(cwd, { expectedContents: Buffer.from(original) }));
  assert.deepEqual(Object.keys(result), ["backupPath"]);
  const expected = original
    .replace('"old-fixture-token"', REFRESH).replace("duplicate-fixture-token", REFRESH)
    .replace("old_fixture_root", ROOT).replace("READ_ONLY=false", "READ_ONLY=true")
    .replace("STORAGE_MODE = local", "STORAGE_MODE = drive");
  assert.equal(fs.readFileSync(path.join(cwd, ".env.local"), "utf8"), expected);
  assert.equal(backups(cwd).length, 1);
  assert.equal(fs.readFileSync(result.backupPath, "utf8"), original);
  assert.equal(path.dirname(result.backupPath), path.join(cwd, "data", "oauth-backups"));
  assert.match(path.basename(result.backupPath), /^[a-f0-9-]+\.env\.local$/);
  assert.equal(fs.readFileSync(path.join(cwd, "data", "private-fixture.txt"), "utf8"), "untouched local data");
  assert.equal(fs.readFileSync(path.join(cwd, "storage", "fixture.txt"), "utf8"), "untouched local document");
  assert.deepEqual(fs.readdirSync(path.join(cwd, "data")).sort(), ["oauth-backups", "private-fixture.txt"]);
  assert.deepEqual(fs.readdirSync(cwd).sort(), [".env.local", "data", "storage"]);
  const second = persistCredentials(settings(cwd, { refreshToken: "fixture-next-refresh", readOnly: false }));
  assert.equal(backups(cwd).length, 2);
  assert.equal(fs.readFileSync(result.backupPath, "utf8"), original);
  assert.equal(fs.readFileSync(second.backupPath, "utf8"), expected);
  assert.match(fs.readFileSync(path.join(cwd, ".env.local"), "utf8"), /GOOGLE_DRIVE_READ_ONLY=false/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(cwd, ".env.local")).mode & 0o777, 0o600);
  }
});

test("new keys append without removing unrelated contents or changing the line-ending style", (t) => {
  const cwd = fixture(t, "# fixture\r\nUNRELATED=keep");
  persistCredentials(settings(cwd));
  const updated = fs.readFileSync(path.join(cwd, ".env.local"), "utf8");
  assert.equal(updated, "# fixture\r\nUNRELATED=keep\r\n" +
    `GOOGLE_OAUTH_REFRESH_TOKEN=${REFRESH}\r\nGOOGLE_DRIVE_ROOT_FOLDER_ID=${ROOT}\r\n` +
    "GOOGLE_DRIVE_READ_ONLY=true\r\nSTORAGE_MODE=drive\r\n");
  assert.equal(updateEnvContents("", { STORAGE_MODE: "drive" }), "STORAGE_MODE=drive\n");
});

test("backup collision and rename failure never overwrite the original or an exclusive backup", (t) => {
  const cwd = fixture(t);
  const original = fs.readFileSync(path.join(cwd, ".env.local"));
  const randomId = () => "fixture-collision";
  const result = persistCredentials(settings(cwd), { randomId });
  const current = fs.readFileSync(path.join(cwd, ".env.local"));
  assert.throws(() => persistCredentials(settings(cwd, { refreshToken: "fixture-next-refresh" }), { randomId }), /not replaced/);
  assert.deepEqual(fs.readFileSync(path.join(cwd, ".env.local")), current);
  assert.deepEqual(fs.readFileSync(result.backupPath), original);
  assert.equal(backups(cwd).length, 1);
  const filesystem = { ...fs, renameSync() { throw new Error(`fixture-sensitive-http-error ${REFRESH}`); } };
  assert.throws(() => persistCredentials(settings(cwd), { filesystem }), (error) => {
    assert.match(error.message, /not replaced/);
    assertPrivate([error.message]);
    return true;
  });
  assert.deepEqual(fs.readFileSync(path.join(cwd, ".env.local")), current);
  assert.equal(backups(cwd).length, 2);
  assert.deepEqual(fs.readdirSync(cwd).sort(), [".env.local", "data"]);
});

test("partial private writes are cleaned without replacing config or leaving token staging files", (t) => {
  for (const failureAt of [1, 2]) {
    const cwd = fixture(t);
    const original = fs.readFileSync(path.join(cwd, ".env.local"));
    let writes = 0;
    const filesystem = { ...fs, writeFileSync(descriptor, contents) {
      if (++writes === failureAt) {
        fs.writeSync(descriptor, contents.subarray(0, 8));
        throw new Error(CLIENT_SECRET);
      }
      fs.writeFileSync(descriptor, contents);
    } };
    assert.throws(() => persistCredentials(settings(cwd), { filesystem }), /not replaced/);
    assert.deepEqual(fs.readFileSync(path.join(cwd, ".env.local")), original);
    assert.equal(backups(cwd).length, failureAt - 1);
    assert.deepEqual(fs.readdirSync(cwd).sort(), [".env.local", "data"]);
  }
});

test("changed config, unsafe token values, and ambiguous multiline env fail before replacement", (t) => {
  const cwd = fixture(t);
  const original = fs.readFileSync(path.join(cwd, ".env.local"));
  for (const extra of [
    { expectedContents: Buffer.from("different original") },
    { refreshToken: "bad\nSTORAGE_MODE=local" },
    { rootFolderId: "../escape" },
    { readOnly: "true" },
  ]) {
    assert.throws(() => persistCredentials(settings(cwd, extra)));
    assert.deepEqual(fs.readFileSync(path.join(cwd, ".env.local")), original);
    assert.deepEqual(backups(cwd), []);
  }
  assert.throws(() => updateEnvContents('UNRELATED="unterminated\nSTORAGE_MODE=local', { STORAGE_MODE: "drive" }), /unterminated/);
  const filesystem = { ...fs, writeFileSync(descriptor, contents) {
    fs.writeFileSync(descriptor, contents);
    fs.writeFileSync(path.join(cwd, ".env.local"), "# concurrent editor\nUNRELATED=new\n");
  } };
  assert.throws(() => persistCredentials(settings(cwd), { filesystem }), /changed during the update/);
  assert.equal(fs.readFileSync(path.join(cwd, ".env.local"), "utf8"), "# concurrent editor\nUNRELATED=new\n");
  assert.deepEqual(fs.readFileSync(backups(cwd)[0]), original);
  assert.deepEqual(fs.readdirSync(cwd).sort(), [".env.local", "data"]);
});

test("linked config and backup directories are rejected without writing through them", (t) => {
  const cwd = fixture(t);
  const original = fs.readFileSync(path.join(cwd, ".env.local"));
  const filename = path.join(cwd, ".env.local");
  const linkedConfig = { ...fs, lstatSync(target) {
    return target === filename
      ? { isFile: () => true, isSymbolicLink: () => true }
      : fs.lstatSync(target);
  } };
  assert.throws(() => persistCredentials(settings(cwd), { filesystem: linkedConfig }), /regular UTF-8 .env.local/);
  assert.deepEqual(backups(cwd), []);
  fs.mkdirSync(path.join(cwd, "data"));
  const linkedDirectory = { ...fs, lstatSync(target) {
    return target === path.join(cwd, "data")
      ? { isDirectory: () => true, isSymbolicLink: () => true }
      : fs.lstatSync(target);
  } };
  assert.throws(() => persistCredentials(settings(cwd), { filesystem: linkedDirectory }), /not replaced/);
  assert.deepEqual(fs.readFileSync(filename), original);
  assert.deepEqual(fs.readdirSync(path.join(cwd, "data")), []);
});

test("persistence failure reaches browser and terminal without claiming success", async (t) => {
  const cwd = fixture(t);
  const before = fs.readFileSync(path.join(cwd, ".env.local"));
  const h = harness(t, { session: { persist(value) {
    return persistCredentials({ ...value, cwd }, {
      filesystem: { ...fs, renameSync() { throw new Error(CLIENT_SECRET); } },
    });
  } } });
  const response = await h.invoke(h.callback());
  assert.equal(response.status, 500);
  assert.equal(await h.session.done, 1);
  assert.match(response.body, /original .env.local was not replaced/);
  assert.equal(h.output.join("").includes("OAUTH_SUCCESS"), false);
  assert.deepEqual(fs.readFileSync(path.join(cwd, ".env.local")), before);
  assertPrivate([...h.output, response.body]);
});

test("successful mocked OAuth privately persists only after narrow scope and root checks", async (t) => {
  const cwd = fixture(t);
  const original = fs.readFileSync(path.join(cwd, ".env.local"));
  const h = harness(t, { session: { persist(value) {
    assert.deepEqual(h.events.map(([name]) => name), ["token", "tokeninfo", "credentials", "root"]);
    persistCredentials({ ...value, cwd, expectedContents: original });
  } } });
  const response = await h.invoke(h.callback());
  assert.equal(await h.session.done, 0);
  assert.match(fs.readFileSync(path.join(cwd, ".env.local"), "utf8"), new RegExp(`GOOGLE_OAUTH_REFRESH_TOKEN=${REFRESH}`));
  assert.deepEqual(fs.readFileSync(backups(cwd)[0]), original);
  assertPrivate([...h.output, response.body]);
});

test("Google client configuration keeps the authorized redirect and bounds all credential requests", () => {
  const controller = new AbortController();
  let received;
  let driveOptions;
  class OAuth2 {
    constructor(options) { received = options; }
  }
  const google = { auth: { OAuth2 }, drive(options) { driveOptions = options; return { files: {} }; } };
  const clients = createGoogleClients(google, "fixture-client-id", CLIENT_SECRET, controller.signal);
  assert.equal(received.clientSecret, CLIENT_SECRET);
  assert.equal(received.redirectUri, "http://localhost:53682/callback");
  assert.equal(received.transporterOptions.timeout, REQUEST_TIMEOUT_MS);
  assert.equal(received.transporterOptions.retryConfig.retry, 0);
  assert.equal(received.transporterOptions.signal, controller.signal);
  assert.deepEqual(driveOptions, { version: "v3", auth: clients.oauth2 });
});

test("mocked server binds only loopback, logs only the local link, and closes after flushed success", async (t) => {
  const h = harness(t);
  const processEvents = new EventEmitter();
  let listenArguments;
  let closed = false;
  let handler;
  const server = new EventEmitter();
  server.listen = (port, host, callback) => { listenArguments = [port, host]; callback(); };
  server.close = (callback) => { closed = true; callback(); };
  server.closeAllConnections = () => assert.fail("A normally flushed response needs no forced close");
  const running = runServer(h.session, {
    createServer(callback) { handler = callback; return server; }, logger: h.logger, processEvents,
  });
  assert.deepEqual(listenArguments, [53682, "127.0.0.1"]);
  assert.match(h.output[0], new RegExp(CONNECT_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(server.headersTimeout > 0);
  assert.ok(server.requestTimeout > 0);
  assert.ok(server.timeout > 0);
  assert.equal(server.maxConnections, 16);
  assertPrivate(h.output);
  const response = new Response(false);
  handler({ method: "GET", url: h.callback(), headers: { host: "localhost:53682" } }, response);
  await response.ended;
  assert.equal(closed, false);
  response.flush();
  assert.equal(await running, 0);
  assert.equal(closed, true);
  assert.equal(processEvents.listenerCount("SIGINT"), 0);
  assert.equal(processEvents.listenerCount("SIGTERM"), 0);
});

test("mocked listen failure reports a private nonzero result and closes without real networking", async (t) => {
  const h = harness(t);
  const server = new EventEmitter();
  let closed = false;
  server.listen = () => server.emit("error", Object.assign(new Error(CLIENT_SECRET), { code: "EADDRINUSE" }));
  server.close = (callback) => { closed = true; callback(); };
  server.closeAllConnections = () => {};
  assert.equal(await runServer(h.session, {
    createServer: () => server, logger: h.logger, processEvents: new EventEmitter(),
  }), 1);
  assert.equal(closed, true);
  assert.match(h.output[0], /port 53682 is already in use/);
  assertPrivate(h.output);
});

test("synchronous mocked server startup failures cancel the deadline instead of waiting 15 minutes", async (t) => {
  for (const failureAt of ["create", "listen"]) {
    const h = harness(t);
    const processEvents = new EventEmitter();
    const server = new EventEmitter();
    let closed = false;
    server.listen = () => { throw new Error(CLIENT_SECRET); };
    server.close = (callback) => { closed = true; callback(); };
    server.closeAllConnections = () => {};
    const result = await runServer(h.session, {
      createServer() {
        if (failureAt === "create") throw new Error(CLIENT_SECRET);
        return server;
      },
      logger: h.logger, processEvents,
    });
    assert.equal(result, 1);
    assert.equal(h.abortController.signal.aborted, true);
    assert.equal(closed, failureAt === "listen");
    assert.equal(processEvents.listenerCount("SIGINT"), 0);
    assert.equal(processEvents.listenerCount("SIGTERM"), 0);
    assert.match(h.output[0], /loopback OAuth callback server failed/);
    assertPrivate(h.output);
  }
});

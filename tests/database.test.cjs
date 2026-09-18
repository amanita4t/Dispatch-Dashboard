require("./register.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { setTimeout: sleep } = require("node:timers/promises");
const { before, after, afterEach, test } = require("node:test");
const { startTestDatabase } = require("./postgres-helper.cjs");
const { migrateDatabase } = require("../scripts/db-migrate.cjs");

const project = path.resolve(__dirname, "..");
const originalCwd = process.cwd();
const envKeys = ["DATABASE_URL", "POSTGRES_URL", "STORAGE_MODE", "GOOGLE_DRIVE_ROOT_FOLDER_ID", "VERCEL"];
const oldEnvironment = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let fixture;
let db;
let withDataLock;
let lockDataKey;
let teardownStarted = false;

before(async () => {
  const started = await startTestDatabase();
  if (teardownStarted) {
    await started.close();
    return;
  }
  fixture = started;
  process.chdir(fixture.directory);
  process.env.DATABASE_URL = fixture.url;
  process.env.STORAGE_MODE = "local";
  delete process.env.POSTGRES_URL;
  delete process.env.VERCEL;
  db = require("../lib/db.ts").default;
  ({ withDataLock, lockDataKey } = require("../lib/mutation-lock.ts"));
}, { timeout: 120_000 });

afterEach(async () => {
  if (!fixture) return;
  process.env.DATABASE_URL = fixture.url;
  process.env.STORAGE_MODE = "local";
  delete process.env.POSTGRES_URL;
  delete process.env.VERCEL;
  await fixture.pool.query("DROP TRIGGER IF EXISTS fail_commit ON drivers; DROP TRIGGER IF EXISTS fail_commit ON loads; DROP FUNCTION IF EXISTS fail_commit(); TRUNCATE files, loads, drivers, sync_runs RESTART IDENTITY CASCADE");
  await fixture.pool.query("UPDATE dispatch_meta SET schema_version=1, storage_mode=$1, storage_root=$2", [fixture.binding.mode, fixture.binding.root]);
});

after(async () => {
  teardownStarted = true;
  try {
    if (db) await db.close();
  } finally {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(oldEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (fixture) await fixture.close();
  }
});

async function driver(name = "Fixture Driver") {
  return db.one("INSERT INTO drivers(name) VALUES ($1) RETURNING *", [name]);
}

async function load(driverId, number = "BOOK-1", type = "load") {
  return db.one(`INSERT INTO loads(load_number,load_type,driver_id,pickup_city,delivery_city,pickup_date,delivery_date,rate_amount)
    VALUES ($1,$2,$3,'Austin','Boston','','',1250.25) RETURNING *`, [number, type, driverId]);
}

function gate() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function postgresCommitProxy(url, { dropAcknowledgement = true, commitBarrier = 0 } = {}) {
  const target = new URL(url);
  const upstreamPort = Number(target.port);
  const sockets = new Set();
  const waiting = [];
  let releaseTimer;
  function releaseCommits() {
    clearTimeout(releaseTimer);
    for (const { upstream, frame } of waiting.splice(0)) {
      if (!upstream.destroyed) upstream.write(frame);
    }
  }
  const server = net.createServer((client) => {
    const upstream = net.createConnection({ host: target.hostname, port: upstreamPort });
    sockets.add(client);
    sockets.add(upstream);
    let startup = true;
    let pending = Buffer.alloc(0);
    let committing = false;
    client.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= (startup ? 4 : 5)) {
        const length = startup ? pending.readUInt32BE(0) : pending.readUInt32BE(1) + 1;
        if (pending.length < length) break;
        const frame = pending.subarray(0, length);
        pending = pending.subarray(length);
        if (!startup && frame[0] === 81 && frame.toString("utf8", 5, length - 1) === "COMMIT") {
          committing = true;
          if (commitBarrier) {
            waiting.push({ upstream, frame });
            if (waiting.length === commitBarrier) releaseCommits();
            else releaseTimer = setTimeout(releaseCommits, 1_500);
            continue;
          }
        }
        startup = false;
        upstream.write(frame);
      }
    });
    upstream.on("data", (chunk) => {
      if (committing && dropAcknowledgement) {
        client.destroy();
        upstream.end();
      } else {
        client.write(chunk);
      }
    });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => { sockets.delete(client); upstream.destroy(); });
    upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  target.port = String(server.address().port);
  return {
    url: target.href,
    async close() {
      clearTimeout(releaseTimer);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("importing the database module is lazy and never requires a database URL", async () => {
  const environment = { ...process.env };
  for (const key of ["DATABASE_URL", "POSTGRES_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING"]) delete environment[key];
  const script = `require(${JSON.stringify(path.join(__dirname, "register.cjs"))}); require(${JSON.stringify(path.join(project, "lib", "db.ts"))}); console.log("lazy import ok");`;
  const result = await promisify(execFile)(process.execPath, ["-e", script], { cwd: fixture.directory, env: environment });
  assert.match(result.stdout, /lazy import ok/);
});

test("real PostgreSQL rows preserve numeric JSON fields, text timestamps, blank dates, and nullable archive state", async () => {
  const owner = await driver();
  const item = await load(owner.id);
  const document = await db.one(`INSERT INTO files(load_id,category,filename,storage_ref,size,uploaded_at)
    VALUES ($1,'rate_confirmation','rate.pdf','drive-document-id',$2,$3) RETURNING *`,
  [item.id, Number.MAX_SAFE_INTEGER, "2026-09-01T13:00:00.000Z"]);
  assert.equal(typeof owner.id, "number");
  assert.equal(typeof item.rate_amount, "number");
  assert.equal(document.size, Number.MAX_SAFE_INTEGER);
  assert.equal(typeof document.id, "number");
  assert.equal(item.pickup_date, "");
  assert.equal(item.invoice_due_date, "");
  assert.equal(item.archived_at, null);
  assert.match(owner.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(document.uploaded_at, "2026-09-01T13:00:00.000Z");
  assert.equal(await db.one("SELECT id FROM drivers WHERE id = $1", [-99]), undefined);
  assert.equal((await db.query("SELECT $1::int AS n", [7])).rows[0].n, 7);
});

test("real constraints enforce scoped bookings, enums, foreign keys, exact sizes, and unique nonempty document references", async () => {
  const owner = await driver();
  const item = await load(owner.id);
  await load(owner.id, item.load_number, "loadout");
  await assert.rejects(load(owner.id), { code: "23505" });
  await assert.rejects(load(-100, "bad-driver"), { code: "23503" });
  await assert.rejects(db.query("UPDATE loads SET status='unknown' WHERE id=$1", [item.id]), { code: "23514" });
  await assert.rejects(db.query("UPDATE loads SET load_type='unknown' WHERE id=$1", [item.id]), { code: "23514" });
  await assert.rejects(db.query("UPDATE loads SET rate_amount='Infinity' WHERE id=$1", [item.id]), { code: "23514" });
  const insertFile = (ref, size = 1, category = "other") => db.query(
    "INSERT INTO files(load_id,category,filename,storage_ref,size) VALUES ($1,$2,'file.pdf',$3,$4)",
    [item.id, category, ref, size]
  );
  await insertFile("unique-drive-id");
  await assert.rejects(insertFile("unique-drive-id"), { code: "23505" });
  await assert.rejects(insertFile("wrong-category", 1, "unknown"), { code: "23514" });
  await assert.rejects(insertFile("too-large", Number.MAX_SAFE_INTEGER + 1), { code: "23514" });
  await assert.rejects(insertFile("fractional", 1.5), { code: "23514" });
  await assert.rejects(db.query("DELETE FROM drivers WHERE id=$1", [owner.id]), { code: "23503" });
  await db.query("DELETE FROM loads WHERE id=$1", [item.id]);
  assert.equal((await db.one("SELECT count(*)::int AS n FROM files")).n, 0);
});

test("outer transactions undo SQL work before awaiting compensations in reverse order", async () => {
  const events = [];
  const original = new Error("business operation failed");
  await assert.rejects(db.transaction(async () => {
    await driver();
    db.onRollback(async () => {
      assert.equal((await fixture.pool.query("SELECT count(*)::int AS n FROM drivers")).rows[0].n, 0);
      events.push("first");
    });
    db.onRollback(async () => {
      await sleep(5);
      events.push("second");
    });
    throw original;
  }), (error) => error === original);
  assert.deepEqual(events, ["second", "first"]);
  assert.throws(() => db.onRollback(async () => {}), /active database transaction/);
});

test("nested savepoints recover a failed item without poisoning the remaining batch", async () => {
  const callbacks = [];
  const result = await db.transaction(async () => {
    await driver("before");
    db.onRollback(async () => { callbacks.push("outer"); });
    await assert.rejects(db.transaction(async () => {
      await driver("failed-item");
      db.onRollback(async () => {
        assert.equal((await db.one("SELECT count(*)::int AS n FROM drivers WHERE name='failed-item'")).n, 0);
        assert.equal((await db.one("SELECT count(*)::int AS n FROM drivers WHERE name='before'")).n, 1);
        callbacks.push("failed");
      });
      await driver("before");
    }), { code: "23505" });
    await db.transaction(async () => {
      await driver("after");
      db.onRollback(async () => { callbacks.push("successful-inner"); });
    });
    return "committed";
  });
  assert.equal(result, "committed");
  assert.deepEqual(callbacks, ["failed"]);
  assert.deepEqual((await db.all("SELECT name FROM drivers ORDER BY name")).map((row) => row.name), ["after", "before"]);
});

test("successful nested callbacks are retained for an outer rollback, while failed nested callbacks are not repeated", async () => {
  const callbacks = [];
  await assert.rejects(db.transaction(async () => {
    db.onRollback(async () => { callbacks.push("outer"); });
    await assert.rejects(db.transaction(async () => {
      db.onRollback(async () => { callbacks.push("failed"); });
      throw new Error("item failed");
    }), /item failed/);
    await db.transaction(async () => {
      await driver();
      db.onRollback(async () => { callbacks.push("successful"); });
    });
    throw new Error("batch failed");
  }), /batch failed/);
  assert.deepEqual(callbacks, ["failed", "successful", "outer"]);
  assert.equal((await db.one("SELECT count(*)::int AS n FROM drivers")).n, 0);
});

test("swallowing a SQL failure cannot silently report a rolled-back transaction as committed", async () => {
  let compensated = false;
  await assert.rejects(db.transaction(async () => {
    await driver();
    db.onRollback(async () => { compensated = true; });
    await assert.rejects(driver(), { code: "23505" });
    return "not actually saved";
  }), { code: "23505" });
  assert.equal(compensated, true);
  assert.equal((await db.one("SELECT count(*)::int AS n FROM drivers")).n, 0);
});

test("callback failures surface alongside the original cause and do not skip other callbacks", async () => {
  const cause = new Error("original failure");
  const cleanup = new Error("cleanup failure");
  const callbacks = [];
  await assert.rejects(db.transaction(async () => {
    db.onRollback(async () => { callbacks.push("last cleanup"); });
    db.onRollback(async () => { throw cleanup; });
    throw cause;
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, cause);
    assert.deepEqual(error.errors, [cause, cleanup]);
    assert.match(error.message, /recovery/);
    return true;
  });
  assert.deepEqual(callbacks, ["last cleanup"]);
});

test("rollback callbacks can query PostgreSQL even when every pooled client was in a failing transaction", { timeout: 10_000 }, async () => {
  const allEntered = gate();
  const release = gate();
  let entered = 0;
  let callbacks = 0;
  const outcomes = Array.from({ length: 5 }, (_, index) => db.transaction(async () => {
    await driver(`rollback-pool-${index}`);
    db.onRollback(async () => {
      assert.equal((await db.one("SELECT 1::int AS n")).n, 1);
      callbacks++;
    });
    if (++entered === 5) allEntered.resolve();
    await release.promise;
    throw new Error("expected pool rollback");
  }).then(() => assert.fail("transaction should fail"), (error) => assert.match(error.message, /expected pool rollback/)));
  await allEntered.promise;
  release.resolve();
  await Promise.all(outcomes);
  assert.equal(callbacks, 5);
});

test("deferred PostgreSQL constraints are checked before final COMMIT and storage compensation", async () => {
  await fixture.pool.query(`CREATE FUNCTION fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'forced deferred constraint failure' USING ERRCODE='23514'; END $$;
    CREATE CONSTRAINT TRIGGER fail_commit AFTER INSERT ON drivers DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fail_commit()`);
  let bodyFinished = false;
  let compensated = false;
  await assert.rejects(db.transaction(async () => {
    await driver();
    db.onRollback(async () => {
      assert.equal((await fixture.pool.query("SELECT count(*)::int AS n FROM drivers")).rows[0].n, 0);
      compensated = true;
    });
    bodyFinished = true;
    return "action returned before COMMIT";
  }), { code: "23514" });
  assert.equal(bodyFinished, true);
  assert.equal(compensated, true);
});

test("a lost real COMMIT acknowledgement retains committed records and their documents", { timeout: 15_000 }, async () => {
  await db.close();
  const proxy = await postgresCommitProxy(fixture.url);
  process.env.DATABASE_URL = proxy.url;
  const document = path.join(fixture.directory, "unconfirmed-commit-document.txt");
  let compensated = false;
  try {
    await assert.rejects(db.transaction(async () => {
      await driver();
      fs.writeFileSync(document, "retain this committed document");
      db.onRollback(async () => {
        compensated = true;
        fs.rmSync(document);
      });
    }), (error) => error.status === 503 && /commit outcome could not be confirmed/.test(error.message) && /retained for recovery/.test(error.message));
    assert.equal(compensated, false);
    assert.equal(fs.readFileSync(document, "utf8"), "retain this committed document");
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS n FROM drivers")).rows[0].n, 1);
  } finally {
    await db.close();
    await proxy.close();
    process.env.DATABASE_URL = fixture.url;
    fs.rmSync(document, { force: true });
  }
});

test("a real serialization rejection at final COMMIT retains storage after its guards have ended", { timeout: 20_000 }, async () => {
  await db.close();
  await fixture.pool.query("ALTER DATABASE dispatch_test SET default_transaction_isolation='serializable'");
  const owners = (await fixture.pool.query("INSERT INTO drivers(name,phone) VALUES ('First SSI driver','on'),('Second SSI driver','on') RETURNING id")).rows;
  const proxy = await postgresCommitProxy(fixture.url, { dropAcknowledgement: false, commitBarrier: 2 });
  process.env.DATABASE_URL = proxy.url;
  const documents = owners.map((owner) => path.join(fixture.directory, `serialization-document-${owner.id}.txt`));
  const compensated = [false, false];
  const updated = gate();
  let updates = 0;
  try {
    const outcomes = await Promise.all(owners.map((owner, index) => db.transaction(async () => {
      await lockDataKey(`serializable-driver:${owner.id}`);
      assert.equal((await db.one("SELECT count(*)::int AS n FROM drivers WHERE phone='on'")).n, 2);
      fs.writeFileSync(documents[index], "retain this operation's document");
      db.onRollback(async () => {
        compensated[index] = true;
        fs.rmSync(documents[index]);
      });
      await db.query("UPDATE drivers SET phone='off' WHERE id=$1", [owner.id]);
      if (++updates === 2) updated.resolve();
      await updated.promise;
    }).then(() => ({ ok: true }), (error) => { updated.resolve(); return { error }; })));
    assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
    const failure = outcomes.find((outcome) => outcome.error).error;
    assert.equal(failure.status, 503);
    assert.equal(failure.cause.code, "40001");
    assert.match(failure.message, /final commit after mutation guards ended/);
    assert.deepEqual(compensated, [false, false]);
    assert.ok(documents.every((document) => fs.existsSync(document)));
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS n FROM drivers WHERE phone='on'")).rows[0].n, 1);
  } finally {
    await db.close();
    await proxy.close();
    process.env.DATABASE_URL = fixture.url;
    await fixture.pool.query("ALTER DATABASE dispatch_test RESET default_transaction_isolation");
    for (const document of documents) fs.rmSync(document, { force: true });
  }
});

for (const scenario of [
  { title: "predeclared guards survive business failure cleanup", dynamic: false, failure: "business" },
  { title: "outer load guards survive nested business failure cleanup", dynamic: true, failure: "business" },
  { title: "outer load guards survive nested immediate SQL failure cleanup", dynamic: true, failure: "sql" },
  { title: "outer load guards survive nested deferred constraint failure cleanup", dynamic: true, failure: "deferred" },
  { title: "exclusive roster guards survive SQL failure cleanup", dynamic: false, failure: "sql", roster: true },
  { title: "failed physical cleanup still finishes before guards are released", dynamic: true, failure: "business", cleanupFails: true },
]) {
  test(scenario.title, { timeout: 15_000 }, async () => {
    const owner = await driver();
    const item = await load(owner.id);
    const originalFolder = path.join(fixture.directory, "storage", `original-${scenario.failure}-${scenario.dynamic}-${scenario.cleanupFails ?? false}`);
    const movedFolder = originalFolder + "-moved";
    fs.mkdirSync(originalFolder, { recursive: true });
    fs.writeFileSync(path.join(originalFolder, "document.txt"), "original document");
    await db.query("UPDATE loads SET folder_ref=$1 WHERE id=$2", [originalFolder, item.id]);
    if (scenario.failure !== "business") {
      await fixture.pool.query(`CREATE FUNCTION fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'forced move constraint failure' USING ERRCODE='23514'; END $$`);
      await fixture.pool.query(scenario.failure === "deferred"
        ? "CREATE CONSTRAINT TRIGGER fail_commit AFTER UPDATE ON loads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_commit()"
        : "CREATE TRIGGER fail_commit BEFORE UPDATE ON loads FOR EACH ROW EXECUTE FUNCTION fail_commit()");
    }
    const cleanupStarted = gate();
    const finishCleanup = gate();
    const key = `load:${item.id}`;
    let otherMutationEntered = false;
    let remainingCleanup = false;
    const outcome = withDataLock(async () => {
      if (scenario.dynamic) await lockDataKey(`storage-driver:${owner.id}`);
      fs.renameSync(originalFolder, movedFolder);
      db.onRollback(async () => { remainingCleanup = true; });
      db.onRollback(async () => {
        cleanupStarted.resolve();
        await finishCleanup.promise;
        fs.renameSync(movedFolder, originalFolder);
        if (scenario.cleanupFails) throw new Error("forced cleanup failure");
      });
      await db.query("UPDATE loads SET folder_ref=$1 WHERE id=$2", [movedFolder, item.id]);
      if (scenario.failure === "business") throw new Error("forced business failure");
    }, { keys: [key], drivers: scenario.roster ? "exclusive" : "shared" })
      .then(() => ({ ok: true }), (error) => ({ error }));
    try {
      await cleanupStarted.promise;
      assert.equal(fs.existsSync(originalFolder), false);
      await assert.rejects(withDataLock(async () => { otherMutationEntered = true; }, { keys: [key] }), (error) => error.status === 409);
      assert.equal(otherMutationEntered, false);
      assert.equal((await db.one("SELECT folder_ref FROM loads WHERE id=$1", [item.id])).folder_ref, originalFolder);
      if (scenario.roster) {
        await assert.rejects(withDataLock(async () => {}, { keys: ["load:unrelated"] }), (error) => error.status === 409);
      } else {
        assert.equal(await withDataLock(async () => "unrelated mutation completed", { keys: ["load:unrelated"] }), "unrelated mutation completed");
      }
    } finally {
      finishCleanup.resolve();
    }
    const { error } = await outcome;
    assert.ok(error);
    if (scenario.cleanupFails) {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /forced cleanup failure/);
      assert.match(error.cause.message, /forced business failure/);
    } else if (scenario.failure === "sql") {
      assert.equal(error.code, "23514");
    } else if (scenario.failure === "deferred") {
      assert.equal(error.code, "23514");
    } else {
      assert.match(error.message, /forced business failure/);
    }
    assert.equal(remainingCleanup, true);
    assert.equal(fs.readFileSync(path.join(originalFolder, "document.txt"), "utf8"), "original document");
    assert.equal((await db.one("SELECT folder_ref FROM loads WHERE id=$1", [item.id])).folder_ref, originalFolder);
    assert.equal(await withDataLock(async () => "guard released", { keys: [key] }), "guard released");
  });
}

test("nested storage rollback uses ancestor guards while SQL-only item failures remain isolated", async () => {
  let compensated = false;
  await assert.rejects(withDataLock(async () => {
    await db.transaction(async () => {
      await lockDataKey("nested-only-storage");
      db.onRollback(async () => { compensated = true; });
      await db.query("SELECT 1/0");
    });
  }, { keys: ["nested-only-storage"] }), { code: "22012" });
  assert.equal(compensated, true);
  await withDataLock(async () => {
    await assert.rejects(db.transaction(async () => {
      await lockDataKey("sql-only-item");
      await driver();
      await db.query("SELECT 1/0");
    }), { code: "22012" });
    await db.transaction(async () => {
      await lockDataKey("next-item");
      await driver("next item saved");
    });
  });
  assert.equal((await db.one("SELECT count(*)::int AS n FROM drivers")).n, 1);
});

test("separately loaded route bundles share the same pool and async transaction context", async () => {
  const modulePath = require.resolve("../lib/db.ts");
  delete require.cache[modulePath];
  const anotherBundle = require(modulePath).default;
  await assert.rejects(db.transaction(async () => {
    await driver();
    const first = await db.one("SELECT pg_backend_pid() AS pid");
    const second = await anotherBundle.one("SELECT pg_backend_pid() AS pid");
    assert.equal(first.pid, second.pid);
    assert.equal((await anotherBundle.one("SELECT count(*)::int AS n FROM drivers")).n, 1);
    throw new Error("rollback both modules");
  }), /rollback both modules/);
  assert.equal((await anotherBundle.one("SELECT count(*)::int AS n FROM drivers")).n, 0);
});

test("conflicting keys fail promptly across clients while reads and unrelated loads proceed", { timeout: 10_000 }, async () => {
  const entered = gate();
  const release = gate();
  const first = withDataLock(async () => {
    entered.resolve();
    await release.promise;
  }, { keys: ["load:1"] });
  await entered.promise;
  try {
    assert.equal((await db.one("SELECT 42::int AS answer")).answer, 42);
    assert.equal(await withDataLock(async () => "unrelated completed", { keys: ["load:2"] }), "unrelated completed");
    const start = Date.now();
    await assert.rejects(withDataLock(async () => {}, { keys: ["load:1"] }), (error) => error.status === 409 && /retry/i.test(error.message));
    assert.ok(Date.now() - start < 2_000);
    await assert.rejects(withDataLock(async () => {}, { drivers: "exclusive" }), (error) => error.status === 409);
    await assert.rejects(migrateDatabase({ url: fixture.url, binding: fixture.binding }), /currently being updated/);
  } finally {
    release.resolve();
    await first;
  }
  assert.equal(await withDataLock(async () => "roster saved", { drivers: "exclusive" }), "roster saved");
});

test("the dataset advisory lock excludes migrations, not ordinary readers", async () => {
  const client = await fixture.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('dispatch:dataset', 0))");
    await assert.rejects(withDataLock(async () => {}), (error) => error.status === 409);
    assert.equal((await db.one("SELECT 1::int AS n")).n, 1);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  await assert.rejects(lockDataKey("load:1"), /active transaction/);
  await withDataLock(async () => {
    await lockDataKey("additional-key");
    await lockDataKey("additional-key");
  }, { keys: ["z", "a", "z"] });
});

test("every connection rechecks storage root, storage mode, and schema version without caching old settings", async () => {
  assert.equal((await db.one("SELECT 1::int AS n")).n, 1);
  process.env.STORAGE_MODE = "drive";
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = "another-drive-root";
  await assert.rejects(db.one("SELECT 1"), (error) => error.status === 503 && /different storage dataset/.test(error.message));
  await assert.rejects(db.transaction(async () => {}), (error) => error.status === 503);
  process.env.STORAGE_MODE = "local";
  await fixture.pool.query("UPDATE dispatch_meta SET storage_root=$1", [fixture.storageRoot + "-other"]);
  await assert.rejects(db.one("SELECT 1"), (error) => error.status === 503);
  await fixture.pool.query("UPDATE dispatch_meta SET storage_root=$1, schema_version=2", [fixture.storageRoot]);
  await assert.rejects(db.transaction(async () => {}), (error) => error.status === 503 && /incompatible/.test(error.message));
});

test("missing configuration and missing schema produce safe 503 guidance without runtime DDL", async () => {
  delete process.env.DATABASE_URL;
  await assert.rejects(db.one("SELECT 1"), (error) => error.status === 503 && /Set DATABASE_URL/.test(error.message));
  process.env.DATABASE_URL = "https://private-user:private-password@example.invalid/database";
  await assert.rejects(db.one("SELECT 1"), (error) => error.status === 503 && !error.message.includes("private-password"));
  process.env.DATABASE_URL = fixture.url;
  await fixture.pool.query("ALTER TABLE dispatch_meta RENAME TO saved_dispatch_meta");
  try {
    await assert.rejects(db.one("SELECT 1"), (error) => error.status === 503 && /migration command/.test(error.message));
    assert.equal((await fixture.pool.query("SELECT to_regclass('public.dispatch_meta') AS name")).rows[0].name, null);
  } finally {
    await fixture.pool.query("ALTER TABLE saved_dispatch_meta RENAME TO dispatch_meta");
  }
});

import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import { RequestError } from "./api";
import { getDatabaseUrl, getStorageBinding } from "./config";
import { errorMessage } from "./errors";

type StorageBinding = ReturnType<typeof getStorageBinding>;
type RollbackAction = () => Promise<void>;

interface TransactionContext {
  client: PoolClient;
  binding: StorageBinding;
  callbacks: RollbackAction[];
  guards: Set<string>;
  parent?: TransactionContext;
  active: boolean;
  childActive: boolean;
  compensating?: boolean;
  statementError?: unknown;
  root: { savepoint: number; workpointActive: boolean; rollbackOnly?: unknown; retainArtifacts?: boolean };
}

interface SharedDatabase {
  pool?: Pool;
  url?: string;
  transactions: AsyncLocalStorage<TransactionContext>;
}

const globalDatabase = globalThis as typeof globalThis & { dispatchPostgres?: SharedDatabase };
const shared = globalDatabase.dispatchPostgres ??= {
  transactions: new AsyncLocalStorage<TransactionContext>(),
};
const workpoint = "dispatch_work";

function requestError(message: string, cause?: unknown): RequestError {
  return Object.assign(new RequestError(message, 503), { cause });
}

function sqlState(error: unknown): string | undefined {
  // Transport codes such as EPIPE also have five letters; only server errors carry severity.
  if (typeof error !== "object" || error === null || !("code" in error) || !("severity" in error)) return undefined;
  if (typeof error.severity !== "string" || !error.severity) return undefined;
  return typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : undefined;
}

function databasePool(): Pool {
  let url: string;
  try {
    url = getDatabaseUrl();
  } catch (error) {
    throw requestError(
      "PostgreSQL is not configured. Set DATABASE_URL (or POSTGRES_URL), then run the database migration command before starting the app.",
      error
    );
  }
  if (shared.pool && shared.url !== url) {
    throw requestError("The database configuration changed. Restart the application before accessing another dataset.");
  }
  if (!shared.pool) {
    const pool = new Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 5_000,
      application_name: "dispatch-dashboard",
    });
    pool.on("connect", (client) => {
      client.on("error", () => {
        // Queries reject separately; pg-pool handles this event only while the client is idle.
      });
    });
    pool.on("error", (error) => {
      console.error("PostgreSQL pool connection error.", { code: sqlState(error) ?? "CONNECTION_ERROR" });
    });
    attachDatabasePool(pool);
    shared.url = url;
    shared.pool = pool;
  }
  return shared.pool;
}

function configuredBinding(): StorageBinding {
  try {
    return getStorageBinding();
  } catch (error) {
    throw requestError("The storage dataset is not configured correctly. Check STORAGE_MODE and its storage root.", error);
  }
}

function requireMatchingBinding(actual: StorageBinding, expected: StorageBinding): void {
  if (actual.mode !== expected.mode || actual.root !== expected.root) {
    throw requestError(
      "This PostgreSQL database belongs to a different storage dataset. Restore the matching storage mode/root or use a separate, explicitly migrated database."
    );
  }
}

async function verifyBinding(client: PoolClient, binding: StorageBinding): Promise<void> {
  let result: QueryResult<{ schema_version: number; storage_mode: StorageBinding["mode"]; storage_root: string }>;
  try {
    result = await client.query(
      "SELECT schema_version, storage_mode, storage_root FROM public.dispatch_meta WHERE singleton = TRUE"
    );
  } catch (error) {
    if (sqlState(error) === "42P01" || sqlState(error) === "42703") {
      throw requestError("The PostgreSQL schema is not initialized. Run the database migration command explicitly before using the app.", error);
    }
    throw error;
  }
  if (result.rows.length !== 1 || result.rows[0].schema_version !== 1) {
    throw requestError("This PostgreSQL schema is missing or incompatible. Run the matching database migration command before using the app.");
  }
  requireMatchingBinding({ mode: result.rows[0].storage_mode, root: result.rows[0].storage_root }, binding);
}

async function connect(): Promise<PoolClient> {
  const pool = databasePool();
  try {
    return await pool.connect();
  } catch (error) {
    throw requestError("Unable to connect to PostgreSQL. Check the database configuration and availability, then retry.", error);
  }
}

function transactionContext(): TransactionContext | undefined {
  const context = shared.transactions.getStore();
  if (context) {
    if (!context.active) throw new Error("This database transaction has already finished.");
    requireMatchingBinding(configuredBinding(), context.binding);
  }
  return context;
}

export function assertInTransaction(): void {
  if (!transactionContext()) throw new Error("A transaction-scoped database lock requires an active transaction.");
}

async function retainRootGuards(context: TransactionContext): Promise<void> {
  try {
    await context.client.query(`RELEASE SAVEPOINT ${workpoint}`);
    context.root.workpointActive = false;
    await context.client.query(`SAVEPOINT ${workpoint}`);
    context.root.workpointActive = true;
  } catch (error) {
    context.root.retainArtifacts = true;
    context.root.rollbackOnly ??= error;
    throw error;
  }
}

export async function retainTransactionLock(key: string, sharedLock: boolean): Promise<void> {
  const context = transactionContext();
  if (!context) throw new Error("Mutation guards require an active transaction.");
  const exclusive = `exclusive:${key}`;
  const guard = sharedLock ? `shared:${key}` : exclusive;
  for (let owner: TransactionContext | undefined = context; owner; owner = owner.parent) {
    if (owner.guards.has(exclusive) || owner.guards.has(guard)) return;
  }
  if (context.childActive) throw new Error("Acquire mutation guards before starting nested work.");
  context.guards.add(guard);
  // RELEASE promotes guards to the outer transaction without unlocking them. Later SQL errors
  // can then abort the work savepoint without exposing storage compensation to another writer.
  if (!context.parent) await retainRootGuards(context);
}

async function query<Row extends QueryResultRow = QueryResultRow>(
  sql: string,
  args: unknown[] = []
): Promise<QueryResult<Row>> {
  const context = transactionContext();
  if (context) {
    try {
      return await context.client.query<Row>(sql, args);
    } catch (error) {
      context.statementError ??= error;
      throw error;
    }
  }

  const binding = configuredBinding();
  const client = await connect();
  try {
    await verifyBinding(client, binding);
    return await client.query<Row>(sql, args);
  } finally {
    client.release();
  }
}

async function compensate(callbacks: RollbackAction[], original: unknown): Promise<void> {
  const failures: unknown[] = [];
  for (const callback of callbacks.splice(0).reverse()) {
    try {
      await callback();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(
      [original, ...failures],
      `${errorMessage(original)}. The operation failed and storage rollback also failed: ${failures.map(errorMessage).join("; ")}. Retained storage artifacts require recovery.`,
      { cause: original }
    );
  }
}

async function runCompensation(context: TransactionContext, callbacks: RollbackAction[], original: unknown): Promise<void> {
  const cleanup: TransactionContext = {
    ...context,
    callbacks: [],
    active: true,
    childActive: false,
    compensating: true,
    statementError: undefined,
  };
  try {
    await shared.transactions.run(cleanup, () => compensate(callbacks, original));
  } finally {
    cleanup.active = false;
  }
}

function definiteCommitFailure(error: unknown): boolean {
  const code = sqlState(error);
  // A transport/shutdown error can arrive after the server committed. Never compensate it blindly.
  return code !== undefined && code !== "40003" && !/^(08|57|58|XX)/.test(code);
}

async function nestedTransaction<T>(parent: TransactionContext, action: () => Promise<T>): Promise<T> {
  if (parent.childActive) throw new Error("Nested transactions on one connection must be awaited sequentially.");
  parent.childActive = true;
  const name = `dispatch_savepoint_${++parent.root.savepoint}`;
  const context: TransactionContext = {
    client: parent.client,
    binding: parent.binding,
    callbacks: [],
    guards: new Set<string>(),
    parent,
    active: true,
    childActive: false,
    compensating: parent.compensating,
    root: parent.root,
  };
  let started = false;
  let released = false;
  try {
    await parent.client.query(`SAVEPOINT ${name}`);
    started = true;
    const result = await shared.transactions.run(context, action);
    if (context.statementError) throw context.statementError;
    await parent.client.query(`RELEASE SAVEPOINT ${name}`);
    released = true;
    parent.callbacks.push(...context.callbacks);
    context.callbacks.length = 0;
    for (const guard of Array.from(context.guards)) parent.guards.add(guard);
    if (context.guards.size && !parent.parent) await retainRootGuards(parent);
    return result;
  } catch (error) {
    context.active = false;
    if (released) {
      parent.root.rollbackOnly ??= error;
      throw error;
    }
    if (started) {
      try {
        await parent.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await parent.client.query(`RELEASE SAVEPOINT ${name}`);
      } catch (rollbackError) {
        parent.callbacks.push(...context.callbacks);
        context.callbacks.length = 0;
        const failure = new AggregateError(
          [error, rollbackError],
          "The nested transaction could not roll back; the entire transaction must be rolled back.",
          { cause: error }
        );
        parent.root.rollbackOnly = failure;
        parent.root.retainArtifacts = true;
        throw failure;
      }
      await runCompensation(parent, context.callbacks, error);
    }
    throw error;
  } finally {
    context.active = false;
    parent.childActive = false;
  }
}

async function transaction<T>(action: () => Promise<T>): Promise<T> {
  const parent = transactionContext();
  if (parent) return nestedTransaction(parent, action);

  const binding = configuredBinding();
  const client = await connect();
  const context: TransactionContext = {
    client,
    binding,
    callbacks: [],
    guards: new Set<string>(),
    active: true,
    childActive: false,
    root: { savepoint: 0, workpointActive: false },
  };
  let began = false;
  let committing = false;
  let discardClient = false;
  let released = false;
  try {
    await client.query("BEGIN");
    began = true;
    await verifyBinding(client, binding);
    await client.query(`SAVEPOINT ${workpoint}`);
    context.root.workpointActive = true;
    const result = await shared.transactions.run(context, action);
    if (context.root.rollbackOnly) throw context.root.rollbackOnly;
    if (context.statementError) throw context.statementError;
    context.active = false;
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    committing = true;
    const committed = await client.query("COMMIT");
    if (committed.command !== "COMMIT") {
      throw Object.assign(new Error("PostgreSQL rolled back the transaction instead of committing it."), { code: "25P02", severity: "ERROR" });
    }
    began = false;
    context.callbacks.length = 0;
    return result;
  } catch (error) {
    context.active = false;
    let failure = error;
    let compensateAfterRollback = false;
    let rolledBack = false;
    if (committing) {
      if (!definiteCommitFailure(error)) {
        discardClient = true;
        failure = requestError(
          "The PostgreSQL commit outcome could not be confirmed. Storage artifacts were retained for recovery. Verify the database records and documents before retrying; do not delete or move documents blindly.",
          error
        );
      } else if (context.callbacks.length) {
        failure = requestError(
          "PostgreSQL rejected the final commit after mutation guards ended. Storage artifacts were retained for recovery. Verify the records and documents before retrying; do not delete or move documents blindly.",
          error
        );
      }
    } else {
      let workRolledBack = false;
      if (context.root.workpointActive) {
        try {
          await client.query(`ROLLBACK TO SAVEPOINT ${workpoint}`);
          workRolledBack = true;
        } catch (rollbackError) {
          context.root.retainArtifacts = true;
          failure = new AggregateError([error, rollbackError], "The work savepoint could not roll back.", { cause: error });
        }
      }
      if (context.root.retainArtifacts || (context.callbacks.length && !workRolledBack)) {
        failure = requestError(
          "The PostgreSQL rollback guards could not be confirmed. Storage artifacts were retained for recovery. Verify database records and document locations before retrying.",
          failure
        );
      } else if (workRolledBack) {
        compensateAfterRollback = true;
      }
    }
    // Guarded storage callbacks run in the nested work rollback above, while parent guards remain.
    if (began) {
      try {
        await client.query("ROLLBACK");
        rolledBack = true;
      } catch (rollbackError) {
        discardClient = true;
        failure = requestError(
          (committing || context.root.retainArtifacts) && failure instanceof Error
            ? failure.message
            : "The PostgreSQL rollback could not be confirmed. Verify database records and document locations before retrying.",
          new AggregateError([failure, rollbackError], "Database rollback failed.", { cause: failure })
        );
      }
    }
    if (compensateAfterRollback && rolledBack) {
      client.release(discardClient);
      released = true;
      try {
        await compensate(context.callbacks, error);
      } catch (cleanupError) {
        failure = cleanupError;
      }
    }
    throw failure;
  } finally {
    context.active = false;
    if (!released) client.release(discardClient);
  }
}

const db = {
  query,
  async all<Row extends QueryResultRow = QueryResultRow>(sql: string, args: unknown[] = []): Promise<Row[]> {
    return (await query<Row>(sql, args)).rows;
  },
  async one<Row extends QueryResultRow = QueryResultRow>(sql: string, args: unknown[] = []): Promise<Row | undefined> {
    return (await query<Row>(sql, args)).rows[0];
  },
  transaction,
  onRollback(action: RollbackAction): void {
    const context = transactionContext();
    if (!context) throw new Error("Storage rollback callbacks require an active database transaction.");
    if (context.compensating) throw new Error("Cannot register more storage work during rollback compensation.");
    context.callbacks.push(action);
  },
  async close(): Promise<void> {
    if (transactionContext()) throw new Error("Cannot close the database pool inside an active transaction.");
    const pool = shared.pool;
    shared.pool = undefined;
    shared.url = undefined;
    if (pool) await pool.end();
  },
};

export { LOAD_STATUSES, LOAD_TYPES, FILE_CATEGORIES } from "./models";
export type { LoadStatus, LoadType } from "./models";

export default db;

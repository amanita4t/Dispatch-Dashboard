/* eslint-disable @typescript-eslint/no-require-imports -- The existing Node test harness uses CommonJS to register TypeScript imports. */
require("./register.cjs");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  BOARD_FILTER_DEFAULTS,
  boardUrl,
  readBoardFilters,
  sanitizeBoardReturnUrl,
  withBoardReturn,
} = require("../lib/board-navigation.ts");
const { uploadSelectedFiles } = require("../lib/client-uploads.ts");
const { MAX_UPLOAD_BYTES, UPLOAD_LIMIT_MESSAGE, uploadLimitError } = require("../lib/upload-limits.ts");

test("the decimal 4 MB document limit is inclusive across all files in a form", () => {
  assert.equal(MAX_UPLOAD_BYTES, 4_000_000);
  assert.equal(uploadLimitError(new FormData()), null);
  const form = new FormData();
  form.append("other", new File([new Uint8Array(2_000_000)], "first.pdf"));
  form.append("other", new File([new Uint8Array(2_000_000)], "second.pdf"));
  assert.equal(uploadLimitError(form), null);
  form.append("notes", "Ordinary booking text 🚚");
  assert.equal(uploadLimitError(form), null);
  form.append("other", new File(["x"], "one-byte-too-many.pdf"));
  assert.equal(uploadLimitError(form), UPLOAD_LIMIT_MESSAGE);
  assert.match(UPLOAD_LIMIT_MESSAGE, /4 MB total per request/);
  assert.match(UPLOAD_LIMIT_MESSAGE, /directly in Google Drive, then Sync storage/);
});

test("exactly 4,000,000 file bytes pass with ordinary text fields and 4,000,001 fail", () => {
  const form = new FormData();
  form.set("rate_confirmation", new File([new Uint8Array(MAX_UPLOAD_BYTES)], "rate.pdf"));
  form.set("load_number", "123");
  form.set("driver_id", "1");
  form.append("notes", "🚚é");
  assert.equal(uploadLimitError(form), null);
  form.set("rate_confirmation", new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "too-large.pdf"));
  assert.equal(uploadLimitError(form), UPLOAD_LIMIT_MESSAGE);
});

test("text-only size enforcement belongs to the separate encoded-request guard", () => {
  const textOnly = new FormData();
  textOnly.set("notes", "é".repeat(2_500_000));
  assert.equal(uploadLimitError(textOnly), null);
});

test("board URLs preserve every criterion through detail and booking return links", () => {
  const filters = {
    driver_id: "12",
    load_type: "loadout",
    status: "invoiced",
    q: "Load #12 & Dallas",
    archived: "archived",
    date_field: "invoice_due_date",
    date_from: "2026-09-01",
    date_to: "2026-09-30",
    sort: "rate_amount",
    order: "asc",
  };
  const url = boardUrl(filters);
  assert.deepEqual(readBoardFilters(new URL(url, "http://localhost").searchParams), filters);
  for (const path of ["/loads/42", "/loads/new"]) {
    const link = new URL(withBoardReturn(path, url), "http://localhost");
    assert.equal(link.pathname, path);
    assert.equal(sanitizeBoardReturnUrl(link.searchParams.get("returnTo")), url);
    assert.deepEqual(readBoardFilters(new URL(link.searchParams.get("returnTo"), link.origin).searchParams), filters);
  }
});

test("clearing criteria restores the default active board and latest-created order", () => {
  assert.equal(boardUrl(BOARD_FILTER_DEFAULTS), "/");
  const defaults = readBoardFilters(new URLSearchParams("archived=active&date_field=delivery_date&sort=created_at&order=desc"));
  assert.deepEqual(defaults, BOARD_FILTER_DEFAULTS);
  assert.equal(boardUrl(defaults), "/");
  assert.equal(withBoardReturn("/loads/1", "/"), "/loads/1");
  assert.equal(withBoardReturn("/loads/new", null), "/loads/new");
  assert.equal(readBoardFilters(new URLSearchParams("sort=pickup_date")).order, "desc");
});

test("return URLs cannot navigate outside the load board or retain unrelated query keys", () => {
  for (const unsafe of [
    null, "", "//example.com", "/\\example.com", "https://example.com",
    "javascript:alert(1)", "/loads/4", "/drivers?archived=all", "/%2fexample.com",
    "\\\\example.com", "/?returnTo=//example.com",
  ]) {
    assert.equal(sanitizeBoardReturnUrl(unsafe), "/", String(unsafe));
  }
  assert.equal(sanitizeBoardReturnUrl("/?archived=archived&returnTo=https://example.com&unknown=1#fragment"), "/?archived=archived");
  assert.equal(sanitizeBoardReturnUrl("/?q=https%3A%2F%2Fexample.com"), "/?q=https%3A%2F%2Fexample.com");
  assert.equal(withBoardReturn("/loads/1", "//example.com"), "/loads/1");
});

test("invalid direct-URL criteria remain visible to API validation instead of becoming different filters", () => {
  const filters = readBoardFilters(new URLSearchParams("archived=invalid&date_from=2026-02-30&sort=unknown&q=%20A%20"));
  const restored = readBoardFilters(new URL(boardUrl(filters), "http://localhost").searchParams);
  assert.equal(restored.archived, "invalid");
  assert.equal(restored.date_from, "2026-02-30");
  assert.equal(restored.sort, "unknown");
  assert.equal(restored.q, " A ");
});

test("multi-upload continues after HTTP and network failures and retries only failed file objects", async (t) => {
  const files = [
    new File(["saved first"], "same-name.pdf"),
    new File(["failed second"], "same-name.pdf"),
    new File(["network failure"], "network.pdf"),
    new File(["saved last"], "last.pdf"),
  ];
  const attempts = [];
  const records = [
    { id: 10, filename: "same-name.pdf", category: "bol", load_id: 42 },
    { id: 11, filename: "last.pdf", category: "bol", load_id: 42 },
  ];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    attempts.push(options.body.get("file"));
    assert.equal(url, "/api/loads/42/files");
    assert.equal(options.method, "POST");
    assert.equal(options.body.get("category"), "bol");
    if (attempts.length === 2) return Response.json({ error: "Storage unavailable" }, { status: 503 });
    if (attempts.length === 3) throw new Error("Connection lost");
    return Response.json(records[attempts.length === 1 ? 0 : 1], { status: 201 });
  });

  const first = await uploadSelectedFiles("42", "bol", files);
  assert.equal(attempts.length, 4);
  assert.deepEqual(first.uploaded, records);
  assert.deepEqual(first.failedFiles, [files[1], files[2]]);
  assert.equal(first.failedFiles[0], files[1]);
  assert.match(first.errors[0], /same-name.pdf: Storage unavailable/);
  assert.match(first.errors[1], /network.pdf: Connection lost/);

  const retried = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    retried.push(await options.body.get("file").text());
    return Response.json({ id: 20 + retried.length, filename: options.body.get("file").name }, { status: 201 });
  });
  const second = await uploadSelectedFiles("42", "bol", first.failedFiles);
  assert.deepEqual(retried, ["failed second", "network failure"]);
  assert.deepEqual(second.failedFiles, []);
  assert.deepEqual(second.errors, []);
  assert.equal(second.uploaded.length, 2);
});

test("an invalid upload response is surfaced and leaves that file available for retry", async (t) => {
  const file = new File(["document"], "document.pdf");
  t.mock.method(globalThis, "fetch", async () => new Response("Server unavailable", { status: 502 }));
  const result = await uploadSelectedFiles("42", "invoice", [file]);
  assert.deepEqual(result.uploaded, []);
  assert.deepEqual(result.failedFiles, [file]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^document.pdf:/);
});

test("an empty document selection makes no requests", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected upload"));
  assert.deepEqual(await uploadSelectedFiles("42", "other", []), { uploaded: [], failedFiles: [], errors: [] });
  assert.equal(fetch.mock.callCount(), 0);
});

test("oversized uploads make no request, keep their original file for retry, and do not block valid files", async (t) => {
  const files = [
    new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "too-large.pdf"),
    new File(["valid document"], "small.pdf"),
    new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "also-too-large.pdf"),
  ];
  const uploaded = { id: 7, filename: "small.pdf", category: "bol", load_id: 42 };
  const fetch = t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.body.get("file").name, "small.pdf");
    return Response.json(uploaded, { status: 201 });
  });
  const result = await uploadSelectedFiles("42", "bol", files);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(result.uploaded, [uploaded]);
  assert.deepEqual(result.failedFiles, [files[0], files[2]]);
  assert.equal(result.failedFiles[0], files[0]);
  assert.deepEqual(result.errors, [
    `too-large.pdf: ${UPLOAD_LIMIT_MESSAGE}`,
    `also-too-large.pdf: ${UPLOAD_LIMIT_MESSAGE}`,
  ]);
});

test("sequential detail uploads use a separate total limit for each request", async (t) => {
  const files = [
    new File([new Uint8Array(MAX_UPLOAD_BYTES)], "exact-limit-with-category.pdf"),
    new File([new Uint8Array(3_000_000)], "another.pdf"),
  ];
  const attempts = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    attempts.push(options.body.get("file").name);
    assert.equal(uploadLimitError(options.body), null);
    return Response.json({ id: attempts.length, filename: attempts.at(-1) }, { status: 201 });
  });
  const result = await uploadSelectedFiles("42", "bol", files);
  assert.deepEqual(attempts, files.map((file) => file.name));
  assert.equal(result.uploaded.length, 2);
  assert.deepEqual(result.failedFiles, []);
  assert.deepEqual(result.errors, []);
});

test("local overdue dates remain empty during server rendering to avoid hydration mismatches", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { useLocalToday } = require("../lib/use-local-today.ts");
  function Today() {
    return React.createElement("span", null, useLocalToday());
  }
  assert.equal(renderToStaticMarkup(React.createElement(Today)), "<span></span>");
});

test("storage-changing controls stay disabled until the server confirms write access", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { StorageStatusProvider, useStorageStatus } = require("../components/StorageStatusProvider.tsx");
  function Control() {
    const { canWrite } = useStorageStatus();
    return React.createElement("button", { disabled: !canWrite }, "Upload");
  }
  assert.equal(renderToStaticMarkup(React.createElement(StorageStatusProvider, null, React.createElement(Control))),
    '<button disabled="">Upload</button>');
});

function elementText(element) {
  if (element === null || element === undefined || typeof element === "boolean") return "";
  if (typeof element !== "object") return String(element);
  if (Array.isArray(element)) return element.map(elementText).join("");
  return elementText(element.props?.children);
}

function findElement(element, predicate) {
  if (!element || typeof element !== "object") return undefined;
  if (!Array.isArray(element) && predicate(element)) return element;
  const children = Array.isArray(element) ? element : [element.props?.children];
  for (const child of children) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function clientPage(t, specifier) {
  const React = require("react");
  const Module = require("node:module");
  const originalLoad = Module._load;
  const originalWindow = globalThis.window;
  const slots = [];
  const effects = [];
  const navigations = [];
  let index = 0;
  let unmounted = false;
  let driverRefreshes = 0;
  const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
  t.mock.method(React, "useState", (initial) => {
    const slot = index++;
    if (!slots[slot]) slots[slot] = { value: typeof initial === "function" ? initial() : initial };
    return [slots[slot].value, (update) => {
      assert.equal(unmounted, false, "Unmounted pages must not update state.");
      slots[slot].value = typeof update === "function" ? update(slots[slot].value) : update;
    }];
  });
  t.mock.method(React, "useRef", (initial) => {
    const slot = index++;
    if (!slots[slot]) slots[slot] = { current: initial };
    return slots[slot];
  });
  t.mock.method(React, "useCallback", (callback, deps) => {
    const slot = index++;
    if (!slots[slot] || !sameDeps(slots[slot].deps, deps)) slots[slot] = { value: callback, deps };
    return slots[slot].value;
  });
  t.mock.method(React, "useEffect", (effect, deps) => {
    const slot = index++;
    const previous = slots[slot];
    if (!previous || !sameDeps(previous.deps, deps)) {
      slots[slot] = { deps, cleanup: previous?.cleanup };
      effects.push(() => {
        previous?.cleanup?.();
        slots[slot].cleanup = effect();
      });
    }
  });
  const replacements = {
    "next/navigation": {
      useRouter: () => ({ push: (url) => navigations.push(url) }),
      useSearchParams: () => new URLSearchParams(),
    },
    "@/components/StorageStatusProvider": {
      useStorageStatus: () => ({ canWrite: true, status: { storage: "drive", readOnly: false }, error: "" }),
    },
    "@/lib/use-driver-roster": {
      useDriverRoster: () => ({
        drivers: [{ id: 1, name: "Test driver" }], loading: false, error: "",
        refresh: async () => { driverRefreshes++; },
      }),
    },
    "@/lib/use-local-today": { useLocalToday: () => "2026-09-18" },
  };
  t.mock.method(Module, "_load", function (name, parent, ...options) {
    return replacements[name] || originalLoad.call(this, name, parent, ...options);
  });
  globalThis.window = {
    location: new URL("http://localhost/"),
    addEventListener() {},
    removeEventListener() {},
  };
  const resolved = require.resolve(specifier);
  const oldModule = require.cache[resolved];
  delete require.cache[resolved];
  const Page = require(specifier).default;
  function unmount() {
    if (unmounted) return;
    for (const slot of slots) slot?.cleanup?.();
    unmounted = true;
  }
  t.after(() => {
    unmount();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (oldModule) require.cache[resolved] = oldModule;
    else delete require.cache[resolved];
  });
  return {
    render() {
      index = 0;
      const child = Page().props.children;
      const tree = child.type(child.props);
      for (const effect of effects.splice(0)) effect();
      return tree;
    },
    unmount,
    navigations,
    driverRefreshes: () => driverRefreshes,
  };
}

const SYNC_CURSOR = "7e0eab70-856e-4a69-9a9a-e514b712ac74";
function syncSummary(overrides = {}) {
  return {
    cursor: SYNC_CURSOR,
    driversScanned: 0, driversImported: 0, loadsImported: 0, loadsArchived: 0,
    filesImported: 0, skippedExisting: 0, skippedArchived: 0, errors: [],
    ...overrides,
  };
}

function button(tree, label) {
  const found = findElement(tree, (element) => element.type === "button" && elementText(element).trim() === label);
  assert.ok(found, `Missing "${label}" button`);
  return found;
}

test("the board awaits cursor batches, prevents duplicate syncs and displays the latest cumulative summary", async (t) => {
  const gate = Promise.withResolvers();
  const requests = [];
  const summaries = [
    syncSummary({ driversScanned: 1, driversImported: 1, errors: ["Folder conflict"] }),
    syncSummary({ driversScanned: 1, driversImported: 1, errors: ["Folder conflict"] }),
    syncSummary({ cursor: null, driversScanned: 2, driversImported: 2, loadsImported: 3, filesImported: 4,
      loadsArchived: 1, skippedArchived: 2, errors: ["Folder conflict"] }),
  ];
  let page;
  let activeRequests = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url !== "/api/sync") return Response.json([]);
    requests.push(options);
    activeRequests++;
    assert.equal(activeRequests, 1, "Sync batches must not overlap.");
    assert.ok(options.signal instanceof AbortSignal);
    if (requests.length === 1) await gate.promise;
    if (requests.length === 2) assert.match(elementText(page.render()), /Sync progress \(1 batch\(es\) this run\)/);
    activeRequests--;
    return Response.json(summaries[requests.length - 1]);
  });
  page = clientPage(t, "../app/page.tsx");
  const start = button(page.render(), "Sync Storage").props.onClick;
  const syncing = start();
  const duplicate = start();
  assert.equal(button(page.render(), "Syncing…").props.disabled, true);
  assert.equal(requests.length, 1);
  gate.resolve();
  await Promise.all([syncing, duplicate]);
  assert.equal(requests.length, 3);
  assert.deepEqual(JSON.parse(requests[0].body), {});
  assert.equal(requests[0].headers["Content-Type"], "application/json");
  for (const request of requests.slice(1)) {
    assert.deepEqual(JSON.parse(request.body), { cursor: SYNC_CURSOR });
    assert.equal(request.headers["Content-Type"], "application/json");
  }
  const completed = elementText(page.render());
  assert.match(completed, /Sync complete: 2 driver\(s\) scanned; 2 driver\(s\), 3 load\(s\), 4 file\(s\) imported/);
  assert.match(completed, /1 load\(s\) moved to Archived/);
  assert.match(completed, /2 archived folder\(s\) skipped/);
  assert.match(completed, /1 error\(s\): Folder conflict/);
  assert.equal(completed.split("Folder conflict").length - 1, 1);
  assert.equal(button(page.render(), "Sync Storage").props.disabled, false);
  assert.equal(page.driverRefreshes(), 1);
});

test("a transient sync failure preserves the cursor and resumes without starting another job", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url !== "/api/sync") return Response.json([]);
    requests.push(options);
    if (requests.length === 2 || requests.length === 3) throw new Error("Connection lost");
    return Response.json(syncSummary({ cursor: requests.length === 1 ? SYNC_CURSOR : null,
      driversImported: requests.length === 1 ? 2 : 3 }));
  });
  const page = clientPage(t, "../app/page.tsx");
  await button(page.render(), "Sync Storage").props.onClick();
  assert.match(elementText(page.render()), /Sync paused: Connection lost/);
  assert.match(elementText(page.render()), /Saved runs expire after 24 hours/);
  assert.ok(button(page.render(), "Start new sync"));
  await button(page.render(), "Resume Sync").props.onClick();
  assert.match(elementText(page.render()), /0 driver\(s\) scanned; 2 driver\(s\)/);
  await button(page.render(), "Resume Sync").props.onClick();
  assert.equal(requests.length, 4);
  assert.deepEqual(JSON.parse(requests[2].body), { cursor: SYNC_CURSOR });
  assert.deepEqual(JSON.parse(requests[3].body), { cursor: SYNC_CURSOR });
  assert.match(elementText(page.render()), /Sync complete: 0 driver\(s\) scanned; 3 driver\(s\)/);
  assert.doesNotMatch(elementText(page.render()), /Connection lost|Start new sync|Resume Sync/);
});

test("an expired sync can be explicitly replaced by a new empty JSON object", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url !== "/api/sync") return Response.json([]);
    requests.push(options);
    if (requests.length === 2) return Response.json({ error: "Sync run expired" }, { status: 410 });
    return Response.json(syncSummary({ cursor: requests.length === 1 ? SYNC_CURSOR : null }));
  });
  const page = clientPage(t, "../app/page.tsx");
  await button(page.render(), "Sync Storage").props.onClick();
  assert.match(elementText(page.render()), /Sync run expired/);
  await button(page.render(), "Start new sync").props.onClick();
  assert.deepEqual(JSON.parse(requests[2].body), {});
  assert.equal(requests[2].headers["Content-Type"], "application/json");
  assert.match(elementText(page.render()), /Sync complete/);
});

test("a missing sync cursor fails explicitly instead of entering an endless loop", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url !== "/api/sync") return Response.json([]);
    requests++;
    return Response.json(syncSummary({ cursor: undefined }));
  });
  const page = clientPage(t, "../app/page.tsx");
  await button(page.render(), "Sync Storage").props.onClick();
  assert.equal(requests, 1);
  assert.match(elementText(page.render()), /Sync failed: The server returned an invalid sync cursor/);
  assert.doesNotMatch(elementText(page.render()), /Sync complete/);
});

test("unchanged counters and a stable cursor still continue, but a per-run batch ceiling permits safe resume", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url !== "/api/sync") return Response.json([]);
    requests++;
    return Response.json(syncSummary());
  });
  const page = clientPage(t, "../app/page.tsx");
  await button(page.render(), "Sync Storage").props.onClick();
  assert.equal(requests, 250);
  assert.match(elementText(page.render()), /Sync paused: The per-run batch limit was reached/);
  assert.ok(button(page.render(), "Resume Sync"));
});

test("leaving the board aborts its current sync request and never starts another batch", async (t) => {
  const continuationStarted = Promise.withResolvers();
  let requests = 0;
  let signal;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url !== "/api/sync") return Response.json([]);
    requests++;
    if (requests === 1) return Response.json(syncSummary());
    signal = options.signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      continuationStarted.resolve();
    });
  });
  const page = clientPage(t, "../app/page.tsx");
  const syncing = button(page.render(), "Sync Storage").props.onClick();
  await continuationStarted.promise;
  page.unmount();
  await syncing;
  assert.equal(signal.aborted, true);
  assert.equal(requests, 2);
});

test("booking checks the whole populated form before submitting any load or documents", async (t) => {
  const form = new FormData();
  form.set("rate_confirmation", new File([new Uint8Array(2_000_000)], "rate.pdf"));
  form.set("bol", new File([new Uint8Array(2_000_001)], "bol.pdf"));
  form.set("load_number", "123");
  t.mock.method(globalThis, "FormData", function (element) {
    assert.equal(element, form);
    return form;
  });
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("An oversized booking must not be submitted."));
  const page = clientPage(t, "../app/loads/new/page.tsx");
  const bookingForm = findElement(page.render(), (element) => element.type === "form");
  await bookingForm.props.onSubmit({ preventDefault() {}, currentTarget: form });
  assert.equal(fetch.mock.callCount(), 0);
  assert.match(elementText(page.render()), /Uploads are limited to 4 MB total per request/);
  assert.match(elementText(page.render()), /all selected document files combined in this request, not per file/);
  assert.deepEqual(page.navigations, []);
  assert.equal(button(page.render(), "Book Load").props.disabled, false);
});

test("booking accepts exactly 4 MB of files plus ordinary form fields in one request", async (t) => {
  const form = new FormData();
  form.set("rate_confirmation", new File([new Uint8Array(MAX_UPLOAD_BYTES)], "rate.pdf"));
  form.set("load_number", "123");
  form.set("driver_id", "1");
  form.set("notes", "Ordinary booking text 🚚");
  t.mock.method(globalThis, "FormData", function (element) {
    assert.equal(element, form);
    return form;
  });
  const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/loads");
    assert.equal(options.method, "POST");
    assert.equal(options.body, form);
    return Response.json({ load: { id: 42, load_type: "load", load_number: "123" } }, { status: 201 });
  });
  const page = clientPage(t, "../app/loads/new/page.tsx");
  const bookingForm = findElement(page.render(), (element) => element.type === "form");
  await bookingForm.props.onSubmit({ preventDefault() {}, currentTarget: form });
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(page.navigations, ["/loads/42"]);
  assert.match(elementText(page.render()), /Load #123 was created/);
  assert.equal(button(page.render(), "Load Created").props.disabled, true);
});

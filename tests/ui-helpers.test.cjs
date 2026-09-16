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

test("local overdue dates remain empty during server rendering to avoid hydration mismatches", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { useLocalToday } = require("../lib/use-local-today.ts");
  function Today() {
    return React.createElement("span", null, useLocalToday());
  }
  assert.equal(renderToStaticMarkup(React.createElement(Today)), "<span></span>");
});

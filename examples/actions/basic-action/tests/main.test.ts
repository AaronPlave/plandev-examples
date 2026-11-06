import { main } from "../src/index";

import assert from "node:assert";
import { test, mock } from "node:test";
import type { ActionsAPI } from "@nasa-jpl/plandev-actions";

// The basic-action example makes a `fetch` call to an external URL when it runs.
// This test avoids relying on making an actual call to an external URL by "mocking"
// the `fetch` API and replacing it with our own test function.

// create a mock Response-like object
function createMockResponse(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    json: async () => data,
    text: async () => JSON.stringify(data),
    clone: function () {
      return createMockResponse(data, { ok, status });
    },
  };
}

// mock fetch that returns it
const mockFetch = mock.fn(async (url, options) => {
  console.log(`mock fetch called with url: ${url}`);
  return createMockResponse({ message: "mock response" });
});

// TS utility that lets us mock only selected parts of an object,
// while treating it as a fully-typed instance of the whole thing.
function createMock<T extends object>(overrides: Partial<{ [K in keyof T]: T[K] }>): T {
  return overrides as T;
}

// create a partial mock of the actions API, so we can test it without making real database calls
// TODO: extract createMockActionsAPI into plandev-actions TestUtils package
const mockActionsAPI = createMock<ActionsAPI>({
  listFiles: async () => "[]",
  readFile: async () => "test",
  writeFile: async () => ({ success: true }),
  createFileRevision: async () => ({ name: "a" }),
});

test("plandev basic example action", async (t) => {
  t.mock.method(globalThis, "fetch", mockFetch);

  await t.test("runs main", async () => {
    await main(
      {
        urlPath: "repos/NASA-AMMOS/plandev",
        sleepMs: 0,
      },
      {
        externalUrl: "https://api.github.com",
      },
      mockActionsAPI,
    );
    assert.equal(mockFetch.mock.calls.length, 1, "fetch should have been called once");
  });

  await t.test("reads the chosen revision and bookmarks its output", async () => {
    const readFile = mock.fn(async (_file: unknown) => "old contents");
    const createFileRevision = mock.fn(async (_path: string, _opts?: object) => ({ name: "c" }));
    const api = createMock<ActionsAPI>({ ...mockActionsAPI, readFile, createFileRevision });

    await main(
      { urlPath: "repos/NASA-AMMOS/plandev", sleepMs: 0, sourceFile: { path: "notes.txt", revision: "b" } },
      { externalUrl: "https://api.github.com" },
      api,
    );
    assert.deepEqual(readFile.mock.calls[0].arguments[0], { path: "notes.txt", revision: "b" });
    assert.equal(createFileRevision.mock.calls[0].arguments[0], "action-template-output");
  });
});

test("plandev basic example action - HTTP error handling", async (t) => {
  // fetch resolves normally on a 500; only response.ok distinguishes it.
  const failingFetch = mock.fn(async () => createMockResponse({ error: "boom" }, { ok: false, status: 500 }));
  t.mock.method(globalThis, "fetch", failingFetch);

  await t.test("throws instead of reporting SUCCESS", async () => {
    await assert.rejects(
      () => main({ urlPath: "some/path", sleepMs: 0 }, { externalUrl: "https://api.github.com" }, mockActionsAPI),
      /HTTP 500/,
    );
  });
});

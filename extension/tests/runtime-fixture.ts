import type { RuntimeInterface } from "../core/src/runtime/interface";

export interface RecordedRequest {
  url: string;
  options?: RequestInit;
}

export function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

/** An in-memory extension runtime. Every request must be handled explicitly by the test. */
export function createRuntimeFixture(
  handle: (request: RecordedRequest) => Response | Promise<Response>,
) {
  const requests: RecordedRequest[] = [];
  const values = new Map<string, unknown>();
  let rule = 0;
  const runtime: RuntimeInterface = {
    type: "extension",
    async fetch(url, options) {
      const request = { url, options };
      requests.push(request);
      return handle(request);
    },
    cookies: {
      async get() {
        return [];
      },
      async set() {},
      async remove() {},
    },
    storage: {
      async get<T>(key: string): Promise<T | null> {
        return (values.get(key) as T) ?? null;
      },
      async set<T>(key: string, value: T) {
        values.set(key, value);
      },
      async remove(key) {
        values.delete(key);
      },
    },
    session: {
      async get<T>(key: string): Promise<T | null> {
        return (values.get(key) as T) ?? null;
      },
      async set<T>(key: string, value: T) {
        values.set(key, value);
      },
    },
    headerRules: {
      async add() {
        return `fixture-rule-${++rule}`;
      },
      async remove() {},
      async clear() {},
    },
    tabs: {
      async query() {
        return [{ id: 17, url: "https://fixture.invalid/" }];
      },
      async create(url) {
        return { id: 17 };
      },
      async waitForLoad() {},
      async executeScript<T, A extends unknown[]>(
        _id: number,
        func: (...args: A) => T | Promise<T>,
        args: A,
      ): Promise<T> {
        return func(...args);
      },
    },
    dom: {
      async parseHTML() {
        throw new Error("DOM access is not available in this fixture");
      },
      querySelector(document, selector) {
        return document.querySelector(selector);
      },
      querySelectorAll(document, selector) {
        return Array.from(document.querySelectorAll(selector));
      },
      getTextContent(element) {
        return element.textContent || "";
      },
      getInnerHTML(element) {
        return element.innerHTML;
      },
    },
  };
  return { runtime, requests };
}

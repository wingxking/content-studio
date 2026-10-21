import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { createCompanionChannel } from "../src/server/companion-channel.ts";
import { companionProtocol } from "../src/contracts/studio-ui.ts";

test("UI channel authenticates separately, supports bounded requests, and rejects execution methods", async () => {
  const config = {
    extensionId: "a".repeat(32),
    extensionToken: "fixture-extension-token",
    pairingKey: "p".repeat(40),
    serviceKey: "s".repeat(40),
  };
  const called: string[] = [];
  const channel = createCompanionChannel(
    async () => config,
    async (method, payload) => {
      called.push(method);
      return { payload };
    },
  );
  const server = createServer();
  server.on("upgrade", (req, socket, head) =>
    channel.upgrade(req, socket, head),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ui/connect?key=${config.pairingKey}`;
  let socket: WebSocket | undefined;
  try {
    const wrong = new WebSocket(base, {
      origin: `chrome-extension://${"b".repeat(32)}`,
    });
    const rejected = await new Promise<Error>((resolve) =>
      wrong.once("error", resolve),
    );
    assert.match(rejected.message, /403/u);
    socket = new WebSocket(base, {
      origin: `chrome-extension://${config.extensionId}`,
    });
    const greeting = once(socket, "message");
    await once(socket, "open");
    const hello = JSON.parse(String((await greeting)[0])) as {
      token: string;
      protocol: string;
    };
    assert.equal(hello.token, config.extensionToken);
    assert.equal(hello.protocol, companionProtocol);
    socket.send(
      JSON.stringify({
        protocol: companionProtocol,
        version: 1,
        type: "ready",
      }),
    );
    const response = once(socket, "message");
    socket.send(
      JSON.stringify({
        protocol: companionProtocol,
        version: 1,
        type: "request",
        id: randomUUID(),
        method: "tasks.list",
        payload: { search: "Software" },
      }),
    );
    const result = JSON.parse(String((await response)[0])) as {
      result: { payload: { search: string } };
    };
    assert.equal(result.result.payload.search, "Software");
    assert.deepEqual(called, ["tasks.list"]);
    const closed = once(socket, "close");
    socket.send(
      JSON.stringify({
        protocol: companionProtocol,
        version: 1,
        type: "request",
        id: randomUUID(),
        method: "syncArticle",
        payload: {},
      }),
    );
    await closed;
    assert.deepEqual(called, ["tasks.list"]);
  } finally {
    socket?.terminate();
    channel.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

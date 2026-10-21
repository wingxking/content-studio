import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/studio/executor", () => ({
  StudioExecutor: class {
    isBusy() {
      return false;
    }
  },
}));
vi.mock("../src/adapters", () => ({}));
vi.mock("../src/background/sync-service", () => ({}));
vi.mock("@wechatsync/core", () => ({}));
vi.mock("../src/lib/logger", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));
import { McpClient } from "../src/mcp/client";

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static sockets: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  private closeListeners: Array<() => void> = [];
  constructor(public url: string) {
    Socket.sockets.push(this);
  }
  send(_message: string) {}
  addEventListener(type: string, listener: () => void) {
    if (type === "close") this.closeListeners.push(listener);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
    this.closeListeners.forEach((listener) => listener());
  }
  message(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}
const token = "fixture-token-with-enough-characters",
  url = "ws://localhost:19527/connect?key=" + "p".repeat(40);
function authenticate(socket: Socket) {
  socket.open();
  socket.message({
    protocol: "content-studio-companion-ui",
    version: 1,
    type: "hello",
    token,
    id: "877b7d81-81ba-4591-8e64-34809cc63d31",
  });
}
let client: McpClient;
beforeEach(() => {
  vi.useFakeTimers();
  Socket.sockets = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("chrome", {
    storage: { local: { get: async () => ({ mcpEnabled: true }) } },
  });
  client = new McpClient();
  client.setToken(token);
  client.setServerUrl(url);
  client.resetReconnect();
  Socket.sockets[0].open();
  authenticate(Socket.sockets[1]);
});
afterEach(() => {
  client.disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("keeps both authenticated channels across repeated real alarm initialization sequences", () => {
  for (let i = 0; i < 3; i++) {
    vi.advanceTimersByTime(30000);
    Socket.sockets[1].message({
      protocol: "content-studio-companion-ui",
      version: 1,
      type: "ping",
    });
    client.setToken(token);
    client.setServerUrl(url);
    client.resetReconnect();
    expect(client.isConnected()).toBe(true);
    expect(client.companionConnected()).toBe(true);
  }
  expect(Socket.sockets).toHaveLength(2);
});
it("recovers a UI-only disconnect without opening a second draft connection or resending requests", () => {
  Socket.sockets[1].close();
  expect(client.isConnected()).toBe(true);
  expect(client.companionConnected()).toBe(false);
  client.resetReconnect();
  vi.advanceTimersByTime(30000);
  expect(Socket.sockets).toHaveLength(3);
  authenticate(Socket.sockets[2]);
  expect(client.companionConnected()).toBe(true);
  expect(Socket.sockets[0].readyState).toBe(1);
});
it("detects a silent UI socket and establishes a fresh authenticated companion", () => {
  vi.advanceTimersByTime(60000);
  expect(client.companionConnected()).toBe(false);
  expect(Socket.sockets[1].readyState).toBe(3);
  vi.advanceTimersByTime(30000);
  authenticate(Socket.sockets[2]);
  expect(client.companionConnected()).toBe(true);
});
it("reports offline after failure, keeps the private query out of status, and recovers both channels", async () => {
  Socket.sockets[0].onerror?.();
  Socket.sockets[0].close();
  expect(client.connectionStatus()).toEqual({
    connectionState: "offline",
    endpoint: "ws://localhost:19527",
  });
  expect(JSON.stringify(client.connectionStatus())).not.toContain("key=");
  expect(client.companionConnected()).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  expect(client.connectionStatus().connectionState).toBe("offline");
  const reconnect = Socket.sockets.at(-1)!;
  reconnect.open();
  authenticate(Socket.sockets.at(-1)!);
  expect(client.connectionStatus().connectionState).toBe("connected");
  expect(client.companionConnected()).toBe(true);
});
it("marks a connection offline after a bounded attempt instead of displaying connecting forever", () => {
  client.disconnect();
  client.setServerUrl("ws://localhost:19528/connect?key=" + "n".repeat(40));
  client.resetReconnect();
  expect(client.connectionStatus().connectionState).toBe("connecting");
  vi.advanceTimersByTime(10000);
  expect(client.connectionStatus().connectionState).toBe("offline");
});

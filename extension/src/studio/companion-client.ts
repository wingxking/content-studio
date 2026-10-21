import { z } from "zod";
import {
  companionMethods,
  companionProtocol,
  type CompanionMethod,
} from "../../../src/contracts/studio-ui";
import { isStudioUrl, validateMcpUrl, studioSocketOptions } from "./protocol";

const base = { protocol: z.literal(companionProtocol), version: z.literal(1) };
export const companionFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("hello"),
      token: z.string().min(16).max(512),
      id: z.string().uuid(),
    })
    .strict(),
  z.object({ ...base, type: z.literal("ping") }).strict(),
  z
    .object({
      ...base,
      type: z.literal("response"),
      id: z.string().uuid(),
      result: z.unknown().optional(),
      error: z.string().max(1000).optional(),
    })
    .strict(),
]);
export function companionUrl(value: string): string {
  const checked = validateMcpUrl(value);
  if (!isStudioUrl(checked)) throw new Error("请配置 Content Studio 草稿桥。");
  const url = new URL(checked);
  url.pathname = "/ui/connect";
  return url.toString();
}
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export class CompanionClient {
  private socket: WebSocket | null = null;
  private ready = false;
  private token = "";
  private url = "";
  private enabled = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, Pending>();
  open(serverUrl: string, token: string): void {
    let url: string;
    try {
      url = companionUrl(serverUrl);
    } catch {
      this.close();
      return;
    }
    if (this.url !== url || this.token !== token) {
      this.close();
      this.url = url;
      this.token = token;
    }
    this.enabled = true;
    if (this.socket || this.retry) return;
    this.connect();
  }
  private connect(): void {
    if (!this.enabled || this.socket) return;
    const transport=studioSocketOptions(this.url);
    const socket = new WebSocket(transport.url,transport.protocols);
    this.socket = socket;
    let lastMessageAt = Date.now();
    const deadline = setTimeout(() => {
      if (!this.ready) socket.close();
    }, 8000);
    const watchdog = setInterval(() => {
      if (Date.now() - lastMessageAt > 50000) socket.close();
    }, 10000);
    socket.onmessage = (event) => {
      try {
        if (
          typeof event.data !== "string" ||
          new TextEncoder().encode(event.data).length > 256 * 1024
        )
          throw new Error("Invalid frame");
        const frame = companionFrameSchema.parse(JSON.parse(event.data));
        if (this.socket !== socket) return;
        lastMessageAt = Date.now();
        if (frame.type === "hello") {
          if (this.ready || frame.token !== this.token)
            throw new Error("Server identity changed");
          socket.send(JSON.stringify({ ...baseValues(), type: "ready" }));
          this.ready = true;
          clearTimeout(deadline);
          return;
        }
        if (!this.ready) throw new Error("Handshake required");
        if (frame.type === "ping") return;
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(frame.id);
        if (frame.error) pending.reject(new Error(frame.error));
        else pending.resolve(frame.result);
      } catch {
        socket.close();
      }
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      clearTimeout(deadline);
      clearInterval(watchdog);
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("连接中断，请到工作台检查操作结果后重试。"));
      }
      this.pending.clear();
      if (this.enabled && !this.retry)
        this.retry = setTimeout(() => {
          this.retry = null;
          this.connect();
        }, 30000);
    };
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(deadline);
        clearInterval(watchdog);
      },
      { once: true },
    );
  }
  isConnected(): boolean {
    return this.ready && this.socket?.readyState === WebSocket.OPEN;
  }
  hasPendingRequests(): boolean {
    return this.pending.size > 0;
  }
  request(method: CompanionMethod, payload: unknown): Promise<unknown> {
    z.enum(companionMethods).parse(method);
    if (!this.isConnected())
      return Promise.reject(
        new Error(
          "任务助手尚未连接；旧版服务仍可继续草稿执行，请更新工作台或稍后重试。",
        ),
      );
    if (this.pending.size >= 4)
      return Promise.reject(new Error("请等待当前操作完成。"));
    const id = crypto.randomUUID();
    const message = JSON.stringify({
      ...baseValues(),
      type: "request",
      id,
      method,
      payload,
    });
    if (new TextEncoder().encode(message).length > 256 * 1024)
      return Promise.reject(new Error("采集内容过长，请缩短摘录。"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error("读取超时，请检查工作台；不要重复提交结果未知的草稿。"),
        );
      }, 45000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(message);
    });
  }
  close(): void {
    this.enabled = false;
    this.ready = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("连接已关闭。"));
    }
    this.pending.clear();
  }
}
function baseValues() {
  return { protocol: companionProtocol, version: 1 };
}

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { companionMethods, companionProtocol } from "../contracts/studio-ui.ts";
import type { DraftBridgeConfig } from "../core/draft-bridge-config.ts";
import { studioPairingKey } from './studio-pairing.ts';

const requestSchema = z
  .object({
    protocol: z.literal(companionProtocol),
    version: z.literal(1),
    type: z.literal("request"),
    id: z.string().uuid(),
    method: z.enum(companionMethods),
    payload: z.unknown(),
  })
  .strict();
const readySchema = z
  .object({
    protocol: z.literal(companionProtocol),
    version: z.literal(1),
    type: z.literal("ready"),
  })
  .strict();
const same = (a: string, b: string): boolean =>
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createCompanionChannel(
  readConfig: () => Promise<DraftBridgeConfig>,
  forward?: (
    method: string,
    payload: unknown,
    config: DraftBridgeConfig,
  ) => Promise<unknown>,
) {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
  });
  let closing = false;
  let active: WebSocket | null = null;
  const proxy =
    forward ??
    (async (method: string, payload: unknown, config: DraftBridgeConfig) => {
      const base = new URL(
        process.env.STUDIO_COMPANION_API_URL ?? "http://api:4310",
      );
      if (
        !["http:", "https:"].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        base.pathname !== "/"
      )
        throw new Error("Companion service unavailable.");
      const response = await fetch(
        `${base.origin}/internal/companion/${method}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.serviceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          redirect: "error",
          signal: AbortSignal.timeout(35000),
        },
      );
      const data: unknown = await response.json();
      if (!response.ok)
        throw new Error("工作台暂未完成此操作，请到任务内检查。");
      return data;
    });
  return {
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      const reject = (code: number) =>
        socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`);
      if (closing) {
        reject(503);
        return;
      }
      void (async () => {
        const config = await readConfig();
        const url = new URL(request.url ?? "", "http://companion.invalid");
        if (
          closing ||
          request.headers.origin !==
            `chrome-extension://${config.extensionId}` ||
          url.pathname !== "/ui/connect" ||
          !same(studioPairingKey(url,request.headers['sec-websocket-protocol']) ?? '', config.pairingKey)
        ) {
          reject(403);
          return;
        }
        if (active && active.readyState !== WebSocket.CLOSED) {
          reject(409);
          return;
        }
        server.handleUpgrade(request, socket, head, (client) => {
          active = client;
          let authenticated = false;
          const pending = new Set<string>();
          const timeout = setTimeout(() => {
            if (!authenticated) client.terminate();
          }, 8000);
          timeout.unref();
          const heartbeat = setInterval(() => {
            if (client.readyState === WebSocket.OPEN)
              client.send(
                JSON.stringify({
                  protocol: companionProtocol,
                  version: 1,
                  type: "ping",
                }),
              );
          }, 20000);
          heartbeat.unref();
          const close = () => {
            clearTimeout(timeout);
            clearInterval(heartbeat);
            if (active === client) active = null;
          };
          client.on("close", close);
          client.on("error", close);
          client.send(
            JSON.stringify({
              protocol: companionProtocol,
              version: 1,
              type: "hello",
              token: config.extensionToken,
              id: randomUUID(),
            }),
          );
          client.on("message", (bytes, binary) => {
            if (binary || closing) {
              client.terminate();
              return;
            }
            let message: unknown;
            try {
              message = JSON.parse(bytes.toString());
            } catch {
              client.terminate();
              return;
            }
            if (!authenticated) {
              if (!readySchema.safeParse(message).success) {
                client.terminate();
                return;
              }
              authenticated = true;
              clearTimeout(timeout);
              return;
            }
            const parsed = requestSchema.safeParse(message);
            if (!parsed.success) {
              client.terminate();
              return;
            }
            if (pending.size >= 4 || pending.has(parsed.data.id)) {
              client.send(
                JSON.stringify({
                  protocol: companionProtocol,
                  version: 1,
                  type: "response",
                  id: parsed.data.id,
                  error: "当前操作较多，请稍后重试。",
                }),
              );
              return;
            }
            const item = parsed.data;
            pending.add(item.id);
            void (async () => {
              const current = await readConfig();
              if (
                !same(current.pairingKey, config.pairingKey) ||
                !same(current.serviceKey, config.serviceKey) ||
                !same(current.extensionToken, config.extensionToken) ||
                current.extensionId !== config.extensionId
              )
                throw new Error("连接配置已变化，请重新连接。");
              const result = await proxy(item.method, item.payload, current);
              if (client.readyState === WebSocket.OPEN)
                client.send(
                  JSON.stringify({
                    protocol: companionProtocol,
                    version: 1,
                    type: "response",
                    id: item.id,
                    result,
                  }),
                );
            })()
              .catch(() => {
                if (client.readyState === WebSocket.OPEN)
                  client.send(
                    JSON.stringify({
                      protocol: companionProtocol,
                      version: 1,
                      type: "response",
                      id: item.id,
                      error: "操作未完成，请检查工作台连接与任务状态。",
                    }),
                  );
              })
              .finally(() => pending.delete(item.id));
          });
        });
      })().catch(() => reject(503));
    },
    close(): void {
      closing = true;
      for (const client of server.clients) client.terminate();
      server.close();
    },
  };
}

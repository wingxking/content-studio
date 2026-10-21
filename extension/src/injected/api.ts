/** Page-world compatibility API recovered from inject-api.js in 2.0.9. */
type Callback = (result: unknown, response?: unknown) => void;
type Handler = (value: unknown) => void;
type Message = Record<string, unknown>;

export interface PosterApi {
  versionNumber: number;
  dev: boolean;
  getAccounts(callback: Callback): void;
  addTask(task: unknown, statusHandler: Handler, callback: Callback): void;
  magicCall(data: Message & { methodName: string }, callback: Callback): void;
  updateDriver(data: unknown, callback: Callback): void;
  startInspect(handler: Handler, callback: Callback): void;
  uploadImage(data: Message, callback: Callback): void;
}

declare global {
  interface Window {
    $poster: PosterApi;
    $syncer: PosterApi;
  }
}

const callbacks = new Map<number, Callback>();
let onTaskUpdate: Handler | null = null;
let onConsoleLog: Handler | null = null;

function call(message: Message, callback: Callback): void {
  const eventID = Math.floor(Date.now() + Math.random() * 100);
  callbacks.set(eventID, callback);
  window.postMessage(JSON.stringify({ ...message, eventID }), "*");
}

const poster: PosterApi = {
  versionNumber: 1001,
  dev: location.hostname === "localhost" || location.hostname === "127.0.0.1",
  getAccounts(callback) {
    call({ method: "getAccounts" }, callback);
  },
  addTask(task, statusHandler, callback) {
    onTaskUpdate = statusHandler;
    call({ method: "addTask", task }, callback);
  },
  magicCall(data, callback) {
    call({ method: "magicCall", methodName: data.methodName, data }, callback);
  },
  updateDriver(data, callback) {
    call({ method: "updateDriver", data }, callback);
  },
  startInspect(handler, callback) {
    onConsoleLog = handler;
    call({ method: "startInspect" }, callback);
  },
  uploadImage(data, callback) {
    call({ method: "magicCall", methodName: "uploadImage", data }, callback);
  },
};

window.addEventListener("message", (event) => {
  try {
    const action: unknown = JSON.parse(event.data);
    if (!action || typeof action !== "object") return;
    const message = action as Message;
    if (message.method === "taskUpdate") {
      onTaskUpdate?.(message.task);
      return;
    }
    if (message.method === "consoleLog") {
      onConsoleLog?.(message.args);
      return;
    }
    if (!message.callReturn || typeof message.eventID !== "number") return;
    callbacks.get(message.eventID)?.(message.result);
    callbacks.delete(message.eventID);
  } catch {
    /* The original bridge ignores unrelated page messages. */
  }
});

window.$poster = poster;
window.$syncer = poster;

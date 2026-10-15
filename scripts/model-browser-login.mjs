import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Keep the official CLI's localhost callback unchanged. Only the temporary
// one-off container publishes this relay, at host loopback 1455 -> relay 1456.
export async function runModelBrowserLogin({ listenPort = 1456, callbackPort = 1455, timeoutMs = 600000, command = 'codex', commandArgs = ['login'] } = {}) {
  const sockets = new Set();
  const relay = createServer(incoming => {
    const upstream = createConnection({ host: '127.0.0.1', port: callbackPort });
    for (const socket of [incoming, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => { incoming.destroy(); upstream.destroy(); });
    }
    incoming.pipe(upstream); upstream.pipe(incoming);
  });
  // A port conflict fails before starting Codex; never replace its listener.
  await new Promise((accept, reject) => { relay.once('error', reject); relay.listen(listenPort, '0.0.0.0', accept); });
  let child;
  let timer;
  let forceTimer;
  let interrupt;
  let terminate;
  try {
    return await new Promise(accept => {
      let stoppingCode;
      let settled = false;
      const finish = code => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(forceTimer);
        accept(code);
      };
      const stop = code => {
        if (stoppingCode !== undefined) return;
        stoppingCode = code;
        for (const socket of sockets) socket.destroy();
        relay.close();
        if (!child || child.exitCode !== null || child.signalCode !== null) { finish(code); return; }
        child.kill('SIGTERM');
        forceTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      };
      interrupt = () => stop(130); terminate = () => stop(143);
      process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
      child = spawn(command, commandArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
      child.once('error', () => finish(1));
      child.once('exit', code => finish(stoppingCode ?? code ?? 1));
      relay.on('error', () => stop(1));
      timer = setTimeout(() => stop(124), timeoutMs);
    });
  } finally {
    clearTimeout(timer); clearTimeout(forceTimer);
    if (interrupt) process.off('SIGINT', interrupt);
    if (terminate) process.off('SIGTERM', terminate);
    for (const socket of sockets) socket.destroy();
    await new Promise(accept => { relay.close(() => accept()); });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runModelBrowserLogin(); }
  catch { console.error('Browser model login could not start its temporary callback relay.'); process.exitCode = 1; }
}

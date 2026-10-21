import { createServer, type Server } from 'node:http';

/** Process-local health: never infer a live worker from a persisted readiness file. */
export function createProcessHealth(): { server: Server; ready: () => void; stopping: () => void } {
  let accepting = false;
  const server = createServer((request, response) => {
    const known = request.url === '/healthz' || request.url === '/readyz';
    response.statusCode = !known ? 404 : request.url === '/readyz' && !accepting ? 503 : 200;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ready: known && (request.url === '/healthz' || accepting) }));
  });
  return { server, ready: () => { accepting = true; }, stopping: () => { accepting = false; } };
}

export async function listenProcessHealth(server: Server, port: number): Promise<void> {
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
}

export async function closeProcessHealth(server: Server): Promise<void> {
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
}

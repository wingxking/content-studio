import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const freePort = async () => {
  const server = createServer(); await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const port = (server.address() as AddressInfo).port; await new Promise<void>(accept => server.close(() => accept())); return port;
};
async function until(check: () => Promise<boolean>) { for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await delay(10); } throw new Error('Fixture did not become ready.'); }
const exists = async (path: string) => readFile(path).then(() => true, () => false);
const start = (options: { listenPort: number; callbackPort: number; timeoutMs: number; command: string; commandArgs: string[] }) => {
  const source = `import {runModelBrowserLogin} from ${JSON.stringify(pathToFileURL(resolve('scripts/model-browser-login.mjs')).href)}; try {process.exitCode=await runModelBrowserLogin(${JSON.stringify(options)});} catch {process.exitCode=1;}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
  const completion = new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('exit', accept); });
  return { child, completion, output: () => output };
};

test('browser callback relay preserves HTTP bytes and CLI streams without printing callback secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-model-relay-'));
  const listenPort = await freePort(); const callbackPort = await freePort();
  const ready = join(directory, 'ready'); const captured = join(directory, 'request.json'); const fixture = join(directory, 'cli.mjs');
  try {
    await writeFile(fixture, `import {createServer} from 'node:http'; import {writeFileSync} from 'node:fs';
console.log('fixture CLI stdout'); console.error('fixture CLI stderr');
const server=createServer((request,response)=>{writeFileSync(${JSON.stringify(captured)},JSON.stringify({url:request.url,host:request.headers.host})); response.setHeader('Connection','close'); response.end('callback complete'); server.close();});
server.listen(${callbackPort},'127.0.0.1',()=>writeFileSync(${JSON.stringify(ready)},'ready'));`);
    const running = start({ listenPort, callbackPort, timeoutMs: 3000, command: process.execPath, commandArgs: [fixture] });
    await until(() => exists(ready));
    const callback = '/auth/callback?code=fixture-private-code&state=fixture-private-state';
    const response = await new Promise<string>((accept, reject) => {
      get({ hostname: '127.0.0.1', port: listenPort, path: callback, headers: { Host: 'localhost:1455' } }, result => { let text = ''; result.on('data', chunk => { text += String(chunk); }); result.on('end', () => accept(text)); }).once('error', reject);
    });
    assert.equal(response, 'callback complete'); assert.equal(await running.completion, 0);
    assert.deepEqual(JSON.parse(await readFile(captured, 'utf8')), { url: callback, host: 'localhost:1455' });
    assert.match(running.output(), /fixture CLI stdout/); assert.match(running.output(), /fixture CLI stderr/);
    assert.doesNotMatch(running.output(), /fixture-private|auth\/callback/);
    await assert.rejects(fetch(`http://127.0.0.1:${listenPort}`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a relay port conflict never starts CLI or replaces the existing listener', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-model-conflict-')); const server = createServer();
  await new Promise<void>(accept => server.listen(0, '0.0.0.0', accept)); const listenPort = (server.address() as AddressInfo).port;
  const marker = join(directory, 'started');
  try {
    const running = start({ listenPort, callbackPort: await freePort(), timeoutMs: 500, command: process.execPath, commandArgs: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`] });
    assert.equal(await running.completion, 1); assert.equal(await exists(marker), false); assert.equal(server.listening, true);
  } finally { await new Promise<void>(accept => server.close(() => accept())); await rm(directory, { recursive: true, force: true }); }
});

test('CLI failure, timeout and process signals close relay sockets and stop the child', async () => {
  for (const scenario of ['failure', 'missing', 'timeout', 'SIGINT', 'SIGTERM'] as const) {
    const directory = await mkdtemp(join(tmpdir(), 'studio-model-stop-')); const marker = join(directory, 'started');
    const listenPort = await freePort(); const callbackPort = await freePort();
    const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started'); setInterval(()=>{},1000);`;
    const running = start({ listenPort, callbackPort, timeoutMs: scenario === 'timeout' ? 100 : 3000, command: scenario === 'missing' ? '/fixture-no-such-cli' : process.execPath, commandArgs: ['-e', scenario === 'failure' ? 'process.exit(7)' : source] });
    try {
      if (scenario === 'SIGINT' || scenario === 'SIGTERM') { await until(() => exists(marker)); running.child.kill(scenario); }
      const expected = scenario === 'failure' ? 7 : scenario === 'timeout' ? 124 : scenario === 'SIGINT' ? 130 : scenario === 'SIGTERM' ? 143 : 1;
      assert.equal(await running.completion, expected, scenario);
      await assert.rejects(fetch(`http://127.0.0.1:${listenPort}`));
      assert.doesNotMatch(running.output(), /auth\/callback|Bearer|token=/);
    } finally { running.child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
  }
});

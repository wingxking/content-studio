import { spawn } from 'node:child_process';
import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { chmod, chown, cp, lstat, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
const project = resolve(process.env.STUDIO_PROJECT_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2); const action = args[0];
const flag = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const root = resolve(flag('--root') ?? process.env.STUDIO_DOCKER_ROOT ?? join(project, '.docker'));
const config = join(root, 'config');
async function run(command, argv, { input, output, environment = {}, timeout = 600000, onOutput } = {}) {
  const file = output ? await open(output, 'wx', 0o600) : undefined;
  return new Promise((accept, reject) => {
    const child = spawn(command, argv, { cwd: project, env: { ...process.env, ...environment }, stdio: ['pipe', file?.fd ?? 'pipe', 'pipe'] });
    let text = ''; let error = ''; child.stdout?.on('data', bytes => { text += bytes; onOutput?.(bytes.toString()); }); child.stderr.on('data', bytes => { error = (error + bytes).slice(-20000); });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.on('error', async () => { clearTimeout(timer); await file?.close(); reject(new Error(`${command} could not start.`)); });
    child.on('close', async code => { clearTimeout(timer); await file?.close(); if (code !== 0) { const diagnostics=[...error.split('\n'),...text.split('\n').filter(line=>/^[\s#0-9.]*[a-zA-Z0-9_./-]+\.tsx?\([0-9]+,[0-9]+\): error TS[0-9]+:/.test(line)||/^\s*resolve\s*:\s*lstat .+: no such file/i.test(line))]; const safe = diagnostics.filter(line => /error|failed|unhealthy|permission|no such file/i.test(line) && !/key|secret|token|password|credential|jwt/i.test(line)).slice(-3).join('\n'); reject(new Error(`${command} failed (${code}). ${safe}`)); } else accept(text); });
    child.stdin.end(input);
  });
}
async function settings() {
  const text = await readFile(join(config, 'compose.env'), 'utf8');
  return Object.fromEntries(text.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), JSON.parse(line.slice(i + 1))]; }));
}
async function compose(argv, options = {}) {
  return run('docker', ['compose', '--project-directory', project, '--env-file', join(config, 'compose.env'), '-f', join(project, 'infra', 'compose.yml'), ...argv], { ...options, environment: { ...await settings(), STUDIO_DOCKER_ROOT: root, STUDIO_PROJECT_DIR:project, ...options.environment } });
}
export function youtubeAuthorizationNotice(line) {
  let value; try { value=JSON.parse(line); } catch { return null; }
  if (!value || typeof value!=='object' || typeof value.authorizationUrl!=='string') return null;
  let url; try { url=new URL(value.authorizationUrl); } catch { return null; }
  const fields=new Set(['client_id','redirect_uri','response_type','scope','state','code_challenge','code_challenge_method','access_type','prompt','login_hint']);
  if(url.protocol!=='https:' || url.hostname!=='accounts.google.com' || url.username || url.password || url.port || url.pathname!=='/o/oauth2/v2/auth' || [...url.searchParams.keys()].some(key=>!fields.has(key))) return null;
  return {authorizationUrl:url.toString(),nextAction:'Open this URL in the verified Chrome profile and review the requested upload/read-only scopes.'};
}
async function authorizeYouTube() {
  const client=flag('--client-file'); if(!client) throw new Error('Provide --client-file with the downloaded Desktop OAuth JSON path.');
  const port=Number(flag('--callback-port')??8765); if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('Callback port must be an integer from 1024 to 65535.');
  let pending='';
  await compose(['run','--rm','--no-deps','--publish',`127.0.0.1:${port}:${port}`,'--volume',`${resolve(client)}:${resolve(client)}:ro`,'--env',`STUDIO_YOUTUBE_OAUTH_PORT=${port}`,'delivery-worker','node','--import','tsx','src/server/cli.ts','youtube-auth',resolve(client)],{timeout:360000,onOutput:chunk=>{pending+=chunk;const lines=pending.split('\n');pending=lines.pop()??'';for(const line of lines){const notice=youtubeAuthorizationNotice(line);if(notice) console.log(JSON.stringify(notice));}}});
  console.log('YouTube authorization and expected-channel readback completed; publishing remains separately paused or enabled by the owner.');
}
async function privateFile(path, content) { await writeFile(path, content, { mode: 0o600, flag: 'wx' }); }
function quote(value) { return JSON.stringify(value); }
function envText(values) { return Object.entries(values).map(([name, value]) => `${name}=${quote(String(value))}`).join('\n') + '\n'; }
function portable(value, mappings) {
  if (typeof value === 'string') { for (const [old, replacement] of mappings) value = value.split(old).join(replacement); return value.replaceAll('$', () => '$$'); }
  if (Array.isArray(value)) return value.map(entry => portable(entry, mappings));
  return value;
}
async function copyTree(source, destination, excluded = new Set()) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = join(source, entry.name); const target = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Data transfer refuses symbolic links.');
    if (entry.isDirectory()) await copyTree(path, target);
    else if (entry.isFile()) { await cp(path, target, { errorOnExist: true, force: false }); await chmod(target, 0o600); }
  }
}
async function copyBackupTrees(sourceRoot, destination) {
  for (const name of ['storage','data','config','model-auth','model-cache','delivery-private','tts-cache']) {
    // Codex recreates executable links in this ephemeral directory on every run.
    await copyTree(join(sourceRoot,name),join(destination,name),name==='model-auth'?new Set(['tmp']):new Set());
  }
}
export async function prepareDraftBridgeDirectory(bindRoot, uid, gid) {
  if (![uid, gid].every(value => Number.isInteger(value) && value >= 0)) throw new Error('Invalid Docker host UID/GID.');
  for (const name of ['delivery-private', 'delivery-private/draft-bridge', 'delivery-private/browser-publisher']) {
    const path = join(bindRoot, name);
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (!(await lstat(path)).isDirectory()) throw new Error('Private bridge directory must not be a symbolic link.');
    await chown(path, uid, gid); await chmod(path, 0o700);
  }
}
async function writeBackupDestination(destination, writer) {
  await mkdir(dirname(destination),{recursive:true,mode:0o700});
  await mkdir(destination,{mode:0o700});
  try { return await writer(); }
  catch (error) {
    try {
      await rm(destination,{recursive:true,force:true});
      await mkdir(destination,{mode:0o700});
      await privateFile(join(destination,'incomplete.json'),JSON.stringify({complete:false,privatePartialPayloadRemoved:true,createdAt:new Date().toISOString()}));
    } catch (cleanupError) { throw new Error('Backup failed and partial private payload cleanup failed. Keep the destination private until cleanup succeeds.',{cause:cleanupError}); }
    throw new Error('Backup failed; private partial payload was removed. Application workers remain stopped.',{cause:error});
  }
}
export {copyBackupTrees,writeBackupDestination};
async function capture() {
  const suffix = flag('--source-project') ?? 'content-studio-local';
  if (!/^content-studio-[a-z0-9-]+$/.test(suffix)) throw new Error('Capture requires a Content Studio Supabase source project.');
  if (await readdir(root).then(entries => entries.length > 0).catch(() => false)) throw new Error('Capture requires an empty isolated bind root. Existing data is preserved.');
  const serviceNames = { postgres: 'db', rest: 'rest', auth: 'auth', storage: 'storage', kong: 'kong', mail: 'inbucket' };
  const names = Object.values(serviceNames).map(name => `supabase_${name}_${suffix}`);
  const source = JSON.parse(await run('docker', ['inspect', ...names]));
  for (const container of source) {
    if (container.Config.Labels?.['com.supabase.cli.project'] !== suffix) throw new Error('Source container project label differs.');
    if (container.State.Running) throw new Error('Stop source Supabase containers after a verified backup before a cold bind capture.');
  }
  const dataSource = resolve(flag('--data-source') ?? join(project, '.studio'));
  const runtime = Object.fromEntries((await readFile(join(dataSource, 'runtime.env'), 'utf8')).split('\n').filter(Boolean).map(line => { const i = line.indexOf('='); return [line.slice(0, i), JSON.parse(line.slice(i + 1))]; }));
  const webPort = Number(flag('--port') ?? '14310');
  if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535) throw new Error('Invalid local application port.');
  const draftBridgePort = Number(flag('--draft-bridge-port') ?? '19527');
  if (!Number.isInteger(draftBridgePort) || draftBridgePort < 1024 || draftBridgePort > 65535) throw new Error('Invalid local draft companion port.');
  for (const folder of ['config', 'postgres', 'storage', 'data', 'data/videos', 'data/renderers', 'tts-cache', 'model-auth', 'model-cache', 'delivery-private/youtube', 'delivery-private/google', 'delivery-private/draft-bridge']) await mkdir(join(root, folder), { recursive: true, mode: 0o700 });
  const mappings = Object.entries(serviceNames).map(([service, name]) => [`supabase_${name}_${suffix}`, service]);
  const services = {};
  for (const [service, short] of Object.entries(serviceNames)) {
    const container = source.find(item => item.Name === `/supabase_${short}_${suffix}`); if (!container) throw new Error('Source service is unavailable.');
    const environment = Object.fromEntries(container.Config.Env.map(entry => { const i = entry.indexOf('='); return [entry.slice(0, i), portable(entry.slice(i + 1), mappings)]; }));
    services[service] = { image: container.Config.Image, environment, entrypoint: portable(container.Config.Entrypoint, mappings), command: portable(container.Config.Cmd, mappings) };
    if (container.Config.Entrypoint?.[0] === 'sh' && container.Config.Entrypoint?.[1] === '-c' && container.Config.Entrypoint.length === 3) {
      const script = portable(container.Config.Entrypoint[2], mappings).replaceAll('$$', '$');
      await privateFile(join(config, `${service}-entrypoint.sh`), `#!/bin/sh\n${script}\n`);
      services[service].entrypoint = ['sh', `/private-config/${service}-entrypoint.sh`];
      services[service].volumes = [`\${STUDIO_DOCKER_ROOT}/config/${service}-entrypoint.sh:/private-config/${service}-entrypoint.sh:ro`];
    }
    if (container.Config.User) services[service].user = container.Config.User;
    // Non-volume service configuration is captured in private generated entrypoints; business bytes use bind roots below.
    if (service === 'postgres' || service === 'storage') {
      const destination = service === 'postgres' ? '/var/lib/postgresql/data' : '/mnt';
      const mount = container.Mounts.find(item => item.Destination === destination);
      if (!mount || mount.Type !== 'volume' || !mount.Name?.endsWith(suffix)) throw new Error('Source volume ownership or destination differs.');
      await run('docker', ['run', '--rm', '--user', '0:0', '--entrypoint', 'sh', '--mount', `type=volume,src=${mount.Name},dst=/source,readonly`, '--mount', `type=bind,src=${join(root, service)},dst=/target`, container.Config.Image, '-c', 'cp -a /source/. /target/']);
    }
  }
  await privateFile(join(config, 'supabase.compose.json'), `${JSON.stringify({ services }, null, 2)}\n`);
  await copyTree(dataSource, join(root, 'data'), new Set(['runtime.env', 'youtube', 'google', 'backup.key', 'worker-ready.json', 'backups', 'container-rebind']));
  for (const name of ['youtube', 'google']) { const path = join(dataSource, name); if (await stat(path).then(() => true).catch(() => false)) await copyTree(path, join(root, 'delivery-private', name)); }
  await seedJournalMarkers(join(root,'data/publication-journals'),(await readdir(join(root,'delivery-private/youtube/uploads')).catch(()=>[])).map(name=>/^([a-f0-9-]{36})\.json$/.exec(name)?.[1]).filter(Boolean));
  const relocation = join(root, 'data', 'relocation.json');
  if (!await stat(relocation).then(() => true).catch(() => false)) await privateFile(relocation, JSON.stringify({ originalDataRoot: dataSource }));
  await privateFile(join(config, 'application.env'), envText({ SUPABASE_URL: 'http://kong:8000', SUPABASE_SECRET_KEY: runtime.SUPABASE_SECRET_KEY, STUDIO_WORKSPACE_ID: runtime.STUDIO_WORKSPACE_ID, STUDIO_LOCAL_RUNTIME: 'true' }));
  await privateFile(join(config, 'compose.env'), envText({ STUDIO_DOCKER_ROOT: root, STUDIO_COMPOSE_PROJECT: flag('--project') ?? `content-studio-docker-${randomUUID().slice(0, 8)}`, STUDIO_UID: process.env.STUDIO_HOST_UID ?? process.getuid?.() ?? 1000, STUDIO_GID: process.env.STUDIO_HOST_GID ?? process.getgid?.() ?? 1000, STUDIO_WEB_PORT: webPort, STUDIO_SUPABASE_PORT: Number(flag('--supabase-port') ?? 56421), STUDIO_DATABASE_PORT: Number(flag('--database-port') ?? 56422), STUDIO_DRAFT_BRIDGE_PORT: draftBridgePort }));
  const uid = Number(process.env.STUDIO_HOST_UID ?? process.getuid?.() ?? 1000); const gid = Number(process.env.STUDIO_HOST_GID ?? process.getgid?.() ?? 1000);
  async function ownership(path) { await chown(path, uid, gid); if ((await stat(path)).isDirectory()) for (const name of await readdir(path)) await ownership(join(path, name)); }
  for (const name of ['data','config','model-auth','model-cache','delivery-private','tts-cache']) await ownership(join(root,name));
  await compose(['config', '--quiet']);
  console.log(JSON.stringify({ captured: true, root, originalContainersUnchanged: true, privateConfigCaptured: true, applicationPort: webPort, servicesStarted: false }));
}
async function sql(statement, output, user = 'postgres') { return compose(['exec', '-T', 'postgres', 'sh', '-c', 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec "$@"', 'sh', 'psql', '-U', user, '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'], { input: statement, output }); }
async function pause() {
  await sql("select cron.alter_job(jobid,active:=false) from cron.job where jobname like 'content-studio-%'; update public.content_studio_workspaces set state=jsonb_set(state,'{paused}','true'::jsonb),revision=revision+1,updated_at=now() where state->>'paused' is distinct from 'true';");
}
async function quiesceRestore() {
  await sql(`begin;
    select pgmq.archive('studio_jobs',array_agg(msg_id)) from pgmq.q_studio_jobs having count(*)>0;
    delete from public.studio_queue_leases;
    update public.studio_operations set status=case when status in('queued','running') then 'failed' else status end,phase=case when status in('queued','running') then 'Restored checkpoint; operator retry required' else phase end,error=case when status in('queued','running') then 'Restore interrupted active work; retry explicitly to resume preserved checkpoints.' else error end,owner_token=null,lease_until=null,updated_at=now() where status in('queued','running') or owner_token is not null or lease_until is not null;
    update public.studio_task_runs set status=case when status in('queued','researching','generating') then 'failed' else status end,phase=case when status in('queued','researching','generating') then 'restore_interrupted' else phase end,error=case when status in('queued','researching','generating') then 'Restore interrupted active work; retry explicitly to resume preserved checkpoints.' else error end,lease_token=null,lease_expires_at=null,finished_at=coalesce(finished_at,now()),updated_at=now() where status in('queued','researching','generating') or lease_token is not null or lease_expires_at is not null;
    update public.studio_video_projects p set content=jsonb_set(jsonb_set(p.content,'{renders}',coalesce((select jsonb_agg(case when render->>'status'='running' then render || jsonb_build_object('status','failed','phase','Restore interrupted render; explicit retry required','error','Restore interrupted rendering; cached stages and checkpoints are preserved.','finishedAt',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'heartbeatAt',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) else render end order by position) from jsonb_array_elements(p.content->'renders') with ordinality entries(render,position)),'[]'::jsonb)),'{status}',to_jsonb(case when exists(select 1 from jsonb_array_elements(p.content->'renders') render where render->>'status'='succeeded' and render->>'revision'=p.content->>'revision') then 'ready'::text else 'editing'::text end)),updated_at=now() where p.content->>'status'='rendering' or exists(select 1 from jsonb_array_elements(p.content->'renders') render where render->>'status'='running');
    update public.content_studio_workspaces w set state=jsonb_set(w.state,'{jobs}',coalesce((select jsonb_agg(case when job->>'status'='submitting' then (job-'submissionOwner') || jsonb_build_object('submissionOwner',null,'status','needs_reconciliation','error','Restored upload ownership requires reconciliation; historical snapshot and journal are preserved.') else job end order by position) from jsonb_array_elements(w.state->'jobs') with ordinality entries(job,position)),'[]'::jsonb)),revision=revision+1,updated_at=now() where exists(select 1 from jsonb_array_elements(w.state->'jobs') job where job->>'status'='submitting');
    do $$begin
      if to_regclass('public.studio_account_execution_leases') is not null then execute 'update public.studio_account_execution_leases set owner_token=null,expires_at=now()';end if;
      if to_regclass('public.studio_metric_polls') is not null then execute 'update public.studio_metric_polls set enabled=false,blocked_reason=''RESTORED_PAUSED''';end if;
      if to_regclass('public.studio_metric_attempts') is not null then execute 'update public.studio_metric_attempts set status=''failed'',error=''RESTORE_INTERRUPTED'',finished_at=now() where status=''queued''';end if;
    end $$;
    commit;`);
}
async function seedJournalMarkers(directory, ids) {
  await mkdir(directory,{recursive:true,mode:0o700});
  for(const id of ids) {
    if(!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid protected upload journal ID.');
    const path=join(directory,`${id}.json`);
    if(!await stat(path).then(()=>true).catch(()=>false)) await privateFile(path,JSON.stringify({jobId:id,restoredJournalMarker:true}));
  }
}
async function migrate() {
  const applied = new Set((await sql('select version from supabase_migrations.schema_migrations;')).trim().split('\n'));
  for (const file of (await readdir(join(project, 'supabase', 'migrations'))).sort()) {
    const version = /^([0-9]+)_[a-z0-9_-]+\.sql$/i.exec(file)?.[1]; if (!version || applied.has(version)) continue;
    const content = await readFile(join(project, 'supabase', 'migrations', file), 'utf8');
    await sql(`begin;\n${content}\ninsert into supabase_migrations.schema_migrations(version,name,statements) values('${version}','${file.slice(version.length + 1, -4)}',array[]::text[]);\ncommit;`);
  }
  await pause(); console.log('Pending migrations applied; scheduling and publishing remain paused.');
}
async function hashes(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const key = prefix ? `${prefix}/${entry.name}` : entry.name; const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Backup refuses symbolic links.');
    if (entry.isDirectory()) files.push(...await hashes(path, key));
    else if (entry.isFile()) { const handle = await open(path, 'r'); const hash = createHash('sha256'); let size = 0; try { for await (const chunk of handle.createReadStream()) { hash.update(chunk); size += chunk.length; } } finally { await handle.close(); } files.push({ key, size, sha256: hash.digest('hex') }); }
  }
  return files.sort((a, b) => a.key.localeCompare(b.key));
}
async function encryptionKey(create = false) {
  const path = resolve(flag('--key-file') ?? join(root, 'backup.key'));
  let key;
  try { key = await readFile(path); }
  catch { if (!create) throw new Error('Supply --key-file with the separate backup encryption key.'); key = randomBytes(32); await privateFile(path,key); await chown(path,Number(process.env.STUDIO_HOST_UID ?? process.getuid?.() ?? 1000),Number(process.env.STUDIO_HOST_GID ?? process.getgid?.() ?? 1000)); }
  if (key.length !== 32) throw new Error('Backup encryption key must contain exactly 32 bytes.'); return key;
}
async function encryptFile(path, key, name) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(name));
  const destination = `${path}.enc`; const output = await open(destination,'wx',0o600);
  try { await output.writeFile(Buffer.concat([iv,Buffer.alloc(16)])); for await (const chunk of createReadStream(path)) await output.writeFile(cipher.update(chunk)); await output.writeFile(cipher.final()); await output.write(cipher.getAuthTag(),0,16,12); await output.sync(); }
  catch (error) { await rm(destination,{force:true}); throw error; }
  finally { await output.close(); }
  await rm(path);
}
async function decryptFile(source, destination, key, name) {
  const input = await open(source,'r'); const header = Buffer.alloc(28);
  try { const read = await input.read(header,0,28,0); if(read.bytesRead!==28) throw new Error('Encrypted backup is truncated.'); } finally { await input.close(); }
  const decipher = createDecipheriv('aes-256-gcm',key,header.subarray(0,12)); decipher.setAAD(Buffer.from(name)); decipher.setAuthTag(header.subarray(12));
  await mkdir(dirname(destination),{recursive:true,mode:0o700});
  try { await pipeline(createReadStream(source,{start:28}),decipher,createWriteStream(destination,{flags:'wx',mode:0o600})); }
  catch (error) { await rm(destination,{force:true}); throw error; }
}
const privateBackupFile = key => /^(config|model-auth|model-cache|delivery-private)\//.test(key) || ['database.dump','roles.sql','graphql-functions.sql','pgmq-studio.json'].includes(key) || /^data\/browser-journals\//.test(key);
async function protectBackup(destination) {
  const keyPath=resolve(flag('--key-file')??join(root,'backup.key'));
  if(keyPath===destination || keyPath.startsWith(`${destination}${sep}`)) throw new Error('Encryption key must stay outside the backup folder.');
  const key = await encryptionKey(true); const before = await hashes(destination);
  const previous=await readFile(join(destination,'manifest.json'),'utf8').then(JSON.parse).catch(()=>({}));
  const journalIds = [...new Set([...(previous.journalIds??[]),...before.map(file=>/^(?:delivery-private\/youtube\/uploads|data\/publication-journals)\/([a-f0-9-]{36})\.json(?:\.enc)?$/.exec(file.key)?.[1]).filter(Boolean)])];
  for(const file of before) if(privateBackupFile(file.key) && !file.key.endsWith('.enc')) await encryptFile(join(destination,file.key),key,file.key);
  return {journalIds,inventory:(await hashes(destination)).filter(file=>file.key!=='manifest.json')};
}
async function backup() {
  const destination = resolve(flag('--target') ?? join(project, '.docker-backups', new Date().toISOString().replaceAll(':', '-')));
  if(destination===root || destination.startsWith(`${root}${sep}`)) throw new Error('Backup destination must stay outside the bind root.');
  const keyPath=resolve(flag('--key-file')??join(root,'backup.key'));
  if(keyPath===destination || keyPath.startsWith(`${destination}${sep}`)) throw new Error('Encryption key must stay outside the backup folder.');
  if (await stat(destination).then(() => true).catch(() => false)) throw new Error('Backup destination already exists.');
  await compose(['stop', 'api', 'article-worker', 'video-worker', 'delivery-worker', 'draft-bridge']); await pause();
  await writeBackupDestination(destination,async()=>{
  await compose(['exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--format=custom'], { output: join(destination, 'database.dump') });
  await sql("select coalesce(string_agg(pg_get_functiondef(p.oid)||E';\\n'||format('alter function %s owner to %I;',p.oid::regprocedure,pg_get_userbyid(p.proowner)),E'\\n'),'') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='graphql_public';",join(destination,'graphql-functions.sql'));
  await sql("select jsonb_build_object('queue',coalesce((select jsonb_agg(to_jsonb(q)) from pgmq.q_studio_jobs q),'[]'::jsonb),'archive',coalesce((select jsonb_agg(to_jsonb(a)) from pgmq.a_studio_jobs a),'[]'::jsonb));",join(destination,'pgmq-studio.json'));
  await compose(['exec', '-T', 'postgres', 'pg_dumpall', '-U', 'postgres', '--globals-only'], { output: join(destination, 'roles.sql') });
  await compose(['stop']);
  await copyBackupTrees(root,destination);
  const {inventory,journalIds}=await protectBackup(destination); await privateFile(join(destination, 'manifest.json'), JSON.stringify({format:3, encryption:'aes-256-gcm', inventory, journalIds, paused:true, createdAt:new Date().toISOString()},null,2));
  console.log(JSON.stringify({ backup: destination, portableLogicalDatabaseDump: true, rawPGDATAExcluded: true, verifiedFiles: inventory.length, servicesStopped: true, containsPrivateState: true }));
  });
}
async function restore() {
  const source = flag('--source'); if (!source) throw new Error('Restore requires --source backup-folder and --root new-bind-root.');
  const draftBridgePort = Number(flag('--draft-bridge-port') ?? '19528');
  if (!Number.isInteger(draftBridgePort) || draftBridgePort < 1024 || draftBridgePort > 65535) throw new Error('Invalid local draft companion port.');
  if (await readdir(root).then(entries => entries.length > 0).catch(() => false)) throw new Error('Restore requires an empty bind root.');
  const folder = resolve(source); const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
  if (manifest.format !== 3 || manifest.encryption !== 'aes-256-gcm' || !manifest.paused) throw new Error('Unsupported or unpaused backup.');
  const actual = (await hashes(folder)).filter(file => file.key !== 'manifest.json');
  if (JSON.stringify(actual) !== JSON.stringify(manifest.inventory)) throw new Error('Backup hashes differ.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const key = await encryptionKey();
  for (const file of actual) {
    const name = file.key.endsWith('.enc') ? file.key.slice(0,-4) : file.key;
    if (!args.includes('--restore-private') && /^(model-auth|model-cache|delivery-private)\//.test(name)) continue;
    const destination = resolve(root,name); if(!destination.startsWith(`${root}${sep}`)) throw new Error('Backup file escapes its restore root.');
    if(file.key.endsWith('.enc')) await decryptFile(join(folder,file.key),destination,key,name);
    else { await mkdir(dirname(destination),{recursive:true,mode:0o700}); await cp(join(folder,file.key),destination,{errorOnExist:true,force:false}); }
  }
  for (const name of ['postgres','model-auth','model-cache','delivery-private/youtube/uploads','delivery-private/google','delivery-private/draft-bridge','tts-cache']) await mkdir(join(root,name),{recursive:true,mode:0o700});
  if(!args.includes('--restore-private')) for(const id of manifest.journalIds??[]) {
    if(!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid protected upload journal ID.');
    await privateFile(join(root,'delivery-private/youtube/uploads',`${id}.json`),JSON.stringify({jobId:id,restoredJournalMarker:true}));
  }
  await seedJournalMarkers(join(root,'data/publication-journals'),manifest.journalIds??[]);
  const env = await settings(); env.STUDIO_DOCKER_ROOT = root; env.STUDIO_COMPOSE_PROJECT = flag('--project') ?? `content-studio-restore-${randomUUID().slice(0, 8)}`; env.STUDIO_UID = process.env.STUDIO_HOST_UID ?? process.getuid?.() ?? 1000; env.STUDIO_GID = process.env.STUDIO_HOST_GID ?? process.getgid?.() ?? 1000; env.STUDIO_WEB_PORT = Number(flag('--port') ?? 15310); env.STUDIO_SUPABASE_PORT = Number(flag('--supabase-port') ?? 57421); env.STUDIO_DATABASE_PORT = Number(flag('--database-port') ?? 57422);
  env.STUDIO_DRAFT_BRIDGE_PORT = draftBridgePort;
  await writeFile(join(config, 'compose.env'), envText(env), { mode: 0o600 });
  async function ownership(path) { await chown(path, Number(env.STUDIO_UID), Number(env.STUDIO_GID)); if ((await stat(path)).isDirectory()) for (const name of await readdir(path)) await ownership(join(path,name)); }
  for (const name of ['data','config','model-auth','model-cache','delivery-private','tts-cache']) await ownership(join(root,name));
  await compose(['config', '--quiet']);
  await compose(['up','-d','--wait','postgres']);
  const globals = (await readFile(join(root,'roles.sql'),'utf8')).replace(/^CREATE ROLE (\"(?:[^\"]|\"\")+\"|[a-zA-Z_][a-zA-Z_0-9]*);$/gm, (_match, role) => `DO $role$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role.replace(/^\"|\"$/g,'').replaceAll("'","''")}') THEN CREATE ROLE ${role}; END IF; END $role$;`);
  await sql(globals, undefined, 'supabase_admin');
  await compose(['exec','-T','postgres','sh','-c','export PGPASSWORD="$POSTGRES_PASSWORD"; exec "$@"','sh','psql','-U','supabase_admin','-d','template1','-X','-v','ON_ERROR_STOP=1','-c','DROP DATABASE postgres WITH (FORCE);','-c','CREATE DATABASE postgres OWNER postgres;']);
  await run('docker',['cp',join(root,'database.dump'),`${env.STUDIO_COMPOSE_PROJECT}-postgres-1:/tmp/studio-restore.dump`]);
  const toc=await compose(['exec','-T','postgres','pg_restore','--list','/tmp/studio-restore.dump']);
  const lines=toc.split('\n'); const graphqlACL=line=>/ ACL graphql_public FUNCTION graphql\(/.test(line);
  await privateFile(join(root,'restore.list'),lines.filter(line=>!graphqlACL(line)).join('\n'));
  await privateFile(join(root,'graphql-acl.list'),lines.filter(graphqlACL).join('\n'));
  for(const file of ['restore.list','graphql-acl.list']) await run('docker',['cp',join(root,file),`${env.STUDIO_COMPOSE_PROJECT}-postgres-1:/tmp/${file}`]);
  const restoreSection = section=>compose(['exec','-T','postgres','sh','-c','export PGPASSWORD="$POSTGRES_PASSWORD"; exec "$@"','sh','pg_restore','-U','supabase_admin','-d','postgres','--exit-on-error','--use-list=/tmp/restore.list',`--section=${section}`,'/tmp/studio-restore.dump']);
  await restoreSection('pre-data');
  await sql(await readFile(join(root,'graphql-functions.sql'),'utf8'),undefined,'supabase_admin');
  await restoreSection('data'); await restoreSection('post-data');
  await compose(['exec','-T','postgres','sh','-c','export PGPASSWORD="$POSTGRES_PASSWORD"; exec "$@"','sh','pg_restore','-U','supabase_admin','-d','postgres','--exit-on-error','--use-list=/tmp/graphql-acl.list','/tmp/studio-restore.dump']);
  for(const file of ['restore.list','graphql-acl.list']) { await rm(join(root,file)); await compose(['exec','-T','postgres','rm',`/tmp/${file}`]); }
  const queue=JSON.parse(await readFile(join(root,'pgmq-studio.json'),'utf8'));
  const literal=value=>JSON.stringify(value).replaceAll("'","''");
  await sql(`select pgmq.create('studio_jobs'); insert into pgmq.q_studio_jobs overriding system value select * from jsonb_populate_recordset(null::pgmq.q_studio_jobs,'${literal(queue.queue)}'::jsonb); insert into pgmq.a_studio_jobs select * from jsonb_populate_recordset(null::pgmq.a_studio_jobs,'${literal(queue.archive)}'::jsonb); select setval(pg_get_serial_sequence('pgmq.q_studio_jobs','msg_id'),greatest(coalesce((select max(msg_id) from pgmq.q_studio_jobs),0),coalesce((select max(msg_id) from pgmq.a_studio_jobs),0),1),true);`);
  await rm(join(root,'pgmq-studio.json'));
  await pause(); await quiesceRestore(); await rm(join(root,'graphql-functions.sql')); await rm(join(root,'database.dump')); await rm(join(root,'roles.sql')); await compose(['exec','-T','postgres','rm','/tmp/studio-restore.dump']);
  console.log(JSON.stringify({ restored: true, root, filesVerified: actual.length, servicesStarted: false, publishingPaused: true, privateStateRestored:args.includes('--restore-private') }));
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) try {
  if (action === 'protect-backup') { const destination=resolve(flag('--source')); const old=JSON.parse(await readFile(join(destination,'manifest.json'),'utf8')); const {inventory,journalIds}=await protectBackup(destination); await writeFile(join(destination,'manifest.json'),JSON.stringify({...old,format:3,encryption:'aes-256-gcm',inventory,journalIds},null,2),{mode:0o600}); console.log('Private backup files encrypted; key retained outside backup.'); }
  else if (action === 'capture') await capture();
  else if (action === 'youtube-auth') await authorizeYouTube();
  else if (action === 'config') { await compose(['config', '--quiet']); console.log('Compose configuration is valid.'); }
  else if (action === 'build') {
    await compose(['build'], { timeout: 1800000 });
    const references=[...new Set((await compose(['config','--images'])).trim().split('\n').filter(Boolean))];
    const format='{"tags":{{json .RepoTags}},"id":{{json .Id}},"digests":{{json .RepoDigests}},"os":{{json .Os}},"architecture":{{json .Architecture}}}';
    const images=(await run('docker',['image','inspect','--format',format,...references])).trim().split('\n').map(line=>JSON.parse(line));
    await writeFile(join(config,'images.lock.json'),JSON.stringify({builtAt:new Date().toISOString(),images},null,2),{mode:0o600});
    console.log('Application, model, renderer and TTS images built; immutable image identities recorded.');
  }
  else if (action === 'browser-config') {
    await prepareDraftBridgeDirectory(root,Number(process.env.STUDIO_HOST_UID ?? 1000),Number(process.env.STUDIO_HOST_GID ?? 1000));
    const browserConfig=join(root,'delivery-private','browser-publisher','config.json');
    if(!await stat(browserConfig).then(()=>true).catch(()=>false)) await privateFile(browserConfig,JSON.stringify({version:1,serviceKey:randomBytes(32).toString('base64url'),sessionId:randomUUID(),fixturesEnabled:args.includes('--fixtures'),fixtureScenario:'normal'}));
    for(const name of ['browser-private/profiles','browser-private/state','data/browser-journals','browser-staging']) {const path=join(root,name);await mkdir(path,{recursive:true,mode:0o700});await chown(path,name==='browser-private/profiles'?1200:Number(process.env.STUDIO_HOST_UID??1000),name==='browser-private/profiles'?1200:Number(process.env.STUDIO_HOST_GID??1000));}
    await chown(join(root,'delivery-private','browser-publisher'),Number(process.env.STUDIO_HOST_UID??1000),Number(process.env.STUDIO_HOST_GID??1000));await chown(browserConfig,Number(process.env.STUDIO_HOST_UID??1000),Number(process.env.STUDIO_HOST_GID??1000));
    const env=await settings(); if(!env.STUDIO_BROWSER_VNC_PASSWORD) {env.STUDIO_BROWSER_VNC_PASSWORD=randomBytes(16).toString('base64url');await writeFile(join(config,'compose.env'),envText(env),{mode:0o600});}
    console.log('Optional browser slot configured; live publishing stays disabled and credentials remain private.');
  }
  else if (action === 'browser-start') {await compose(['--profile','browser-publisher','build','browser-publisher'],{timeout:1800000});await compose(['--profile','browser-publisher','up','-d','--wait','browser','browser-publisher'],{timeout:600000});console.log('Optional browser services started.');}
  else if (action === 'database') { await compose(['up', '-d', '--wait', 'postgres', 'rest', 'auth', 'storage', 'mail', 'kong']); await pause(); console.log('Supabase Docker services started with publishing and scheduling paused.'); }
  else if (action === 'migrate') await migrate();
  else if (action === 'start') { const env = await settings(); await prepareDraftBridgeDirectory(root, Number(env.STUDIO_UID), Number(env.STUDIO_GID)); await compose(['up', '-d', '--wait']); console.log('All Docker services started.'); }
  else if (action === 'stop') { await compose(['stop']); console.log('Docker services stopped; bind data retained.'); }
  else if (action === 'status') console.log(await compose(['ps', '--format', 'json']));
  else if (action === 'backup') await backup();
  else if (action === 'restore') await restore();
  else throw new Error('Usage: node scripts/docker.mjs capture|config|build|database|migrate|start|stop|status|backup|restore|youtube-auth|browser-config|browser-start [--root folder]');
} catch (error) { console.error(error instanceof Error ? error.message : 'Docker operation failed.'); process.exitCode = 1; }

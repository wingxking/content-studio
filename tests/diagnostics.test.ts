import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiagnosticStore, diagnosticRecord } from "../src/core/diagnostics.ts";

test("diagnostics discard all unapproved payload, credentials and raw error fields", () => {
  const record = diagnosticRecord({event:"http.failed",level:"warn",service:"api",requestId:randomUUID(),token:"secret",headers:{cookie:"private"},url:"https://example.com?token=private",error:"/private/secret",body:"draft text"});
  assert.doesNotMatch(JSON.stringify(record), /secret|private|draft text|headers|url|error/u);
  assert.throws(() => diagnosticRecord({event:"unknown raw text",level:"warn",service:"api"}));
  assert.throws(() => diagnosticRecord({event:"http.failed",level:"warn",service:"api",requestId:"Bearer secret"}));
});
test("diagnostics persist, filter and page without repeating records; ignore symlinks and report corrupt lines", async () => {
  const root = await mkdtemp(join(tmpdir(),"studio-logs-"));
  try {
    const store = createDiagnosticStore(root); const jobId=randomUUID();
    for(let index=0;index<7;index++) await store.append({event:"work.completed",level:index%2 ? "warn":"info",service:"delivery",jobId});
    const first = await store.query({limit:3}); const second = await store.query({limit:3,cursor:first.nextCursor});
    assert.equal(first.items.length,3); assert.equal(second.items.length,3); assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,6);
    assert.equal((await store.query({level:"warn",jobId})).items.length,3);
    assert.equal((await store.query({jobId:randomUUID()})).items.length,0);
    await writeFile(join(root,`events-${randomUUID()}-0.ndjson`),"broken json\n");
    const outside=join(root,"private.txt");await writeFile(outside,"secret");await symlink(outside,join(root,`events-${randomUUID()}-0.ndjson`));
    assert.equal((await store.query()).invalidLines,1);
    assert.doesNotMatch(JSON.stringify(await store.query()),/secret/u);
  } finally {await rm(root,{recursive:true,force:true});}
});
test("diagnostics bound disk retention after rotation and keep independent writers", async () => {
  const root=await mkdtemp(join(tmpdir(),"studio-log-retention-"));
  try {
    const first=createDiagnosticStore(root,{segmentBytes:400,maxBytes:1200});const second=createDiagnosticStore(root,{segmentBytes:400,maxBytes:1200});
    for(let i=0;i<20;i++) await (i%2 ? first:second).append({event:"work.completed",level:"info",service:"article"});
    const files=(await readdir(root)).filter(name=>name.endsWith(".ndjson"));
    const total=(await Promise.all(files.map(name=>readFile(join(root,name))))).reduce((sum,buffer)=>sum+buffer.length,0);
    assert.ok(total<=1200);assert.ok((await first.query()).items.length>0);
    const future=createDiagnosticStore(root,{now:()=>Date.now()+15*86400000});assert.equal((await future.query()).items.length,0);
  }finally{await rm(root,{recursive:true,force:true});}
});
test("a low-traffic writer cannot renew an expired record by appending to its segment", async () => {
  const root=await mkdtemp(join(tmpdir(),"studio-log-age-"));
  try {
    let now=Date.now()-15*86400000; const store=createDiagnosticStore(root,{now:()=>now});
    await store.append({event:"work.completed",level:"info",service:"article"});
    now=Date.now(); await store.append({event:"work.completed",level:"info",service:"article"});
    assert.equal((await store.query()).items.length,1);
    assert.equal((await readdir(root)).length,1);
  }finally{await rm(root,{recursive:true,force:true});}
});

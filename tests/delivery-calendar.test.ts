import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { summarizeDeliveryCalendar } from "../src/application/delivery-calendar.ts";
import { deliveryIntentSchema } from "../src/contracts/workbench.ts";
import { deliveryFingerprint } from "../src/core/delivery-preflight.ts";

test("full calendar counts more than 50 jobs, local day boundaries, manual work and failures",()=>{
  const jobs=Array.from({length:80},()=>({status:"scheduled" as const,scheduledAt:"2026-10-21T16:30:00.000Z"}));
  const result=summarizeDeliveryCalendar([...jobs,{status:"awaiting_operator",scheduledAt:"2026-10-22T01:00:00.000Z"},{status:"failed",scheduledAt:"2026-10-22T02:00:00.000Z"},{status:"scheduled",deliveryAction:"save_draft",scheduledAt:"2026-10-22T02:00:00.000Z"},{status:"published",scheduledAt:"2026-11-01T01:00:00.000Z"}],{month:"2026-10",timezone:"Asia/Singapore"});
  assert.equal(result.total,82);assert.equal(result.days[0]?.date,"2026-10-22");assert.equal(result.days[0]?.states.scheduled,80);
  assert.throws(()=>summarizeDeliveryCalendar([],{month:"2026-13"}));assert.throws(()=>summarizeDeliveryCalendar([],{month:"2026-10",timezone:"Invalid/Zone"}));
});
test("schedule and timezone bind preflight identity while old immediate commands retain shape",()=>{
  const base={subjectKind:"article",articleId:randomUUID(),accountId:randomUUID(),expectedRevision:1,action:"publish"};
  const old=deliveryIntentSchema.parse(base);assert.deepEqual(old,base);
  const scheduled=deliveryIntentSchema.parse({...base,scheduledAt:"2026-12-01T10:00:00.000Z",timezone:"Asia/Singapore"});
  assert.notEqual(deliveryFingerprint(old),deliveryFingerprint(scheduled));
  assert.notEqual(deliveryFingerprint(scheduled),deliveryFingerprint({...scheduled,timezone:"UTC"}));
  assert.throws(()=>deliveryIntentSchema.parse({...base,scheduledAt:scheduled.scheduledAt}));
  assert.throws(()=>deliveryIntentSchema.parse({...scheduled,action:"save_draft"}));
});

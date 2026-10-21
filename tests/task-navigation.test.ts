import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { creationKind, createTaskHref, taskContentHref } from "../src/ui/task-navigation.ts";
import { publishingCalendarSelection } from "../src/ui/publishing-calendar-state.ts";

test("creation links retain the requested type and reject unknown types", () => {
  for (const kind of ["content", "discovery", "video"] as const) {
    const url = new URL(createTaskHref(kind), "http://localhost");
    assert.equal(url.pathname, "/tasks/new");
    assert.equal(creationKind(url.searchParams.get("type")), kind);
  }
  assert.equal(creationKind(null), "content");
  assert.equal(creationKind("unexpected"), "content");
});

test("publication calendar uses Singapore month boundaries and validates selected days", () => {
  const transition = new Date("2026-09-30T17:00:00Z");
  assert.deepEqual(publishingCalendarSelection(null, null, transition), {month:"2026-10",day:"2026-10-01",days:31,leading:4});
  assert.equal(publishingCalendarSelection("2028-02", "2028-02-29", transition).day,"2028-02-29");
  assert.equal(publishingCalendarSelection("2028-02", "2028-02-30", transition).day,"2028-02-01");
  assert.equal(publishingCalendarSelection("2026-10", "2026-10-00", transition).day,"2026-10-01");
  const prior = process.env.TZ;
  try {
    process.env.TZ="America/Los_Angeles";
    assert.equal(publishingCalendarSelection("2026-10",null,transition).leading,4);
  } finally {if(prior === undefined) delete process.env.TZ; else process.env.TZ=prior;}
});

test("delivery deep links preserve the exact article and job within a task episode", () => {
  const ref = { kind: "plan" as const, id: randomUUID() };
  const context = { episodeId: randomUUID(), articleId: randomUUID(), jobId: randomUUID() };
  const url = new URL(taskContentHref(ref, "publish", context), "http://localhost");
  assert.equal(url.pathname, `/tasks/plan/${ref.id}/publish`);
  assert.equal(url.searchParams.get("episode"), context.episodeId);
  assert.equal(url.searchParams.get("article"), context.articleId);
  assert.equal(url.searchParams.get("job"), context.jobId);
  const video = new URL(taskContentHref({kind:"video",id:ref.id}, "publish", {jobId:context.jobId}), "http://localhost");
  assert.equal(video.searchParams.get("job"), context.jobId);
  assert.equal(video.searchParams.has("article"), false);
});

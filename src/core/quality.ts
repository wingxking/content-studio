import { z } from 'zod';
import { type Draft } from './model.ts';
import { dbRequest, dbRpc } from './database.ts';
import { EvidenceFiles, evidenceHash, parseEvidencePage } from './evidence.ts';
import { fetchPublicPage } from './research.ts';
import { evidenceDocumentSchema, qualityReportSchema, topicClusterSchema, isTimeSensitiveClaim, qualityExpiresAt } from '../contracts/research.ts';
import { productionContentHash } from './production.ts';

export async function requestDraftQualityRefresh(workspace: string, draft: Draft, expectedRevision: number) {
  const revision = z.number().int().positive().parse(expectedRevision);
  if (draft.revision !== revision) throw new Error('Draft revision changed. Refresh before requesting new research.');
  if (!draft.generationEvidenceRunId) throw new Error('This article has no evidence production task to resume.');
  const runId = z.uuid().parse(await dbRpc('studio_request_evidence_refresh', {
    p_workspace: z.uuid().parse(workspace), p_draft: draft.id, p_revision: revision, p_reason: 'review_requested',
  }));
  return { runId, draftId: draft.id, expectedRevision: revision, accepted: true as const };
}

export async function runResearchArtifacts(workspace: string, runId: string) {
  const rows = z.array(z.object({ stage: z.string(), status: z.string(), artifact_ref: z.string().nullable(), attempts: z.number(), updated_at: z.string(), model: z.string().nullable(), usage: z.record(z.string(), z.unknown()).nullable().optional(), attempt_metrics: z.array(z.unknown()).optional(), started_at: z.string().optional() })).parse(await dbRequest(`studio_research_steps?workspace_id=eq.${z.uuid().parse(workspace)}&run_id=eq.${z.uuid().parse(runId)}&order=updated_at.asc`));
  const documents = new Map<string, z.infer<typeof evidenceDocumentSchema>>();
  let report: z.infer<typeof qualityReportSchema> | null = null;
  let plan: { questions: string[]; contribution: string; kind: string } | null = null;
  const decisions: { topic: string; selected: boolean; reason: string }[] = [];
  let clusters: z.infer<typeof topicClusterSchema>[] = [];
  for (const row of rows) {
    if (row.status !== 'completed' || !row.artifact_ref) continue;
    if (row.stage === 'evidence_bundle' || row.stage === 'discovery_evidence' || /^supplement_\d+$/u.test(row.stage)) {
      const bundle = z.object({ documents: z.array(evidenceDocumentSchema) }).parse(await new EvidenceFiles().read(row.artifact_ref));
      for (const document of bundle.documents) documents.set(document.id, document);
    }
    if (row.stage.startsWith('quality_')) report = qualityReportSchema.parse(await new EvidenceFiles().read(row.artifact_ref));
    if (row.stage === 'research_plan') plan = z.object({ questions: z.array(z.string()), contribution: z.string(), kind: z.string() }).parse(await new EvidenceFiles().read(row.artifact_ref));
    if (row.stage === 'select_topics') {
      const selection = z.object({ questions: z.array(z.object({ question: z.string(), audienceNeed: z.string(), angle: z.string() })), skipped: z.array(z.object({ topic: z.string(), assessment: z.object({ reasons: z.array(z.string()) }) })) }).parse(await new EvidenceFiles().read(row.artifact_ref));
      decisions.push(...selection.questions.map(item => ({ topic: item.question, selected: true, reason: `${item.audienceNeed} · ${item.angle}` })), ...selection.skipped.map(item => ({ topic: item.topic, selected: false, reason: item.assessment.reasons.join('；') })));
    }
    if (row.stage === 'topic_clusters_saved') clusters = z.array(topicClusterSchema).parse(await new EvidenceFiles().read(row.artifact_ref));
  }
  return { steps: rows.map(({ artifact_ref: _ref, ...row }) => row), documents: [...documents.values()], report, plan, decisions, clusters };
}
export async function draftQuality(workspace: string, draft: Draft) {
  if (!draft.generationEvidenceRunId) return { required: false as const, current: false, report: null };
  const runs = z.array(z.object({ id: z.uuid(), task_snapshot: z.object({ pipelineVersion: z.number().optional() }) })).parse(await dbRequest(`studio_task_runs?workspace_id=eq.${z.uuid().parse(workspace)}&id=eq.${z.uuid().parse(draft.generationEvidenceRunId)}&draft_id=eq.${draft.id}&select=id,task_snapshot&limit=1`));
  const run = runs[0]; if (!run || run.task_snapshot.pipelineVersion !== 2) return { required: true as const, current: false, report: null };
  const artifacts = await runResearchArtifacts(workspace, run.id);
  return { required: true as const, current: artifacts.report?.draftRevision === draft.revision && artifacts.report?.contentHash === productionContentHash(draft, draft.variants), report: artifacts.report, runId: run.id, documents: artifacts.documents, expiresAt: artifacts.report ? qualityExpiresAt(artifacts.report) : null };
}
export async function assertDraftQuality(workspace: string, draft: Draft, fetchPage: typeof fetchPublicPage = fetchPublicPage): Promise<void> {
  const quality = await draftQuality(workspace, draft);
  if (quality.required && (!quality.current || quality.report?.status !== 'passed')) throw new Error('This article changed or has no passing evidence review. Re-run production before delivery.');
  if (quality.required && quality.report) {
    const claims = [...quality.report.claims, ...(quality.report.platformChecks ?? []).flatMap(check => check.claims)];
    const volatileClaims = claims.filter(claim => isTimeSensitiveClaim(claim.text));
    const refresh = async (reason: string) => dbRpc('studio_request_evidence_refresh', { p_workspace: workspace, p_draft: draft.id, p_revision: draft.revision, p_reason: reason });
    if (Date.now() > Date.parse(qualityExpiresAt(quality.report))) { await refresh('review_expired'); throw new Error('Evidence review expired. A revision-bound research refresh was queued; delivery is withheld until it passes review.'); }
    for (const id of new Set(volatileClaims.flatMap(claim => claim.evidence.map(span => span.documentId)))) {
      const document = quality.documents?.find(item => item.id === id);
      if (!document) throw new Error('Time-sensitive evidence is missing; delivery withheld.');
      if (document.url.startsWith('studio-knowledge:')) {
        if (document.evidenceType !== 'test_record' || !document.publishedAt || Date.now() - Date.parse(document.publishedAt) > 86400000) throw new Error('Time-sensitive owner evidence needs a recent execution record or current primary corroboration.');
        continue;
      }
      const observed = z.array(z.object({ last_confirmed_at: z.string().nullable() })).parse(await dbRequest(`studio_evidence_documents?workspace_id=eq.${z.uuid().parse(workspace)}&id=eq.${id}&select=last_confirmed_at`))[0]?.last_confirmed_at;
      if (observed && Date.now() - Date.parse(observed) < 300000) continue;
      const page = await fetchPage(document.url, undefined, document.parserVersion.startsWith('docling-') ? 50 * 1024 * 1024 : undefined);
      const unchanged = page.mime === 'application/pdf' ? evidenceHash({ mime: page.mime, content: page.bytes.toString('base64') }) === document.originalRef : (() => { const parsed = parseEvidencePage(page.body, page.mime, page.url); return parsed.access === 'full' && evidenceHash({ text: parsed.text }) === document.sha256; })();
      if (!unchanged) { await refresh('source_changed'); throw new Error('Time-sensitive source changed. A new revision and evidence review were queued; delivery is withheld.'); }
      await dbRpc('studio_confirm_evidence', { p_workspace: workspace, p_document: id, p_observed: new Date().toISOString() });
    }
  }
}

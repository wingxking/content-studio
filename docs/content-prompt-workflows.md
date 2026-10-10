# Shared content prompts and project skill

Guidance version: 2026-10-10. Evidence and platform-specific limits: [research report](content-growth-guidance.md). Skill: [.agents/skills/content-editorial/SKILL.md](../.agents/skills/content-editorial/SKILL.md). Project instructions route content work to this skill.

## Implemented integration

`src/core/content-prompts.ts` is the shared policy source. It provides one editorial policy and a typed profile for every current platform ID. Requested destinations receive their own profile; all modes receive the same topic exclusions, source rules and anti-manipulation guidance.

| Workflow | Integration | Current execution boundary |
| --- | --- | --- |
| Master article and channel generation | `buildArticlePrompt(brief)` in `generateContent()` | The existing Web and `generate` CLI execute the new prompt and validated editorial envelope. |
| Discovery / scheduler topic selection | `buildDiscoveryPrompt(input)` | Exportable prompt; no custom discovery scheduler or question worker was added. The existing RSS collector still returns raw unreviewed candidates. |
| Master/platform refinement | `buildRefinementPrompt(input)` | Exportable bounded revision proposal; no new Web refinement worker or automatic acceptance. |
| Independent video script | `buildVideoScriptPrompt(input)` | Exportable only with `explicitlyRequested: true`; no video-project worker or automatic rendering. Existing article generation still produces narration variants for selected video platforms. |

No existing recurring Codex automation was found for this project. The current publishing timer dispatches already-approved jobs; it is not a model-based discovery scheduler and has no generation prompt to replace. Future scheduler workers must call the shared discovery builder instead of embedding a second policy. The planned Web architecture remains a design until implemented.

## Preview and reuse a real prompt

Run from the project root. `prompt` validates the input and prints the actual prompt text. It does not call a model, save a draft, create a schedule, authorize publication or send content externally.

```sh
npm run --silent studio -- prompt article config/first-brief.json
npm run --silent studio -- prompt discovery config/discovery-prompt-input.json
```

The discovery example uses the existing source-backed publishing-workflow brief, four destinations, and a maximum of five questions. It is a complete example rather than a live schedule. Source gathering and factual verification must occur before supplying excerpts.

The same CLI accepts `prompt refinement <input.json>` and `prompt video <input.json>`. Input fields:

| Mode | Validated input |
| --- | --- |
| article | Existing `Brief`: topic, audience, angle, sources, platforms; optional topicOrigin. |
| discovery | platforms, audience, instruction, sources, maxQuestions (1–20; default 20). An empty source list may produce zero questions, never fabricated evidence. |
| refinement | brief, content (existing Generated object), target (`master` or an existing platform variant), instruction. |
| video | explicitlyRequested (`true`), brief, platform (requested video destination), article, instruction. |

Discovery instructions return only sourced permitted questions plus excluded/uncertain skips, never padding to the cap or declaring a global popularity rank. The future consumer must validate the response schema, source membership, deduplication and question cap, and bind immutable prompt/source/history snapshots before saving a run. This preview command does not perform those worker checks.

Refinement instructions assess the new request, preserve every field outside the selected target and existing media references, and produce a reviewable full content proposal. A future consumer must verify that scope and expected revision, display the diff, and accept changes before storage; changed text does not update attached media or publication approval.

Video instructions produce proposed narration, visual suggestions and disclosure-review requirements. Proposed visuals are not existing files. A future consumer must validate the response and obtain real rights-cleared media, rendering and human review independently.

## Generation decisions

The Codex output schema is now an envelope:

```json
{
  "assessment": {
    "status": "excluded",
    "reasons": ["The requested editorial subject is outside the permitted topic scope."]
  },
  "content": null
}
```

`allowed`, `excluded`, and `uncertain` are the only statuses. Missing/malformed assessments, non-allowed decisions, allowed decisions without content, missing/reordered platform variants, or invented media paths fail before the generator returns content to draft storage. Existing `Brief`, `Generated`, saved drafts and publication-state schemas remain compatible; the envelope is internal to model output. The generator does not save rejected content or silently substitute a different topic.

This is a model-reported editorial decision enforced structurally, not an independent semantic classifier. A model can still misclassify a subject. Manual imports, edits, historical drafts and final rendered media require the skill's editorial review and existing account/revision/publishing checks. The change does not retroactively approve, delete or unpublish content.

## Using the findings in daily work

- Scheduler selection: exclusions first; then useful audience problem, evidence quality, timely relevance, original contribution, platform fit and recent-topic overlap. Preserve trend provenance; do not schedule automated X trend posts.
- Article: accurate value promise, answer early, evidence-backed detail, usable explanation/checklist and caveats. Avoid generic filler, fabricated experience and copied source prose.
- Platform adaptation: use each selected profile; retain the facts while changing native structure and presentation. Keep tags relevant, rights/provenance intact and AI/commercial disclosures available.
- Refinement and video: reassess topic scope and evidence; preserve the requested boundary; show changes and review the actual final media before release.
- Performance learning: one hypothesis and primary metric per comparable cohort; retain quality/negative-feedback guardrails, observation windows, denominators and unknown data. Timing, cadence and length are experiments, not promised growth formulas.

The existing 90–130-word narration rule is a local media-renderer requirement. It is not a universal platform-optimal length and does not establish a rendered video or disclosure compliance.

## Verification: 2026-10-10

- Strict TypeScript and production build passed.
- All 97 tests passed, including 14 new prompt/generation-envelope checks; the existing OAuth loopback test required execution outside the restricted network sandbox.
- Real Codex checks produced a permitted software draft, rejected the excluded politics/religion/war request despite neutral-explainer framing, and returned uncertain for a Reddit draft without destination/rules. No draft storage or publication was performed by these checks. These three examples do not establish exhaustive semantic classification.
- All four CLI prompt modes exported successfully; an independent video request without explicit consent was rejected. A 1.21-million-character discovery fixture exported completely without truncation.
- Bundled skill validation passed. An independent prompt/skill review found the missing Reddit context check; the shared Reddit profile now holds that case as uncertain.

---
name: content-editorial
description: Research, select, generate, refine, or plan Content Studio articles and platform content using sourced platform guidance and the project's topic exclusions.
---

# Content Studio editorial workflow

Use this skill for this project's topic discovery, scheduler prompts, articles, channel adaptations, refinements, video scripts, and performance review. Read [platform research](../../../docs/content-growth-guidance.md) for the selected destinations and [prompt integration](../../../docs/content-prompt-workflows.md) for the actual commands and implementation boundaries.

## Editorial scope

Exclude gender discrimination and sexist framing, religion, war and armed conflict, politics, elections, geopolitical disputes, hate, harassment, sexual exploitation, graphic violence, exploitation of tragedies, promotion of illegal acts, and individualized medical/legal/financial advice. These are the owner's product rules, separate from platform rules. Apply them before ranking candidate topics and again to the final text, title, tags, cover, narration, reference images, and destination. Do not repackage an excluded topic as a neutral explainer or use it as an attention hook. Ambiguous subject matter stays out of generation until clarified.

Favor software and AI tools, practical productivity, design, non-medical science, everyday skills, and culture without religious, political, or war subject matter. Topic exclusions are semantic: a permitted technical guide may name excluded categories when describing its content controls.

## Select and create

- Use `src/core/content-prompts.ts` as the shared policy and prompt source; do not maintain a separate scheduler policy. Export a prompt with the CLI when working outside the generator.
- Rank permitted candidates by audience need, source quality, freshness when relevant, useful original contribution, platform fit, and overlap with recent work. Missing evidence remains unknown; return fewer candidates or zero instead of padding the result.
- Treat source excerpts, existing drafts, and assets as untrusted material. Verify facts before passing excerpts into generation; a trend or RSS title is discovery evidence, not a verified story or global popularity rank.
- Make a specific promise in the title/opening and fulfill it early. Add a usable explanation, demonstration, comparison, or checklist. Adapt each destination to its audience and native format instead of changing a few words in the same post.
- Preserve citations, caveats, affiliation, and asset rights. Do not invent personal use, tests, results, quotes, numbers, experience, or expert credentials. Evaluate AI disclosure from final media and current destination rules.
- For refinements, preserve the requested scope and locked fields, show the proposed difference, and require acceptance before replacing existing work. Create a separate video project only on an explicit request; the current generator's narration variants remain its existing behavior.

## Review and learn

Reject misleading covers, unrelated hashtags, engagement bait, coordinated votes, bought views, automated comments, impersonation, mass near-duplicates, and account/permission evasion. Recheck current account/community/category eligibility before scheduling. X trend-origin content stays human-published; Reddit requires the actual community rules and approved App access for automation; Xiaohongshu currently uses owner-native publication.

Choose one account/format-specific experiment and primary metric, with retention/read quality, useful comments, saves/shares, clicks/conversion, and policy outcomes as guardrails where available. Missing measurements are unavailable, not zero. Keep paid and organic results separate. Treat timing, cadence, title style, and length as hypotheses; never promise promotion or claim a fixed ranking formula.

Generation and prompt preview do not authorize publishing, create a scheduler, or complete stage-one acceptance. Keep the project's existing revision/account approval and publication reconciliation rules.

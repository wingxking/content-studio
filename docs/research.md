# Industry implementation research and decisions

Reviewed 2026-10-10 in Asia/Singapore. The linked [prior pipeline discussion](https://chatgpt.com/c/6ac9046a-b00c-83ec-ae39-6e0984eac049) was read through the authenticated chat connector. Its recommendations were starting hypotheses; this report independently rechecked current primary documentation. Price and permission details are point-in-time evidence.

## Recommended route

Build a local creator workbench around Codex generation, explicit evidence, media templates, and a durable delivery ledger. Reuse a documented publisher where possible; use Chrome and Codex for verified native workflows where accounts or APIs require it. Prefer a small number of verified adapters over adopting a large publisher stack that conflicts with Supabase or depends on undocumented browser sessions.

The present implementation supports documented Postiz text delivery for X and LinkedIn, plus native content packages for the requested Chinese/international channels. Native packages are an operator workflow, not an implemented unattended uploader. Actual account registration and publishing are separate acceptance gates.

## Products and reusable components

| Candidate | Value | Material boundary | Decision |
|---|---|---|---|
| Postiz | Established scheduling and public API | AGPL; self-host stack adds operational dependencies; platform authorization still needed | Use public API boundary, initially verified text contracts |
| AiToEarn | Broad AI/media/distribution product; local Chrome publishing plugin | MIT code; complete self-host stack uses MongoDB/Redis; hosted Server Relay for platform OAuth | Research reference and later account-specific experiment |
| Mixpost | Social management alternative | Laravel/self-host stack; editions and API scope must be assessed | More infrastructure than stage one needs |
| n8n | Visual orchestration and many integrations | Sustainable Use License; customer-configurable workflows have commercial terms | Defer unless complexity justifies it |
| Activepieces | Workflow alternative with MIT core | Enterprise features and connector entitlements are distinct | Candidate for stage-two evaluation |
| social-auto-upload | Domestic browser/video upload breadth | MIT, current refactor, sessions and site-change maintenance | Evaluate per-account behind coordinator |
| Wechatsync | Article synchronization, Chrome/CLI/MCP | GPL; several routes save drafts; website endpoints differ from official Open APIs | Run as separate local tool when article accounts are ready |
| Xiaohongshu MCP | Dedicated local publisher | Apache-2.0; manual first login and credential-bearing local session | Candidate after actual creator access |
| FFmpeg + librsvg + macOS speech | Actual local card/video production | Simple evidence slideshows, not footage generation | Implemented reusable stage-one render path |

Primary references: [Postiz](https://github.com/gitroomhq/postiz-app), [AiToEarn](https://github.com/yikart/AiToEarn), [AiToEarn deployment](https://github.com/yikart/AiToEarn/blob/main/DOCKER_DEPLOYMENT_EN.md), [n8n licensing](https://docs.n8n.io/sustainable-use-license/), [Activepieces](https://github.com/activepieces/activepieces), [social-auto-upload](https://github.com/dreammis/social-auto-upload), [Wechatsync](https://github.com/wechatsync/Wechatsync), [Xiaohongshu MCP](https://github.com/xpzouying/xiaohongshu-mcp).

## Platform realities

| Platform | Supported route in official sources | Local plan and blocker |
|---|---|---|
| X | OAuth publishing API, credit-based pricing | Configured Postiz text adapter; account/integration access missing |
| LinkedIn | Authorized posting integrations and scopes | Configured Postiz text adapter; account/integration access missing |
| Reddit | OAuth/approved API use and community rules | Native composer; observed CAPTCHA before registration |
| YouTube | OAuth upload API and native Studio | Real MP4 + native Studio; channel creation terms require action-time approval |
| TikTok | Content Posting API subject to audit and creator-facing UX | Native upload/approved integration first; private internal uploader is not an acceptable Direct Post audit use case |
| Xiaohongshu | Creator portal/App share SDK; general server publishing not confirmed | Native creator flow; phone/QR login, no verified Google SSO |
| WeChat Official Accounts | Draft/publish routes exist, account entitlement uncertain | Existing admin QR login and backend API-permission inspection |
| Bilibili | Approved official video/article submission APIs | Native creator or current biliup after login/verification |
| Kuaishou | Upload/publish/status APIs with OAuth permission | Native creator or approved API; processing is asynchronous |
| Douyin | Approved video publishing with user-perceived creation | Native creator or approved user-visible API flow |
| Instagram / Facebook | Meta account type, permissions and application access gates | Researched; native route until actual account and app setup |

See [international primary-source research](research-international.md) and [China primary-source research](research-china.md) for exact URLs, permissions, pricing and licensing details. Current official YouTube upload documentation and older overview documentation disagree about unverified-project visibility; verify the actual upload instead of repeating older private-only restrictions. The current X docs use credit pricing; older monthly-tier claims should not be treated as current.

## Publishing API contract

Postiz cloud uses `https://api.postiz.com/public/v1` with raw `Authorization: <api-key>`. `GET /integrations` identifies enabled, platform-matching accounts. One `POST /posts` creates one scheduled integration item and returns its Postiz ID. `GET /posts` exposes queue/published/error/draft state and `releaseURL`. Neither a general create idempotency key nor a live-public confirmation is guaranteed by the create response. Persist attempts first and reconcile after ambiguity. [Create](https://docs.postiz.com/public-api/posts/create), [List](https://docs.postiz.com/public-api/posts/list), [Integrations](https://docs.postiz.com/public-api/integrations/list).

Codex officially supports non-interactive pipeline execution, ephemeral sessions and schema-bound final output. Stage one uses existing local authentication and a separated publishing process. [Official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

Supabase RLS must be enabled on exposed tables. The current optional table has no browser-access policy; only the server's secret credential can access the workspace. [Supabase RLS documentation](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Product priorities

Start with original practical content based on source evidence and actual experiments. Create a master article, concise card version, and narrated short video from the same verified material. Track public links, measured analytics, production cost and audience questions. The current tool records analytics manually; scheduled automatic analytics collection and source discovery are not implemented. The workbench prepares briefs from supplied sources; it does not predict viral outcomes or guarantee revenue.

Automatic cross-platform copying is less valuable than evidence, platform adaptation, reproducible media, and reliable outcome tracking. Before adding adapters, verify the chosen accounts can create drafts, publish, survive expired authentication and recover from uncertain results. Do not equate platform icons or a configured developer dashboard with completed publishing.

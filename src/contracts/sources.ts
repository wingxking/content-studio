import { sourcePreferenceSchema, type SourcePreference } from './research.ts';

// This is a reviewed directory of discovery entrypoints, not a claim of live access or data licences.
export const sourceCatalog: SourcePreference[] = [
  { id: 'github-changelog', name: 'GitHub Changelog', url: 'https://github.blog/changelog/', feedUrl: 'https://github.blog/changelog/feed/', category: 'primary' },
  { id: 'deepseek', name: 'DeepSeek 更新', url: 'https://api-docs.deepseek.com/updates/', category: 'primary' },
  { id: 'qwen', name: 'Qwen Blog', url: 'https://qwenlm.github.io/blog/', category: 'primary' },
  { id: 'ars', name: 'Ars Technica', url: 'https://arstechnica.com/ai/', feedUrl: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
  { id: 'verge', name: 'The Verge AI', url: 'https://www.theverge.com/ai-artificial-intelligence', feedUrl: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { id: 'ieee', name: 'IEEE Spectrum AI', url: 'https://spectrum.ieee.org/topic/artificial-intelligence/', feedUrl: 'https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss' },
  { id: 'sspai', name: '少数派', url: 'https://sspai.com/', feedUrl: 'https://sspai.com/feed' },
  { id: 'infoq', name: 'InfoQ 中文', url: 'https://www.infoq.cn/', feedUrl: 'https://www.infoq.cn/feed', access: 'discovery_only' },
  { id: 'mit', name: 'MIT Technology Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/', feedUrl: 'https://www.technologyreview.com/feed/', access: 'discovery_only' },
  { id: 'producthunt', name: 'Product Hunt', url: 'https://www.producthunt.com/', feedUrl: 'https://www.producthunt.com/feed', category: 'community', access: 'discovery_only' },
  { id: 'hn', name: 'Hacker News', url: 'https://news.ycombinator.com/', scope: 'hn', category: 'community' },
  { id: 'arxiv', name: 'arXiv AI / CL / ML', url: 'https://arxiv.org/', feedUrl: 'https://rss.arxiv.org/rss/cs.AI+cs.CL+cs.LG', category: 'research', intervalMinutes: 1440 },
  { id: 'crossref', name: 'Crossref 研究元数据', url: 'https://api.crossref.org/works?query=artificial%20intelligence%20software&sort=published&order=desc&rows=30', scope: 'crossref', category: 'research', access: 'discovery_only', intervalMinutes: 1440 },
  { id: 'stackexchange', name: 'Stack Overflow AI 问题', url: 'https://stackoverflow.com/questions/tagged/artificial-intelligence', feedUrl: 'https://stackoverflow.com/feeds/tag?tagnames=artificial-intelligence&sort=newest', category: 'community', access: 'discovery_only' },
  { id: 'people-tech', name: '人民网科技', url: 'http://scitech.people.com.cn/', access: 'discovery_only', intervalMinutes: 360 },
  { id: 'wsj', name: 'WSJ Technology', url: 'https://www.wsj.com/tech', access: 'discovery_only', intervalMinutes: 360 },
  { id: 'scmp', name: 'SCMP Tech', url: 'https://www.scmp.com/tech', access: 'discovery_only', intervalMinutes: 360 },
  { id: 'reddit-local-llama', name: 'Reddit r/LocalLLaMA', url: 'https://www.reddit.com/r/LocalLLaMA/', category: 'community', access: 'requires_authorization', enabled: false },
].map(value => sourcePreferenceSchema.parse(value));

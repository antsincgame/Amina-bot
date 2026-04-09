import type { NewsSite } from '../../../../shared/types/index.js';

export const DEFAULT_AI_TECH_SOURCES: NewsSite[] = [
  { name: 'OpenAI News', url: 'https://openai.com/news/rss.xml', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Anthropic News', url: 'https://www.anthropic.com/rss.xml', enabled: false, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Google AI Blog', url: 'https://blog.google/technology/ai/rss/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'DeepMind Blog', url: 'https://deepmind.google/blog/rss.xml', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },

  { name: 'TechCrunch (AI)', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'The Verge (AI)', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Ars Technica (AI)', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'VentureBeat (AI)', url: 'https://venturebeat.com/category/ai/feed/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Wired (AI)', url: 'https://www.wired.com/feed/tag/ai/latest/rss', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },

  {
    name: 'Hacker News (AI/VibeCoding)',
    url: 'https://hn.algolia.com/api/v1/search_by_date?query=AI+OR+LLM+OR+vibecoding+OR+%22vibe+coding%22+OR+cursor+OR+copilot+OR+anthropic+OR+openai&tags=story&hitsPerPage=10',
    enabled: true, type: 'json_api', category: 'community', language: 'en',
    jsonMapping: { itemsPath: 'hits', titleField: 'title', urlField: 'url|story_url', dateField: 'created_at' },
    filterKeywords: ['llm', 'gpt', 'claude', 'openai', 'anthropic', 'gemini', 'vibecoding', 'vibe coding', 'cursor', 'copilot', 'ai agent', 'foundation model', 'open source ai', 'llama', 'mistral'],
  },
  {
    name: 'Reddit r/LocalLLaMA', url: 'https://www.reddit.com/r/LocalLLaMA/new/.rss', enabled: true, type: 'rss', category: 'community', language: 'en',
    filterKeywords: ['release', 'benchmark', 'llama', 'mistral', 'qwen', 'gemma', 'phi', 'open source', 'fine-tun', 'gguf', 'ollama', 'vllm', 'quantiz'],
  },
  {
    name: 'Reddit r/MachineLearning', url: 'https://www.reddit.com/r/MachineLearning/hot/.rss', enabled: true, type: 'rss', category: 'community', language: 'en',
    filterKeywords: ['paper', 'research', 'breakthrough', 'state-of-the-art', 'sota', 'transformer', 'diffusion', 'llm', 'gpt', 'claude', 'gemini', 'benchmark', 'open source'],
  },
  {
    name: 'GitHub Trending', url: 'https://github.com/trending', enabled: true, type: 'html_scrape', category: 'ai_tech', language: 'en',
    filterKeywords: ['llm', 'ai', 'gpt', 'agent', 'llama', 'diffusion', 'transformer', 'langchain', 'rag', 'embedding', 'fine-tun', 'inference', 'ml', 'neural'],
  },

  { name: 'Habr (AI)', url: 'https://habr.com/ru/rss/hub/artificial_intelligence/all/?fl=ru', enabled: true, type: 'rss', category: 'ai_tech', language: 'ru' },
  { name: 'Habr (Machine Learning)', url: 'https://habr.com/ru/rss/hub/machine_learning/all/?fl=ru', enabled: true, type: 'rss', category: 'ai_tech', language: 'ru' },

  { name: 'Simon Willison', url: 'https://simonwillison.net/atom/entries/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'The Batch (DeepLearning.AI)', url: 'https://www.deeplearning.ai/the-batch/feed/', enabled: false, type: 'rss', category: 'ai_tech', language: 'en' },

  { name: 'Meta AI Blog', url: 'https://ai.meta.com/blog/rss/', enabled: false, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Microsoft AI Blog', url: 'https://blogs.microsoft.com/ai/feed/', enabled: false, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Nvidia AI Blog', url: 'https://blogs.nvidia.com/feed/', enabled: false, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'arXiv cs.AI', url: 'https://rss.arxiv.org/rss/cs.AI', enabled: false, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'arXiv cs.CL (NLP/LLM)', url: 'https://rss.arxiv.org/rss/cs.CL', enabled: false, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'arXiv cs.LG (Machine Learning)', url: 'https://rss.arxiv.org/rss/cs.LG', enabled: false, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'MIT Technology Review (AI)', url: 'https://www.technologyreview.com/feed/', enabled: false, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'MarkTechPost', url: 'https://www.marktechpost.com/feed/', enabled: false, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Reddit r/artificial', url: 'https://www.reddit.com/r/artificial/hot/.rss', enabled: false, type: 'rss', category: 'community', language: 'en' },
  { name: 'Reddit r/CursorAI', url: 'https://www.reddit.com/r/CursorAI/new/.rss', enabled: false, type: 'rss', category: 'community', language: 'en' },
  { name: 'Reddit r/singularity', url: 'https://www.reddit.com/r/singularity/hot/.rss', enabled: false, type: 'rss', category: 'community', language: 'en' },
  { name: 'Reddit r/ChatGPT', url: 'https://www.reddit.com/r/ChatGPT/hot/.rss', enabled: false, type: 'rss', category: 'community', language: 'en' },
  { name: 'Stability AI Blog', url: 'https://stability.ai/blog/feed', enabled: false, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Lex Fridman Podcast', url: 'https://lexfridman.com/feed/podcast/', enabled: false, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Towards Data Science (Medium)', url: 'https://towardsdatascience.com/feed', enabled: false, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'AI News (artificialintelligence-news.com)', url: 'https://www.artificialintelligence-news.com/feed/', enabled: false, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'TLDR AI', url: 'https://tldr.tech/ai/archives', enabled: false, type: 'html_scrape', category: 'ai_tech', language: 'en' },
  { name: 'Thoughtworks Insights', url: 'https://www.thoughtworks.com/rss/insights.xml', enabled: false, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'PaperWithCode (trending)', url: 'https://paperswithcode.com/latest', enabled: false, type: 'html_scrape', category: 'ai_tech', language: 'en' },

  { name: 'Google News: Vibecoding EN', url: 'https://news.google.com/rss/search?q=%22vibe+coding%22+OR+%22AI+coding%22+OR+%22Cursor+IDE%22+OR+%22Claude+Code%22+OR+%22Copilot%22+when:7d&hl=en-US&gl=US&ceid=US:en', enabled: false, type: 'rss', category: 'ai_tech', language: 'en', tier: 'tier2', filterKeywords: ['vibe coding', 'ai coding', 'cursor', 'copilot', 'claude code', 'windsurf', 'devin', 'code generation'] },
  { name: 'Google News: Вайбкодинг RU', url: 'https://news.google.com/rss/search?q=%22%D0%B2%D0%B0%D0%B9%D0%B1%D0%BA%D0%BE%D0%B4%D0%B8%D0%BD%D0%B3%22+OR+%22AI+%D0%BA%D0%BE%D0%B4%D0%B8%D0%BD%D0%B3%22+OR+%22%D0%BD%D0%B5%D0%B9%D1%80%D0%BE%D0%BA%D0%BE%D0%B4%D0%B8%D0%BD%D0%B3%22+OR+%22Cursor+IDE%22+when:7d&hl=ru&gl=RU&ceid=RU:ru', enabled: false, type: 'rss', category: 'ai_tech', language: 'ru', tier: 'tier2', filterKeywords: ['вайбкодинг', 'нейрокодинг', 'cursor', 'copilot', 'ai кодинг'] },
  { name: 'Google News: バイブコーディング JP', url: 'https://news.google.com/rss/search?q=%22%E3%83%90%E3%82%A4%E3%83%96%E3%82%B3%E3%83%BC%E3%83%87%E3%82%A3%E3%83%B3%E3%82%B0%22+OR+%22AI%E3%82%B3%E3%83%BC%E3%83%87%E3%82%A3%E3%83%B3%E3%82%B0%22+OR+%22%E3%82%B3%E3%83%BC%E3%83%89%E7%94%9F%E6%88%90%22+OR+%22Cursor+IDE%22+OR+%22Copilot%22+when:7d&hl=ja&gl=JP&ceid=JP:ja', enabled: false, type: 'rss', category: 'asia_tech', language: 'ja', tier: 'tier2', filterKeywords: ['バイブコーディング', 'コード生成', 'AI', 'Cursor', 'Copilot', 'Claude Code'] },
  { name: 'Google News: 바이브코딩 KR', url: 'https://news.google.com/rss/search?q=%22%EB%B0%94%EC%9D%B4%EB%B8%8C+%EC%BD%94%EB%94%A9%22+OR+%22AI+%EC%BD%94%EB%94%A9%22+OR+%22%EC%BD%94%EB%93%9C+%EC%83%9D%EC%84%B1%22+OR+%22Cursor+IDE%22+when:7d&hl=ko&gl=KR&ceid=KR:ko', enabled: false, type: 'rss', category: 'asia_tech', language: 'ko', tier: 'tier2', filterKeywords: ['바이브 코딩', '코드 생성', 'AI', 'Cursor', 'Copilot', 'Claude Code'] },
  { name: 'Google News: AI编程 CN', url: 'https://news.google.com/rss/search?q=%22AI%E7%BC%96%E7%A8%8B%22+OR+%22%E4%BB%A3%E7%A0%81%E7%94%9F%E6%88%90%22+OR+%22Vibe+Coding%22+OR+%22Cursor+IDE%22+OR+%22Copilot%22+when:7d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', enabled: false, type: 'rss', category: 'asia_tech', language: 'zh', tier: 'tier2', filterKeywords: ['AI编程', '代码生成', 'Vibe Coding', 'Cursor', 'Copilot', 'Claude Code', 'DeepSeek'] },
  { name: 'Bing News: Vibecoding', url: 'https://www.bing.com/news/search?q=%22vibe+coding%22+OR+%22AI+coding+tools%22+OR+%22Cursor+IDE%22&format=rss', enabled: false, type: 'rss', category: 'ai_tech', language: 'en', tier: 'tier3', filterKeywords: ['vibe coding', 'ai coding', 'cursor', 'copilot'] },
];

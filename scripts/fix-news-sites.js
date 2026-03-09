#!/usr/bin/env node
/**
 * Перезаписать ВСЕ news-sites правильными метаданными.
 * Удаляет дубликаты, добавляет type/category/language/jsonMapping/filterKeywords.
 */

const BOT_URL = process.env.BOT_URL || 'https://amina-bot.onrender.com';

const ALL_SITES = [
  // --- Городские (существующие) ---
  { name: 'Гродно Плюм', url: 'https://grodnoplustv.by/', enabled: true, type: 'rss', category: 'city_local', language: 'ru' },
  { name: 'Новый Гродно', url: 'https://newgrodno.by/', enabled: true, type: 'rss', category: 'city_local', language: 'ru' },
  { name: 'ВГР', url: 'https://vgr.by/', enabled: true, type: 'rss', category: 'city_local', language: 'ru' },
  { name: 'Гродно Ньюз', url: 'https://grodnonews.by/', enabled: true, type: 'rss', category: 'city_local', language: 'ru' },
  { name: 'Авто Гродно', url: 'https://autogrodno.by/', enabled: true, type: 'rss', category: 'city_local', language: 'ru' },

  // --- AI Labs & Research ---
  { name: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'OpenAI News', url: 'https://openai.com/news/rss.xml', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'arXiv cs.AI', url: 'https://rss.arxiv.org/rss/cs.AI', enabled: true, type: 'rss', category: 'ai_tech', language: 'en', filterKeywords: ['LLM', 'language model', 'code generation', 'agent', 'transformer', 'GPT', 'diffusion', 'multimodal', 'RAG', 'fine-tuning', 'RLHF', 'benchmark', 'reasoning', 'coding', 'program'] },
  // --- Developer Communities ---
  { name: 'Hacker News (AI/VibeCoding)', url: 'https://hn.algolia.com/api/v1/search_by_date?query=vibecoding+OR+%22vibe+coding%22+OR+%22AI+coding%22+OR+cursor+OR+copilot&tags=story', enabled: true, type: 'json_api', category: 'community', language: 'en', jsonMapping: { itemsPath: 'hits', titleField: 'title', urlField: 'url|story_url', dateField: 'created_at' } },
  { name: 'Dev.to (AI)', url: 'https://dev.to/api/articles?tag=ai&top=7', enabled: true, type: 'json_api', category: 'community', language: 'en', jsonMapping: { itemsPath: '', titleField: 'title', urlField: 'url', dateField: 'published_at' } },
  { name: 'Reddit r/LocalLLaMA', url: 'https://www.reddit.com/r/LocalLLaMA/new/.rss', enabled: true, type: 'rss', category: 'community', language: 'en' },
  { name: 'GitHub Trending', url: 'https://github.com/trending', enabled: true, type: 'html_scrape', category: 'ai_tech', language: 'en' },
  // --- Tech Blogs ---
  { name: 'Simon Willison', url: 'https://simonwillison.net/atom/entries/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'MarkTechPost', url: 'https://www.marktechpost.com/feed/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'TLDR AI', url: 'https://tldr.tech/ai/archives', enabled: true, type: 'html_scrape', category: 'ai_tech', language: 'en' },
  // --- China (через RSSHub) ---
  { name: '机器之心 (Synced)', url: 'https://rsshub.app/wechat/mp/jiqizhixin', enabled: true, type: 'rss', category: 'asia_tech', language: 'zh' },
  { name: '量子位 (QbitAI)', url: 'https://rsshub.app/wechat/mp/QbitAI', enabled: true, type: 'rss', category: 'asia_tech', language: 'zh' },
  { name: '新智元 (AI Era)', url: 'https://rsshub.app/wechat/mp/aiera', enabled: true, type: 'rss', category: 'asia_tech', language: 'zh' },
  // --- Japan ---
  { name: 'Zenn.dev (AI)', url: 'https://zenn.dev/topics/ai/feed', enabled: true, type: 'rss', category: 'asia_tech', language: 'ja' },
  { name: 'Qiita (AI)', url: 'https://qiita.com/api/v2/items?query=title:AI+OR+title:LLM+OR+title:ChatGPT&per_page=20', enabled: true, type: 'json_api', category: 'asia_tech', language: 'ja', jsonMapping: { itemsPath: '', titleField: 'title', urlField: 'url', dateField: 'created_at' } },
  // --- International ---
  { name: 'Tech in Asia', url: 'https://www.techinasia.com/feed', enabled: true, type: 'rss', category: 'asia_tech', language: 'en' },
  { name: 'InfoQ China', url: 'https://www.infoq.cn/feed', enabled: true, type: 'rss', category: 'asia_tech', language: 'zh' },
];

async function main() {
  console.log(`Перезаписываю ${ALL_SITES.length} источников на ${BOT_URL}...`);

  const res = await fetch(`${BOT_URL}/api/news-sites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ALL_SITES),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`POST failed: ${res.status} ${err}`);
  }

  const result = await res.json();
  console.log(`Готово. Сохранено: ${result.data?.length ?? '?'} источников`);

  const verify = await fetch(`${BOT_URL}/api/news-sites`);
  const { data } = await verify.json();
  const withCategory = data.filter((s) => s.category);
  const withType = data.filter((s) => s.type);
  console.log(`Проверка: всего=${data.length}, с category=${withCategory.length}, с type=${withType.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

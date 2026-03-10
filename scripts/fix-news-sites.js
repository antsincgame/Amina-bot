#!/usr/bin/env node
/**
 * Перезаписать ВСЕ news-sites правильными метаданными.
 * Удаляет дубликаты, добавляет type/category/language.
 */

const BOT_URL = process.env.BOT_URL || 'https://amina-bot.onrender.com';

const ALL_SITES = [
  // --- Городские ---
  { name: 'Гродно Плюм', url: 'https://grodnoplustv.by/', enabled: true, type: 'rss', category: 'city_local', language: 'ru' },
  { name: 'Новый Гродно', url: 'https://newgrodno.by/', enabled: true, type: 'rss', category: 'city_local', language: 'ru' },
  { name: 'ВГР', url: 'https://vgr.by/', enabled: true, type: 'rss', category: 'city_local', language: 'ru' },
  { name: 'Гродно Ньюз', url: 'https://grodnonews.by/', enabled: true, type: 'rss', category: 'city_local', language: 'ru' },
  { name: 'Авто Гродно', url: 'https://autogrodno.by/', enabled: true, type: 'rss', category: 'city_local', language: 'ru' },
  // --- AI Labs & Research ---
  { name: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'OpenAI News', url: 'https://openai.com/news/rss.xml', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'arXiv cs.AI', url: 'https://rss.arxiv.org/rss/cs.AI', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'arXiv cs.CL (NLP/LLM)', url: 'https://rss.arxiv.org/rss/cs.CL', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'arXiv cs.LG (Machine Learning)', url: 'https://rss.arxiv.org/rss/cs.LG', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Google AI Blog', url: 'https://blog.google/technology/ai/rss/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Meta AI Blog', url: 'https://ai.meta.com/blog/rss/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Anthropic News', url: 'https://www.anthropic.com/rss.xml', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'DeepMind Blog', url: 'https://deepmind.google/blog/rss.xml', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Microsoft AI Blog', url: 'https://blogs.microsoft.com/ai/feed/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  // --- Developer Communities ---
  { name: 'Hacker News (AI/VibeCoding)', url: 'https://hn.algolia.com/api/v1/search_by_date?query=AI+OR+LLM+OR+vibecoding+OR+%22vibe+coding%22+OR+%22AI+coding%22+OR+cursor+OR+copilot+OR+%22code+generation%22+OR+anthropic+OR+openai&tags=story&hitsPerPage=40', enabled: true, type: 'json_api', category: 'community', language: 'en', jsonMapping: { itemsPath: 'hits', titleField: 'title', urlField: 'url|story_url', dateField: 'created_at' } },
  { name: 'Dev.to (AI)', url: 'https://dev.to/api/articles?tag=ai&top=7&per_page=30', enabled: true, type: 'json_api', category: 'community', language: 'en', jsonMapping: { itemsPath: '', titleField: 'title', urlField: 'url', dateField: 'published_at' } },
  { name: 'Dev.to (Machine Learning)', url: 'https://dev.to/api/articles?tag=machinelearning&top=7&per_page=20', enabled: true, type: 'json_api', category: 'community', language: 'en', jsonMapping: { itemsPath: '', titleField: 'title', urlField: 'url', dateField: 'published_at' } },
  { name: 'Reddit r/LocalLLaMA', url: 'https://www.reddit.com/r/LocalLLaMA/new/.rss', enabled: true, type: 'rss', category: 'community', language: 'en' },
  { name: 'Reddit r/MachineLearning', url: 'https://www.reddit.com/r/MachineLearning/hot/.rss', enabled: true, type: 'rss', category: 'community', language: 'en' },
  { name: 'Reddit r/artificial', url: 'https://www.reddit.com/r/artificial/hot/.rss', enabled: true, type: 'rss', category: 'community', language: 'en' },
  { name: 'GitHub Trending', url: 'https://github.com/trending', enabled: true, type: 'html_scrape', category: 'ai_tech', language: 'en' },
  // --- Tech Blogs ---
  { name: 'Simon Willison', url: 'https://simonwillison.net/atom/entries/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'MarkTechPost', url: 'https://www.marktechpost.com/feed/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'TLDR AI', url: 'https://tldr.tech/ai/archives', enabled: true, type: 'html_scrape', category: 'ai_tech', language: 'en' },
  { name: 'The Verge (AI)', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Ars Technica (AI)', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'TechCrunch (AI)', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'VentureBeat (AI)', url: 'https://venturebeat.com/category/ai/feed/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'MIT Technology Review (AI)', url: 'https://www.technologyreview.com/feed/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Towards Data Science (Medium)', url: 'https://towardsdatascience.com/feed', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'AI News (artificialintelligence-news.com)', url: 'https://www.artificialintelligence-news.com/feed/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Wired (AI)', url: 'https://www.wired.com/feed/tag/ai/latest/rss', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  // --- Asia ---
  { name: '36kr AI News', url: 'https://36kr.com/feed', enabled: true, type: 'rss', category: 'asia_tech', language: 'zh' },
  { name: 'PaperWithCode (trending)', url: 'https://paperswithcode.com/latest', enabled: true, type: 'html_scrape', category: 'ai_tech', language: 'en' },
  { name: 'InfoQ China', url: 'https://www.infoq.cn/feed', enabled: true, type: 'rss', category: 'asia_tech', language: 'zh' },
  { name: 'Zenn.dev (AI)', url: 'https://zenn.dev/topics/ai/feed', enabled: true, type: 'rss', category: 'asia_tech', language: 'ja' },
  { name: 'Zenn.dev (LLM)', url: 'https://zenn.dev/topics/llm/feed', enabled: true, type: 'rss', category: 'asia_tech', language: 'ja' },
  { name: 'Qiita (AI)', url: 'https://qiita.com/api/v2/items?query=title:AI+OR+title:LLM+OR+title:ChatGPT+OR+title:GPT&per_page=30', enabled: true, type: 'json_api', category: 'asia_tech', language: 'ja', jsonMapping: { itemsPath: '', titleField: 'title', urlField: 'url', dateField: 'created_at' } },
  { name: 'Tech in Asia', url: 'https://www.techinasia.com/feed', enabled: true, type: 'rss', category: 'asia_tech', language: 'en' },
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
  
  const byCat = {};
  for (const s of data) {
    const cat = s.category || 'none';
    byCat[cat] = (byCat[cat] || 0) + 1;
  }
  
  console.log(`Проверка: всего=${data.length}, с category=${withCategory.length}, с type=${withType.length}`);
  console.log('По категориям:', byCat);
}

main().catch((e) => { console.error(e); process.exit(1); });

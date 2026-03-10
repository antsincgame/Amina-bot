#!/usr/bin/env node
/**
 * Добавить AI/Tech пресеты в news-sites через существующий API.
 * Работает даже если новый endpoint /add-presets ещё не задеплоен.
 *
 * Использование: node scripts/add-news-presets.js
 * Или: BOT_URL=https://amina-bot.onrender.com node scripts/add-news-presets.js
 */

const BOT_URL = process.env.BOT_URL || 'https://amina-bot.onrender.com';

const PRESETS = [
  { name: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'OpenAI News', url: 'https://openai.com/news/rss.xml', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'arXiv cs.AI', url: 'https://rss.arxiv.org/rss/cs.AI', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'Hacker News (VibeCoding)', url: 'https://hn.algolia.com/api/v1/search_by_date?query=vibecoding+OR+%22vibe+coding%22+OR+cursor+OR+copilot&tags=story', enabled: true, type: 'json_api', category: 'community', language: 'en' },
  { name: 'Dev.to (AI)', url: 'https://dev.to/api/articles?tag=ai&top=7', enabled: true, type: 'json_api', category: 'community', language: 'en' },
  { name: 'Reddit r/LocalLLaMA', url: 'https://www.reddit.com/r/LocalLLaMA/new/.rss', enabled: true, type: 'rss', category: 'community', language: 'en' },
  { name: 'GitHub Trending', url: 'https://github.com/trending', enabled: true, type: 'html_scrape', category: 'ai_tech', language: 'en' },
  { name: 'Simon Willison', url: 'https://simonwillison.net/atom/entries/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'MarkTechPost', url: 'https://www.marktechpost.com/feed/', enabled: true, type: 'rss', category: 'ai_tech', language: 'en' },
  { name: 'TLDR AI', url: 'https://tldr.tech/ai/archives', enabled: true, type: 'html_scrape', category: 'ai_tech', language: 'en' },
  { name: '机器之心 (Synced)', url: 'https://rsshub.app/wechat/mp/jiqizhixin', enabled: true, type: 'rss', category: 'asia_tech', language: 'zh' },
  { name: '量子位 (QbitAI)', url: 'https://rsshub.app/wechat/mp/QbitAI', enabled: true, type: 'rss', category: 'asia_tech', language: 'zh' },
  { name: '新智元 (AI Era)', url: 'https://rsshub.app/wechat/mp/aiera', enabled: true, type: 'rss', category: 'asia_tech', language: 'zh' },
  { name: 'Zenn.dev (AI)', url: 'https://zenn.dev/topics/ai/feed', enabled: true, type: 'rss', category: 'asia_tech', language: 'ja' },
  { name: 'Qiita (AI)', url: 'https://qiita.com/api/v2/items?query=title:AI+OR+title:LLM&per_page=15', enabled: true, type: 'json_api', category: 'asia_tech', language: 'ja' },
  { name: 'Tech in Asia', url: 'https://www.techinasia.com/feed', enabled: true, type: 'rss', category: 'asia_tech', language: 'en' },
  { name: 'InfoQ China', url: 'https://www.infoq.cn/feed', enabled: true, type: 'rss', category: 'asia_tech', language: 'zh' },
];

async function main() {
  let existing = [];
  try {
    const res = await fetch(`${BOT_URL}/api/news-sites`);
    if (!res.ok) throw new Error(`GET failed: ${res.status}`);
    const { data } = await res.json();
    existing = data || [];
    console.log(`Текущих источников: ${existing.length}`);
  } catch (e) {
    console.warn('Не удалось загрузить текущий список:', e.message);
  }

  const existingUrls = new Set(existing.map((s) => s.url));
  const newSites = PRESETS.filter((s) => !existingUrls.has(s.url));
  const merged = [...existing, ...newSites];

  if (newSites.length === 0) {
    console.log('Все пресеты уже добавлены.');
    return;
  }

  console.log(`Добавляю ${newSites.length} новых источников...`);

  const saveRes = await fetch(`${BOT_URL}/api/news-sites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(merged),
  });

  if (!saveRes.ok) {
    const err = await saveRes.text();
    throw new Error(`POST failed: ${saveRes.status} ${err}`);
  }

  console.log(`Готово. Всего источников: ${merged.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

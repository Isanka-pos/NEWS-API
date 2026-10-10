const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const CACHE_MS = 5 * 60 * 1000; // 5 min cache

// ---- News sources (RSS feeds - scrape වලට වඩා stable) ----
const SOURCES = {
  adaderana: { name: 'Ada Derana', url: 'https://www.adaderana.lk/rss.php' },
  bbcsinhala: { name: 'BBC Sinhala', url: 'https://feeds.bbci.co.uk/sinhala/rss.xml' }
  // අලුත් source එකක් add කරන්න: key: { name: '...', url: 'RSS_URL' }
};

const cache = {}; // { key: { time, data } }

const clean = (s = '') =>
  cheerio.load(`<div>${s}</div>`)('div').text().replace(/\s+/g, ' ').trim();

async function fetchNews(key) {
  const src = SOURCES[key];
  const hit = cache[key];
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.data;

  const { data: xml } = await axios.get(src.url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsAPI/1.0)' }
  });

  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];

  $('item').each((_, el) => {
    const $el = $(el);
    const desc = $el.find('description').text();
    const img =
      $el.find('enclosure').attr('url') ||
      $el.find('media\\:thumbnail').attr('url') ||
      $el.find('media\\:content').attr('url') ||
      cheerio.load(`<div>${desc}</div>`)('img').attr('src') ||
      null;

    items.push({
      title: clean($el.find('title').text()),
      link: $el.find('link').text().trim(),
      description: clean(desc),
      image: img,
      published: $el.find('pubDate').text().trim() || null
    });
  });

  const result = { source: src.name, count: items.length, items };
  cache[key] = { time: Date.now(), data: result };
  return result;
}

app.get('/', (req, res) => {
  res.json({
    status: true,
    endpoints: {
      sources: '/api/sources',
      news: '/api/news?source=adaderana&limit=10'
    }
  });
});

app.get('/api/sources', (req, res) => {
  res.json({
    status: true,
    sources: Object.entries(SOURCES).map(([key, s]) => ({ key, name: s.name }))
  });
});

app.get('/api/news', async (req, res) => {
  const key = (req.query.source || 'adaderana').toLowerCase();
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);

  if (!SOURCES[key]) {
    return res.status(400).json({
      status: false,
      error: 'Invalid source',
      available: Object.keys(SOURCES)
    });
  }

  try {
    const data = await fetchNews(key);
    res.json({
      status: true,
      source: data.source,
      count: Math.min(limit, data.items.length),
      news: data.items.slice(0, limit)
    });
  } catch (e) {
    res.status(502).json({ status: false, error: 'Failed to fetch news', detail: e.message });
  }
});

app.listen(PORT, () => console.log(`News API running on port ${PORT}`));

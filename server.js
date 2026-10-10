/**
 * Hiru News API  (scrapes https://hirunews.lk)
 * Owner by Isanka Malith
 *
 * Endpoints
 *   GET /                      -> docs
 *   GET /api/news              -> news list  (photo + title + summary + link)
 *        ?category=all|general|international|sports|business|entertainment
 *        &lang=si|en|tm        (default si)
 *        &limit=20             (max 100)
 *        &q=keyword            (search in title/description)
 *        &page=2               (uses news_listing.php, Sinhala only)
 *        &desc=0               (remove full description)
 *        &format=text          (WhatsApp-ready text output)
 *   GET /api/top               -> top story
 *   GET /api/random            -> random news
 *   GET /api/ticker            -> breaking headlines (marquee)
 *   GET /api/tv                -> Hiru TV news bulletins (YouTube links + thumbnails)
 *   GET /api/article?url=...   -> full article details (or ?id=493262)
 *
 * Optional: set env API_KEY=xxxx  -> clients must send ?apikey=xxxx or x-api-key header
 */

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.set('trust proxy', 1);
app.use(cors());

const OWNER = 'Isanka Malith';
const FOOTER = `\n\n👑 Owner by ${OWNER}`;

// every JSON response gets a "creator" field
app.use((req, res, next) => {
  const send = res.json.bind(res);
  res.json = (body) =>
    send(body && typeof body === 'object' && !Array.isArray(body) ? { creator: `Owner by ${OWNER}`, ...body } : body);
  next();
});

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const CACHE_TTL = 3 * 60 * 1000; // 3 min
const RATE_LIMIT = 60; // requests / minute / IP

const BASE = 'https://hirunews.lk';
const LANGS = {
  si: `${BASE}/`,
  en: `${BASE}/en`,
  tm: `${BASE}/tm`
};
const CATEGORIES = ['general', 'international', 'sports', 'business', 'entertainment'];
const CARD_SEL = 'a[class*="card-"]:not(.card-v5)';

/* ------------------------------ helpers ------------------------------ */

const cache = new Map();

async function getHtml(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.html;
  try {
    const { data } = await axios.get(url, {
      timeout: 15000,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'si,en;q=0.8'
      }
    });
    if (cache.size > 60) cache.delete(cache.keys().next().value);
    cache.set(url, { t: Date.now(), html: data });
    return data;
  } catch (e) {
    if (hit) return hit.html; // site down -> serve stale
    throw e;
  }
}

const txt = (s) => (s || '').replace(/\s+/g, ' ').trim();

const abs = (u) => {
  try {
    return u ? new URL(u, BASE).href : null;
  } catch {
    return null;
  }
};

const getId = (link) => {
  const m = (link || '').match(/\/(\d{4,})(?:\/|$)/);
  return m ? parseInt(m[1], 10) : null;
};

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

// "09 October 2026 2:10 PM" -> "2026-10-09T14:10:00+05:30"
function parseDate(t) {
  const m = (t || '').match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?/i);
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (!mon) return null;
  let h = m[4] ? parseInt(m[4], 10) : 0;
  const ap = (m[6] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  const p = (n) => String(n).padStart(2, '0');
  return `${m[3]}-${p(mon)}-${p(m[1])}T${p(h)}:${p(m[5] || 0)}:00+05:30`;
}

function categoryFromLink(link) {
  if (/\/sports\//.test(link)) return 'Sports';
  if (/\/business\//.test(link)) return 'Business';
  if (/\/entertainment\//.test(link)) return 'Entertainment';
  return null;
}

/* ------------------------------ scraping ------------------------------ */

function parseCard($, el) {
  const $el = $(el);
  const link = abs($el.attr('href'));
  const title = txt($el.find('[class*="card-title"]').first().text() || $el.find('.title').first().text());
  if (!link || !title) return null;

  const description = txt($el.find('.description').first().text());
  const image = abs($el.find('img').first().attr('src'));
  const dateText = txt($el.find('.update-wrp-lg span').not('.update-category').first().text());

  let section = '';
  if ($el.hasClass('card-featured')) {
    section = 'Top Story';
  } else {
    const box = $el.closest(
      '.slider-section, .featured-cards, .home-most-top-news, .home-international-trad-news, .home-more-news'
    );
    section = txt(box.find('.heading-wrp h5').first().text());
  }

  let category = txt($el.find('.update-category').first().text()) || categoryFromLink(link);
  if (!category && /sports/i.test(section)) category = 'Sports';
  if (!category && /business/i.test(section)) category = 'Business';
  if (!category && /entertainment/i.test(section)) category = 'Entertainment';

  return {
    id: getId(link),
    title,
    summary: description.length > 220 ? description.slice(0, 217).trim() + '...' : description,
    description,
    image,
    link,
    category: category || 'General',
    section,
    date: dateText || null,
    published: parseDate(dateText)
  };
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const map = new Map();
  $(CARD_SEL).each((_, el) => {
    const item = parseCard($, el);
    if (!item) return;
    const key = item.id || item.link;
    const old = map.get(key);
    if (!old) map.set(key, item);
    else {
      // merge: keep the richer data
      if (item.description.length > old.description.length) {
        old.description = item.description;
        old.summary = item.summary;
      }
      if (!old.image && item.image) old.image = item.image;
      if (!old.date && item.date) {
        old.date = item.date;
        old.published = item.published;
      }
      if (old.category === 'General' && item.category !== 'General') old.category = item.category;
    }
  });
  // newest first (ids grow with time)
  return [...map.values()].sort((a, b) => (b.id || 0) - (a.id || 0));
}

async function getNews({ lang = 'si', category = 'all', page = 1 }) {
  const useListing = page > 1 && lang === 'si' && category !== 'all';
  if (useListing) {
    const c = category.charAt(0).toUpperCase() + category.slice(1);
    const url = `${BASE}/news_listing.php?category=${c}&page=${page}`;
    const items = parseCards(await getHtml(url));
    if (items.length) return items;
  }
  const items = parseCards(await getHtml(LANGS[lang] || LANGS.si));
  if (category === 'all') return items;
  return items.filter((i) => i.category.toLowerCase() === category);
}

async function getTicker(lang = 'si') {
  const $ = cheerio.load(await getHtml(LANGS[lang] || LANGS.si));
  const out = [];
  $('.hnticker_marquee .news-heading a').each((_, el) => {
    const link = abs($(el).attr('href'));
    const title = txt($(el).text());
    if (title && link) out.push({ id: getId(link), title, link });
  });
  return out;
}

async function getTv() {
  const $ = cheerio.load(await getHtml(LANGS.si));
  const out = [];
  $('.tv-news-section .col-lg-4').each((_, col) => {
    const bulletin = txt($(col).find('.intro-content h5').first().text());
    $(col)
      .find('a.card-v5')
      .each((__, a) => {
        const $a = $(a);
        const thumb = $a.find('img').first().attr('src') || '';
        const yt = thumb.match(/vi\/([\w-]{6,})\//);
        out.push({
          bulletin,
          title: txt($a.find('[class*="card-title"]').first().text()),
          date: txt($a.find('.update-wrp-lg span').first().text()),
          link: abs($a.attr('href')),
          thumbnail: thumb || null,
          youtube: yt ? `https://www.youtube.com/watch?v=${yt[1]}` : null
        });
      });
  });
  return out;
}

async function getArticle(url) {
  const html = await getHtml(url);
  const $ = cheerio.load(html);
  const og = (p) => $(`meta[property="og:${p}"]`).attr('content') || null;

  // JSON-LD NewsArticle (if the page has one)
  let ld = null;
  $('script[type="application/ld+json"]').each((_, s) => {
    if (ld) return;
    try {
      const j = JSON.parse($(s).contents().text());
      const find = (o) => {
        if (!o || typeof o !== 'object') return null;
        if (o['@type'] === 'NewsArticle') return o;
        for (const v of Object.values(o)) {
          const r = find(v);
          if (r) return r;
        }
        return null;
      };
      ld = find(j);
    } catch {}
  });

  $('header, footer, nav, script, style, .mobile-menu').remove();
  const paras = [];
  $('p').each((_, p) => {
    const t = txt($(p).text());
    if (t.length > 30) paras.push(t);
  });

  return {
    id: getId(url),
    title: og('title') || (ld && ld.headline) || txt($('title').text()),
    image: og('image') || (ld && ld.image) || null,
    link: url,
    published: (ld && ld.datePublished) || null,
    description: og('description') || (ld && ld.description) || null,
    content: paras.join('\n\n') || (ld && ld.description) || null
  };
}

/* ------------------------------ middleware ------------------------------ */

const hits = new Map();
app.use((req, res, next) => {
  const now = Date.now();
  const rec = hits.get(req.ip) || { n: 0, t: now };
  if (now - rec.t > 60000) {
    rec.n = 0;
    rec.t = now;
  }
  rec.n++;
  hits.set(req.ip, rec);
  if (rec.n > RATE_LIMIT) return res.status(429).json({ status: false, error: 'Too many requests, slow down' });
  next();
});

app.use('/api', (req, res, next) => {
  if (!API_KEY) return next();
  const k = req.query.apikey || req.headers['x-api-key'];
  if (k !== API_KEY) return res.status(401).json({ status: false, error: 'Invalid API key' });
  next();
});

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res.status(502).json({ status: false, error: 'Failed to fetch from hirunews.lk', detail: e.message });
  }
};

const toText = (item) =>
  `📰 *${item.title}*\n\n${item.summary || ''}\n\n🗞️ ${item.category}${item.date ? ' | 🕒 ' + item.date : ''}\n🔗 ${item.link}`;

/* ------------------------------ routes ------------------------------ */

app.get('/', (req, res) => {
  res.json({
    status: true,
    name: 'Hiru News API',
    endpoints: {
      news: '/api/news?category=all&lang=si&limit=10&q=&page=1&format=json|text&desc=0',
      top: '/api/top',
      random: '/api/random',
      ticker: '/api/ticker',
      tv: '/api/tv',
      article: '/api/article?id=493262  or  /api/article?url=https://hirunews.lk/...'
    },
    categories: ['all', ...CATEGORIES],
    languages: Object.keys(LANGS)
  });
});

app.get(
  '/api/news',
  wrap(async (req, res) => {
    const lang = LANGS[req.query.lang] ? req.query.lang : 'si';
    const category = String(req.query.category || 'all').toLowerCase();
    if (category !== 'all' && !CATEGORIES.includes(category)) {
      return res.status(400).json({ status: false, error: 'Invalid category', available: ['all', ...CATEGORIES] });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const page = Math.max(parseInt(req.query.page) || 1, 1);

    let items = await getNews({ lang, category, page });

    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) items = items.filter((i) => (i.title + ' ' + i.description).toLowerCase().includes(q));

    items = items.slice(0, limit);

    if (req.query.format === 'text') {
      res.type('text/plain; charset=utf-8');
      return res.send(items.map(toText).join('\n\n━━━━━━━━━━\n\n') + FOOTER);
    }

    if (req.query.desc === '0') items = items.map(({ description, ...rest }) => rest);

    res.json({ status: true, source: 'Hiru News', lang, category, page, count: items.length, news: items });
  })
);

app.get(
  '/api/top',
  wrap(async (req, res) => {
    const lang = LANGS[req.query.lang] ? req.query.lang : 'si';
    const html = await getHtml(LANGS[lang]);
    const $ = cheerio.load(html);
    const el = $('a.card-featured').first();
    const item = el.length ? parseCard($, el) : (await getNews({ lang }))[0];
    if (!item) return res.status(404).json({ status: false, error: 'Top story not found' });
    if (req.query.format === 'text') return res.type('text/plain; charset=utf-8').send(toText(item) + FOOTER);
    res.json({ status: true, news: item });
  })
);

app.get(
  '/api/random',
  wrap(async (req, res) => {
    const lang = LANGS[req.query.lang] ? req.query.lang : 'si';
    const items = await getNews({ lang });
    const item = items[Math.floor(Math.random() * items.length)];
    if (!item) return res.status(404).json({ status: false, error: 'No news found' });
    if (req.query.format === 'text') return res.type('text/plain; charset=utf-8').send(toText(item) + FOOTER);
    res.json({ status: true, news: item });
  })
);

app.get(
  '/api/ticker',
  wrap(async (req, res) => {
    const lang = LANGS[req.query.lang] ? req.query.lang : 'si';
    const headlines = await getTicker(lang);
    res.json({ status: true, count: headlines.length, headlines });
  })
);

app.get(
  '/api/tv',
  wrap(async (req, res) => {
    const bulletins = await getTv();
    res.json({ status: true, count: bulletins.length, bulletins });
  })
);

app.get(
  '/api/article',
  wrap(async (req, res) => {
    let url = req.query.url;
    if (!url && req.query.id) {
      const id = parseInt(req.query.id, 10);
      for (const lang of Object.keys(LANGS)) {
        const found = (await getNews({ lang })).find((i) => i.id === id);
        if (found) {
          url = found.link;
          break;
        }
      }
      if (!url) return res.status(404).json({ status: false, error: 'ID not found on the front pages, use ?url= instead' });
    }
    if (!url) return res.status(400).json({ status: false, error: 'Provide ?url= or ?id=' });
    if (!/^https?:\/\/(www\.)?hirunews\.lk\//i.test(url)) {
      return res.status(400).json({ status: false, error: 'Only hirunews.lk links are allowed' });
    }
    const article = await getArticle(url);
    if (req.query.format === 'text') {
      res.type('text/plain; charset=utf-8');
      return res.send(`📰 *${article.title}*\n\n${article.content || article.description || ''}\n\n🔗 ${article.link}` + FOOTER);
    }
    res.json({ status: true, article });
  })
);

app.use((req, res) => res.status(404).json({ status: false, error: 'Not found' }));

app.listen(PORT, () => console.log(`Hiru News API running on port ${PORT}`));

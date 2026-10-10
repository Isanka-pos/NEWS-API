/**
 * YouTube Channel Logo API
 * Owner by Isanka Malith
 *
 * Input (?url=) can be any of:
 *   https://www.youtube.com/@handle      https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx
 *   https://www.youtube.com/c/name       https://www.youtube.com/user/name
 *   any video / shorts / live link       https://youtu.be/VIDEO_ID
 *   @handle   or   UCxxxxxxxxxxxxxxxxxxxxxx
 *
 * Endpoints
 *   GET /                         -> docs
 *   GET /api/ytlogo?url=...       -> JSON: channel info + logo links in many sizes
 *        &size=512|original       -> also returns that one size as logo.requested
 *        &redirect=1              -> 302 redirect straight to the image (needs size or default 800)
 *   GET /api/ytlogo/image?url=... -> returns the image itself (use directly in <img src>)
 *        &size=512|original
 *   GET /api/ytlogo/download?url= -> same image, forced download (Content-Disposition: attachment)
 *
 * Env (all optional)
 *   YT_API_KEY  YouTube Data API v3 key -> most reliable (used first, scraping is the fallback)
 *   API_KEY     protect this API: clients must send ?apikey=... or x-api-key header
 *   PORT
 */

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.set('trust proxy', 1);
app.use(cors());

const OWNER = 'Isanka Malith';
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const YT_API_KEY = process.env.YT_API_KEY || '';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour (logos rarely change)
const RATE_LIMIT = 60; // requests / minute / IP

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SIZES = [48, 64, 88, 100, 120, 176, 240, 300, 400, 512, 800, 900];

// every JSON response gets a "creator" field
app.use((req, res, next) => {
  const send = res.json.bind(res);
  res.json = (body) =>
    send(body && typeof body === 'object' && !Array.isArray(body) ? { creator: `Owner by ${OWNER}`, ...body } : body);
  next();
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------ input parsing ------------------------------ */

const YT_HOST = /^(www\.|m\.|music\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

function parseInput(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new HttpError(400, 'Provide ?url= (channel link, video link, @handle or channel ID)');

  if (/^UC[\w-]{22}$/.test(s)) return { type: 'id', value: s };

  const looksLikeUrl = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)(\/|$)/i.test(s);
  if (!looksLikeUrl) {
    if (/^@?[^\s/?#]{2,60}$/.test(s)) return { type: 'handle', value: s.replace(/^@/, '') };
    throw new HttpError(400, 'Only YouTube links, @handles or channel IDs are supported');
  }

  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, 'Invalid URL');
  }
  if (!YT_HOST.test(u.hostname)) throw new HttpError(400, 'Only YouTube links are supported');

  const parts = u.pathname.split('/').filter(Boolean);
  if (/youtu\.be$/i.test(u.hostname)) {
    if (parts[0]) return { type: 'video', value: parts[0] };
    throw new HttpError(400, 'Could not find a video ID in this link');
  }

  const p0 = parts[0] || '';
  if (p0.startsWith('@')) return { type: 'handle', value: decodeURIComponent(p0.slice(1)) };
  if (p0 === 'channel' && parts[1]) return { type: 'id', value: parts[1] };
  if (p0 === 'c' && parts[1]) return { type: 'custom', value: decodeURIComponent(parts[1]) };
  if (p0 === 'user' && parts[1]) return { type: 'user', value: decodeURIComponent(parts[1]) };
  if (['shorts', 'live', 'embed', 'v'].includes(p0) && parts[1]) return { type: 'video', value: parts[1] };
  if (p0 === 'watch' && u.searchParams.get('v')) return { type: 'video', value: u.searchParams.get('v') };

  throw new HttpError(400, 'Could not detect a YouTube channel or video in this link');
}

function channelPageUrl(p) {
  const v = encodeURIComponent(p.value);
  if (p.type === 'id') return `https://www.youtube.com/channel/${v}`;
  if (p.type === 'handle') return `https://www.youtube.com/@${v}`;
  if (p.type === 'custom') return `https://www.youtube.com/c/${v}`;
  return `https://www.youtube.com/user/${v}`;
}

// video -> channel (oEmbed is stable and needs no key)
async function videoToChannel(videoId) {
  try {
    const { data } = await axios.get('https://www.youtube.com/oembed', {
      params: { url: `https://www.youtube.com/watch?v=${videoId}`, format: 'json' },
      timeout: 15000,
      headers: { 'User-Agent': UA }
    });
    if (!data.author_url) throw new Error('no author_url');
    return parseInput(data.author_url);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(404, 'Video not found (private, deleted or invalid link)');
  }
}

/* ------------------------------ logo helpers ------------------------------ */

// "https://yt3.googleusercontent.com/abc=s900-c-k-c0x00ffffff-no-rj"  ->  ".../abc"
function baseOf(url) {
  let u = String(url).replace(/\\u0026/g, '&').replace(/^http:/, 'https:');
  const i = u.lastIndexOf('=');
  return i > u.lastIndexOf('/') ? u.slice(0, i) : u;
}

const sizeUrl = (base, size) => (size === 0 ? `${base}=s0` : `${base}=s${size}-c-k-c0x00ffffff-no-rj`);

function parseSize(v, def = null) {
  if (v === undefined || v === '') return def;
  if (String(v).toLowerCase() === 'original') return 0;
  const n = parseInt(v, 10);
  if (!n || n < 16) throw new HttpError(400, 'size must be a number (16-2048) or "original"');
  return Math.min(n, 2048);
}

/* ------------------------------ resolving a channel ------------------------------ */

async function viaDataApi(p) {
  if (!YT_API_KEY || p.type === 'custom') return null;
  try {
    const params = { part: 'snippet', key: YT_API_KEY };
    if (p.type === 'id') params.id = p.value;
    else if (p.type === 'handle') params.forHandle = '@' + p.value;
    else if (p.type === 'user') params.forUsername = p.value;
    const { data } = await axios.get('https://www.googleapis.com/youtube/v3/channels', { params, timeout: 15000 });
    const it = data.items && data.items[0];
    if (!it) return null;
    const th = it.snippet.thumbnails || {};
    const best = (th.high || th.medium || th.default || {}).url;
    if (!best) return null;
    return {
      id: it.id,
      name: it.snippet.title,
      handle: it.snippet.customUrl || null,
      base: baseOf(best),
      source: 'youtube-data-api'
    };
  } catch {
    return null; // fall back to scraping
  }
}

async function viaScrape(p) {
  const url = channelPageUrl(p);
  let html;
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      responseType: 'text',
      maxRedirects: 5,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9',
        // skips the EU/consent interstitial
        Cookie: 'CONSENT=YES+cb.20240101-00-p0.en+FX+000; SOCS=CAI'
      }
    });
    html = res.data;
  } catch (e) {
    if (e.response && e.response.status === 404) throw new HttpError(404, 'Channel not found');
    throw new HttpError(502, 'Could not reach YouTube: ' + e.message);
  }

  const $ = cheerio.load(html);
  let img = $('meta[property="og:image"]').attr('content');
  if (!img || !/googleusercontent|ggpht/.test(img)) {
    const m = html.match(/"avatar":\{"thumbnails":\[\{"url":"([^"]+)"/);
    img = m ? m[1] : null;
  }
  if (!img) {
    throw new HttpError(
      404,
      'Channel logo not found (wrong link, or YouTube blocked this server). Set YT_API_KEY for guaranteed results.'
    );
  }

  const canonical = $('link[rel="canonical"]').attr('href') || '';
  const handleMatch = canonical.match(/youtube\.com\/@([^/?#]+)/);
  const id =
    $('meta[itemprop="identifier"]').attr('content') ||
    (html.match(/"channelId":"(UC[\w-]{22})"/) || [])[1] ||
    (html.match(/"externalId":"(UC[\w-]{22})"/) || [])[1] ||
    (p.type === 'id' ? p.value : null);

  return {
    id,
    name: $('meta[property="og:title"]').attr('content') || null,
    handle: handleMatch ? '@' + decodeURIComponent(handleMatch[1]) : p.type === 'handle' ? '@' + p.value : null,
    base: baseOf(img),
    source: 'youtube-page'
  };
}

const cache = new Map();

async function resolveChannel(raw) {
  let p = parseInput(raw);
  if (p.type === 'video') p = await videoToChannel(p.value);

  const key = `${p.type}:${p.value.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.data;

  const info = (await viaDataApi(p)) || (await viaScrape(p));
  info.url = info.id ? `https://www.youtube.com/channel/${info.id}` : channelPageUrl(p);

  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(key, { t: Date.now(), data: info });
  return info;
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
    res.status(e.status || 500).json({ status: false, error: e.message });
  }
};

/* ------------------------------ routes ------------------------------ */

app.get('/', (req, res) => {
  res.json({
    status: true,
    name: 'YouTube Channel Logo API',
    endpoints: {
      json: '/api/ytlogo?url=https://www.youtube.com/@MrBeast&size=512',
      image: '/api/ytlogo/image?url=@MrBeast&size=512   (use inside <img src>)',
      download: '/api/ytlogo/download?url=@MrBeast&size=original'
    },
    accepts: ['channel link', '@handle', 'channel ID (UC...)', 'any video / shorts / youtu.be link'],
    sizes: SIZES
  });
});

app.get(
  '/api/ytlogo',
  wrap(async (req, res) => {
    const info = await resolveChannel(req.query.url);
    const size = parseSize(req.query.size);

    if (req.query.redirect === '1') return res.redirect(302, sizeUrl(info.base, size === null ? 800 : size));

    const sizes = {};
    SIZES.forEach((s) => (sizes[s] = sizeUrl(info.base, s)));

    const logo = { original: sizeUrl(info.base, 0), sizes };
    if (size !== null) logo.requested = { size: size === 0 ? 'original' : size, url: sizeUrl(info.base, size) };

    res.json({
      status: true,
      channel: { id: info.id, name: info.name, handle: info.handle, url: info.url },
      logo,
      source: info.source
    });
  })
);

async function sendImage(req, res, disposition) {
  const info = await resolveChannel(req.query.url);
  const size = parseSize(req.query.size, 800);
  let r;
  try {
    r = await axios.get(sizeUrl(info.base, size), {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': UA, Accept: 'image/png,image/jpeg,image/*;q=0.8' }
    });
  } catch (e) {
    throw new HttpError(502, 'Could not download the image: ' + e.message);
  }
  const type = r.headers['content-type'] || 'image/jpeg';
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  const who = (info.handle || info.id || 'channel').replace(/[^\w.@-]/g, '');
  res.set({
    'Content-Type': type,
    'Content-Disposition': `${disposition}; filename="${who}-logo-${size === 0 ? 'original' : size}.${ext}"`,
    'Cache-Control': 'public, max-age=86400',
    'X-Owner': OWNER
  });
  res.send(Buffer.from(r.data));
}

app.get('/api/ytlogo/image', wrap((req, res) => sendImage(req, res, 'inline')));
app.get('/api/ytlogo/download', wrap((req, res) => sendImage(req, res, 'attachment')));

app.use((req, res) => res.status(404).json({ status: false, error: 'Not found' }));

app.listen(PORT, () => console.log(`YouTube Logo API running on port ${PORT}`));

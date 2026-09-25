// ============================================================
//  柠檬冰 · 新闻聚合 API  (Cloudflare Pages Functions)
//  服务端并行抓取 CCTV / BBC中文 / RFI中文，聚合后返回 JSON
//  —— 服务端请求不受浏览器 CORS 限制
// ============================================================

// ---------- 工具：带超时的 fetch ----------
async function fetchTimeout(url, ms = 8000, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LemonIceNews/1.0)', ...headers }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ---------- 解析 CCTV JSONP → 新闻数组 ----------
//  格式：news({...json...})  或  news({...json...});
//  结构：data.list[] → { title, url, brief, focus_date, image }
function parseCCTV(text) {
  const m = text.match(/^\s*\w+\s*\(([\s\S]*)\)\s*;?\s*$/);
  const jsonStr = m ? m[1] : text;
  return JSON.parse(jsonStr);
}

function extractCCTV(json) {
  const list = (json.data && json.data.list) || [];
  return list.map(function(it){
    return {
      title:       it.title || '',
      link:        it.url || '#',
      description: it.brief || '',
      pubDate:     it.focus_date || '',
      image:       it.image || '',
      source:      'CCTV新闻'
    };
  });
}

// ---------- 解析 RSS XML → 新闻数组 ----------
//  标准 RSS 2.0：<item><title><link><description><pubDate><media:content>
function parseRSS(xml, srcName) {
  var items = [];
  var re = /<item[\s\S]*?>([\s\S]*?)<\/item>/gi;
  var m, count = 0;
  while ((m = re.exec(xml)) !== null && count < 20) {
    var blk = m[1];
    // 标题（可能含 CDATA）
    var t = blk.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    // 链接
    var l = blk.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    // 发布时间（兼容 pubDate / dc:date / published / updated）
    var d = blk.match(/<(?:pubDate|dc:date|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|dc:date|published|updated)>/i);
    // 摘要（可能含 CDATA）
    var desc = blk.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
    // 图片（media:content 或 enclosure）
    var img = blk.match(/<(?:media:content|enclosure)[^>]*url="([^"]*)"/i);
    if (t) {
      items.push({
        title:       t[1].trim(),
        link:        l ? l[1].trim() : '#',
        description: desc ? desc[1].trim() : '',
        pubDate:     d ? d[1].trim() : '',
        image:       img ? img[1] : '',
        source:      srcName
      });
      count++;
    }
  }
  return items;
}

// ---------- 新闻源定义 ----------

// CCTV 直接 JSONP 接口（已验证可用）
const CCTV_ENDPOINTS = [
  'https://news.cctv.com/2019/07/gaiban/cmsdatainterface/page/news_1.jsonp?cb=news'
];

// RSS 源（标准 RSS 2.0）
const RSS_SOURCES = [
  { name: 'BBC中文', url: 'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml' },
  { name: 'RFI中文', url: 'https://www.rfi.fr/cn/rss' }
];

// ---------- 抓取各源 ----------

async function fetchCCTV() {
  var results = [];
  for (const ep of CCTV_ENDPOINTS) {
    var txt = await fetchTimeout(ep, 8000);
    if (!txt) continue;
    try {
      results = results.concat(extractCCTV(parseCCTV(txt)));
    } catch {}
  }
  return results;
}

async function fetchRSS(src) {
  var txt = await fetchTimeout(src.url, 8000);
  if (!txt) return [];
  try { return parseRSS(txt, src.name); }
  catch { return []; }
}

// ---------- 主处理函数（GET 请求入口） ----------

export async function onRequestGet(context) {
  const cache = caches.default;

  // 尝试读取边缘缓存（5 分钟有效）
  const cacheKey = new Request('https://lemonice.internal/api/news', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // 并行抓取所有新闻源，单个失败自动跳过
  const tasks = [fetchCCTV(), ...RSS_SOURCES.map(s => fetchRSS(s))];
  const settled = await Promise.allSettled(tasks);

  let news = [];
  for (const r of settled) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      news = news.concat(r.value);
    }
  }

  // 按发布时间降序排列
  news.sort((a, b) => {
    const da = new Date(a.pubDate).getTime() || 0;
    const db = new Date(b.pubDate).getTime() || 0;
    return db - da;
  });

  // 限制最多 60 条
  if (news.length > 60) news = news.slice(0, 60);

  const body = JSON.stringify({
    news:   news,
    count:  news.length,
    updated: new Date().toISOString()
  });

  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 's-maxage=300, stale-while-revalidate=600'
    }
  });

  // 异步写入边缘缓存
  context.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}

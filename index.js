import express from 'express';

const app = express();
app.disable('x-powered-by');

const PORT = process.env.PORT || 10000;
const WORKER_URL = (process.env.WORKER_URL || 'https://mangaraw.shunichi-0314.workers.dev').replace(/\/$/, '');

const TTL = 10 * 60 * 1000;        // 10分間は「新鮮」とみなす
const MIN_INTERVAL = 30 * 1000;    // 上流への再アクセスは最低30秒間隔
const cache = new Map();           // key -> { t, lastUp, status, type, buf, blocked }
const inflight = new Map();        // シングルフライト用

function isBlock(status, type, buf) {
  if (status === 403 || status === 429 || status === 503) return true;
  if ((type || '').includes('text/html')) {
    const s = buf.toString('utf8');
    return /sorry, you have been blocked/i.test(s) ||
           /attention required/i.test(s) ||
           /cloudflare ray id/i.test(s);
  }
  return false;
}

async function fetchFromWorker(key) {
  const res = await fetch(WORKER_URL + key, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  });
  const type = res.headers.get('content-type') || 'application/octet-stream';
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type, buf };
}

async function load(key) {
  const now = Date.now();
  const hit = cache.get(key);

  // 新鮮なキャッシュがあれば即返す
  if (hit && !hit.blocked && now - hit.t < TTL) return hit;
  // 直近で上流アクセス済みなら、たとえ古くてもそれを返す（レート制限対策）
  if (hit && now - hit.lastUp < MIN_INTERVAL) return hit;

  // 同時リクエストは1本のfetchにまとめる
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const r = await fetchFromWorker(key);
      const entry = { ...r, t: now, lastUp: now, blocked: isBlock(r.status, r.type, r.buf) };
      if (!entry.blocked) {
        cache.set(key, entry);
        return entry;
      }
      // ブロックされたら「最後の成功ページ」を返す（stale配信）
      if (hit && !hit.blocked) return hit;
      cache.set(key, entry);
      return entry;
    } catch (e) {
      if (hit && !hit.blocked) return hit;  // ネットワークエラーもstaleで吸収
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

// Render のヘルスチェックはここでローカル応答（上流へ流さない）
app.get('/healthz', (req, res) => res.send('OK'));

app.get('*', async (req, res) => {
  const key = req.url || '/';
  try {
    const entry = await load(key);

    if (entry.blocked) {
      // 成功キャッシュが全く無い場合のフォールバックページ（60秒後に自動再試行）
      return res.status(503).set('Content-Type', 'text/html; charset=utf-8').send(`
        <!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
        <meta http-equiv="refresh" content="60">
        <title>Loading...</title></head>
        <body style="font-family:sans-serif;background:#111;color:#eee;text-align:center;padding-top:20vh;">
          <h2>対象サイトが一時的にブロック中です</h2>
          <p>60秒後に自動で再試行します...</p>
        </body></html>`);
    }

    res.set('Content-Type', entry.type);
    res.set('Cache-Control', 'public, max-age=60');
    res.status(entry.status).send(entry.buf);
  } catch (e) {
    res.status(502).send('Upstream fetch failed: ' + e.message);
  }
});

app.listen(PORT, () => console.log(`Render proxy ready on ${PORT}`));

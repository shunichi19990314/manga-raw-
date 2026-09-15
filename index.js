import express from 'express';

const app = express();
app.disable('x-powered-by');

const PORT = process.env.PORT || 10000;
const WORKER_URL = (process.env.WORKER_URL || 'https://mangaraw.shunichi-0314.workers.dev').replace(/\/$/, '');

const TTL = 10 * 60 * 1000;
const cache = new Map();

async function fetchFromWorker(key) {
  const res = await fetch(WORKER_URL + key, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  });
  
  const contentType = res.headers.get('content-type') || '';
  
  // WorkerがJSONエラーを返した場合
  if (contentType.includes('application/json')) {
    const json = await res.json();
    if (json.error === 'blocked') {
      return { 
        blocked: true, 
        message: json.message,
        workerUrl: json.workerUrl
      };
    }
  }
  
  const buf = Buffer.from(await res.arrayBuffer());
  return { 
    blocked: false, 
    status: res.status, 
    type: contentType, 
    buf 
  };
}

app.get('/healthz', (req, res) => res.send('OK'));

app.get('*', async (req, res) => {
  const key = req.url || '/';
  const now = Date.now();
  const hit = cache.get(key);

  // キャッシュがあれば返す
  if (hit && now - hit.t < TTL) {
    if (hit.blocked) {
      return res.status(503).set('Content-Type', 'text/html; charset=utf-8').send(`
        <!DOCTYPE html>
        <html lang="ja">
        <head>
          <meta charset="utf-8">
          <meta http-equiv="refresh" content="30">
          <title>キャッシュ生成中</title>
          <style>
            body { 
              font-family: sans-serif; 
              background: #111; 
              color: #eee; 
              text-align: center; 
              padding-top: 20vh;
            }
            a { color: #4CAF50; }
          </style>
        </head>
        <body>
          <h2>⚠️ キャッシュ未生成</h2>
          <p>${hit.message}</p>
          <p>以下のリンクをクリックして、キャッシュを生成してください：</p>
          <p><a href="${hit.workerUrl}" target="_blank">${hit.workerUrl}</a></p>
          <p>クリック後、30秒後にこのページは自動で再読み込みされます。</p>
        </body>
        </html>
      `);
    }
    res.set('Content-Type', hit.type);
    res.set('Cache-Control', 'public, max-age=60');
    return res.status(hit.status).send(hit.buf);
  }

  // キャッシュがなければWorkerから取得
  try {
    const entry = await fetchFromWorker(key);
    entry.t = now;
    cache.set(key, entry);

    if (entry.blocked) {
      return res.status(503).set('Content-Type', 'text/html; charset=utf-8').send(`
        <!DOCTYPE html>
        <html lang="ja">
        <head>
          <meta charset="utf-8">
          <meta http-equiv="refresh" content="30">
          <title>キャッシュ生成中</title>
          <style>
            body { 
              font-family: sans-serif; 
              background: #111; 
              color: #eee; 
              text-align: center; 
              padding-top: 20vh;
            }
            a { color: #4CAF50; }
          </style>
        </head>
        <body>
          <h2>⚠️ キャッシュ未生成</h2>
          <p>${entry.message}</p>
          <p>以下のリンクをクリックして、キャッシュを生成してください：</p>
          <p><a href="${entry.workerUrl}" target="_blank">${entry.workerUrl}</a></p>
          <p>クリック後、30秒後にこのページは自動で再読み込みされます。</p>
        </body>
        </html>
      `);
    }

    res.set('Content-Type', entry.type);
    res.set('Cache-Control', 'public, max-age=60');
    res.status(entry.status).send(entry.buf);
  } catch (e) {
    res.status(502).send('Upstream fetch failed: ' + e.message);
  }
});

app.listen(PORT, () => console.log(`Render proxy ready on ${PORT}`));

import express from 'express';

const app = express();
app.disable('x-powered-by');

const PORT = process.env.PORT || 10000;
const WORKER_URL = (process.env.WORKER_URL || 'https://mangaraw.shunichi-0314.workers.dev').replace(/\/$/, '');

console.log(`Starting proxy server...`);
console.log(`Worker URL: ${WORKER_URL}`);

// キャッシュ（メモリ内）
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10分

// Workerへのリクエスト関数
async function fetchFromWorker(path) {
  const url = WORKER_URL + path;
  console.log(`Fetching from Worker: ${url}`);
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      },
      redirect: 'follow'
    });
    
    console.log(`Worker response status: ${response.status}`);
    
    const contentType = response.headers.get('content-type') || '';
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Workerがエラーページ（HTML）を返した場合
    if (response.status >= 500 && contentType.includes('text/html')) {
      const html = buffer.toString('utf8');
      if (html.includes('Error 1101') || html.includes('Worker threw exception')) {
        console.error('Worker returned Error 1101!');
        return {
          error: true,
          type: 'worker_error',
          message: 'Workerでエラーが発生しました。Workerの設定を確認してください。',
          status: 500
        };
      }
    }
    
    // WorkerがJSONエラーを返した場合
    if (contentType.includes('application/json')) {
      try {
        const json = JSON.parse(buffer.toString('utf8'));
        if (json.error === 'blocked') {
          return {
            error: true,
            type: 'blocked',
            message: json.message || '対象サイトにアクセスできません',
            workerUrl: json.workerUrl,
            status: 503
          };
        }
      } catch (e) {
        // JSONパース失敗は無視
      }
    }
    
    return {
      error: false,
      status: response.status,
      type: contentType,
      buffer: buffer
    };
    
  } catch (error) {
    console.error(`Fetch error: ${error.message}`);
    return {
      error: true,
      type: 'network_error',
      message: `Workerへの接続に失敗しました: ${error.message}`,
      status: 502
    };
  }
}

// ヒールスチェック用（上流へリクエストしない）
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// メインのルーティング
app.get('*', async (req, res) => {
  const path = req.url;
  const now = Date.now();
  
  console.log(`Request received: ${path}`);
  
  // キャッシュチェック
  const cached = cache.get(path);
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    console.log(`Cache hit: ${path}`);
    
    if (cached.error) {
      // エラーキャッシュの場合、エラーページを表示
      return res.status(cached.status || 503).set('Content-Type', 'text/html; charset=utf-8').send(`
        <!DOCTYPE html>
        <html lang="ja">
        <head>
          <meta charset="utf-8">
          <meta http-equiv="refresh" content="60">
          <title>Error</title>
          <style>
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
              background: #1a1a1a; 
              color: #e0e0e0; 
              text-align: center; 
              padding: 50px 20px;
              line-height: 1.6;
            }
            .error-box {
              max-width: 600px;
              margin: 0 auto;
              padding: 30px;
              background: #2a2a2a;
              border-radius: 8px;
              border-left: 4px solid #ff4444;
            }
            h1 { color: #ff4444; margin-bottom: 20px; }
            a { color: #4CAF50; text-decoration: none; }
            a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <div class="error-box">
            <h1>⚠️ ${cached.type === 'worker_error' ? 'Workerエラー' : 'アクセス制限中'}</h1>
            <p>${cached.message}</p>
            ${cached.workerUrl ? `
              <p style="margin-top: 30px;">
                <strong>解決方法:</strong><br>
                以下のリンクをクリックして、ブラウザで直接アクセスしてください：<br>
                <a href="${cached.workerUrl}" target="_blank">${cached.workerUrl}</a>
              </p>
            ` : ''}
            <p style="margin-top: 20px; font-size: 0.9em; color: #888;">
              60秒後に自動で再試行します...
            </p>
          </div>
        </body>
        </html>
      `);
    }
    
    // 正常なキャッシュ
    res.set('Content-Type', cached.type);
    res.set('Cache-Control', 'public, max-age=60');
    return res.status(cached.status).send(cached.buffer);
  }
  
  // キャッシュミス - Workerから取得
  console.log(`Cache miss - fetching from Worker: ${path}`);
  const result = await fetchFromWorker(path);
  
  // キャッシュに保存
  cache.set(path, {
    ...result,
    timestamp: now
  });
  
  if (result.error) {
    // エラーの場合、エラーページを表示
    return res.status(result.status || 503).set('Content-Type', 'text/html; charset=utf-8').send(`
      <!DOCTYPE html>
      <html lang="ja">
      <head>
        <meta charset="utf-8">
        <meta http-equiv="refresh" content="60">
        <title>Error</title>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
            background: #1a1a1a; 
            color: #e0e0e0; 
            text-align: center; 
            padding: 50px 20px;
            line-height: 1.6;
          }
          .error-box {
            max-width: 600px;
            margin: 0 auto;
            padding: 30px;
            background: #2a2a2a;
            border-radius: 8px;
            border-left: 4px solid #ff4444;
          }
          h1 { color: #ff4444; margin-bottom: 20px; }
          a { color: #4CAF50; text-decoration: none; }
          a:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <div class="error-box">
          <h1>⚠️ ${result.type === 'worker_error' ? 'Workerエラー' : 'アクセス制限中'}</h1>
          <p>${result.message}</p>
          ${result.workerUrl ? `
            <p style="margin-top: 30px;">
              <strong>解決方法:</strong><br>
              以下のリンクをクリックして、ブラウザで直接アクセスしてください：<br>
              <a href="${result.workerUrl}" target="_blank">${result.workerUrl}</a>
            </p>
          ` : ''}
          <p style="margin-top: 20px; font-size: 0.9em; color: #888;">
            60秒後に自動で再試行します...
          </p>
        </div>
      </body>
      </html>
    `);
  }
  
  // 正常なレスポンス
  console.log(`Success: ${path} - Status: ${result.status}`);
  res.set('Content-Type', result.type);
  res.set('Cache-Control', 'public, max-age=60');
  res.status(result.status).send(result.buffer);
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`✅ Render proxy server running on port ${PORT}`);
  console.log(`📍 Target Worker: ${WORKER_URL}`);
});

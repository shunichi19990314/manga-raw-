import express from 'express';
import { Readable } from 'stream';

const app = express();
// Render環境ではPORT環境変数が自動的に割り当てられます
const PORT = process.env.PORT || 10000;

// 【重要】ここにデプロイ済みの Cloudflare Worker のURLを貼り付けてください
// 例: 'https://manga-proxy.your-subdomain.workers.dev'
const WORKER_URL = process.env.WORKER_URL || 'https://your-worker-name.your-subdomain.workers.dev';

app.all('*', async (req, res) => {
  try {
    // クライアントからのリクエストパスを Worker の URL に結合
    // 例: req.url が "/page/2/" なら WORKER_URL + "/page/2/" になる
    const targetUrl = new URL(req.url, WORKER_URL).toString();

    // リクエストヘッダーの準備 (host などは fetch が自動設定するため削除)
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];

    const fetchOptions = {
      method: req.method,
      headers: headers,
    };

    // GET/HEAD 以外のリクエスト（POSTなど）の場合のボディ処理
    // ※漫画サイトの閲覧は基本的に GET リクエストのみなので、簡易的な実装にしています
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      await new Promise(resolve => req.on('end', resolve));
      fetchOptions.body = body;
    }

    // Cloudflare Worker へリクエストを転送
    const response = await fetch(targetUrl, fetchOptions);

    // Worker からのレスポンスヘッダーをクライアントに返す
    response.headers.forEach((value, key) => {
      // gzip 等のエンコーディングは Render/Express 側で処理させるため削除して衝突を防ぐ
      if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'transfer-encoding') {
        res.setHeader(key, value);
      }
    });

    // ステータスコードを設定
    res.status(response.status);

    // Node.js 18+ の Web Stream (response.body) を Node Stream に変換してパイプ転送
    // これにより、大容量の画像やHTMLでもメモリを圧迫せずにストリーム配信が可能
    const nodeStream = Readable.fromWeb(response.body);
    nodeStream.pipe(res);

  } catch (error) {
    console.error('Proxy Error:', error);
    res.status(500).send('Internal Server Error on Render Proxy');
  }
});

app.listen(PORT, () => {
  console.log(`Render proxy server is running on port ${PORT}`);
  console.log(`Targeting Worker at: ${WORKER_URL}`);
});

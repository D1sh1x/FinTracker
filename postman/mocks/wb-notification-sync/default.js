const http = require('node:http');
let mode = 'normal';
// Private emulator fixture: the real isolated Go API remains authoritative.
http.createServer((req, res) => {
  const path = req.url.replace(/^\/api\//, '/');
  if (path.startsWith('/__test/mode/')) {
    mode = path.slice('/__test/mode/'.length);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ mode })); return;
  }
  const purchase = req.method === 'POST' && path.endsWith('/notification-imports');
  if (purchase && mode === 'unavailable') {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'service_unavailable', message: 'Synthetic temporary outage' } })); return;
  }
  if (purchase && mode === 'unauthorized') {
    res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('Unauthorized'); return;
  }
  const upstream = http.request({ host: '127.0.0.1', port: 18091, path: '/api' + path, method: req.method,
    headers: { ...req.headers, host: '127.0.0.1:18091' } }, response => {
    if (purchase && mode === 'lose-response') {
      response.resume(); response.on('end', () => res.destroy()); return;
    }
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.setTimeout(20000, () => upstream.destroy());
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end(); });
  req.pipe(upstream);
}).listen(process.env.PORT || 4901, '127.0.0.1');

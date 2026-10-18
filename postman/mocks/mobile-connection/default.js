const http = require('node:http');

// /api is the simulation routeKey; standalone mock requests retain that prefix.
http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname.replace(/^\/api\//, '/');
  if (req.method !== 'GET' || pathname !== '/v1/profiles') {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_implemented', message: 'This fixture only models connection setup.' } }));
    return;
  }
  // Synthetic shared Caddy login, not individual profile authentication.
  if (req.headers.authorization !== 'Basic ' + Buffer.from('owner:mobile-test').toString('base64')) {
    res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Basic realm="FinTrack test"' });
    res.end('Unauthorized');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ items: [] }));
}).listen(process.env.PORT || 4900, '127.0.0.1');

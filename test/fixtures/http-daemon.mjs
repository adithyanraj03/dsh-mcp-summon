// Minimal long-lived HTTP service for daemon: tests.
// Usage: node http-daemon.mjs <port> — answers 200 on any path until killed.
import { createServer } from 'node:http';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write('usage: node http-daemon.mjs <port>\n');
  process.exit(2);
}
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
}).listen(port, '127.0.0.1');

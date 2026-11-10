import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Fan, FanError } from './lib/fan.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
export async function loadConfig(path = resolve(root, 'config.json')) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(config.fanHost) || !isLocalAddress(config.fanHost)
    || config.fanHost.split('.').some(part => Number(part) > 255)) throw new Error('fanHost must be a local IPv4 address.');
  if (!/^([\da-f]{2}:){5}[\da-f]{2}$/i.test(config.fanMac)) throw new Error('fanMac must be a MAC address.');
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Invalid app port.');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 30000) throw new Error('Invalid timeout.');
  if (config.homeKitPort !== undefined && (!Number.isInteger(config.homeKitPort) || config.homeKitPort < 1024 || config.homeKitPort > 65535 || config.homeKitPort === config.port)) throw new Error('Invalid Apple Home port.');
  return config;
}

export function isLocalAddress(address = '') {
  const ip = address.replace(/^::ffff:/, '');
  return ip === '::1' || /^(fc|fd|fe80:)/i.test(ip)
    || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

export function localAddresses() {
  return Object.values(networkInterfaces()).flat().filter(item => item && !item.internal && item.family === 'IPv4' && isLocalAddress(item.address)).map(item => item.address);
}

function validHost(value) {
  try {
    const host = new URL(`http://${value}`).hostname.toLowerCase();
    const machine = hostname().toLowerCase();
    return new Set(['localhost', '127.0.0.1', '[::1]', machine, `${machine.replace(/\.local$/, '')}.local`, ...localAddresses()]).has(host);
  } catch { return false; }
}

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/apple-touch-icon.png', ['apple-touch-icon.png', 'image/png']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
]);

export function createApp(config, fan = new Fan(config), options = {}) {
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (!isLocalAddress(req.socket.remoteAddress) || !validHost(req.headers.host)) throw new FanError('Local network access only.', 403);
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new FanError('Cross-site requests are not allowed.', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return send(200, { app: 'modern-forms-local-control', instance: process.env.FAN_CONTROL_INSTANCE ?? null });
      }
      if (req.method === 'GET' && url.pathname === '/api/info') {
        return send(200, { name: config.name, fanHost: config.fanHost, fanMac: config.fanMac, port: config.port,
          urls: localAddresses().map(ip => `http://${ip}:${config.port}`),
          hostnameUrl: `http://${hostname().replace(/\.local$/, '')}.local:${config.port}` });
      }
      if (req.method === 'GET' && ['/api/homekit', '/api/homekit/qr'].includes(url.pathname)) {
        const address = req.socket.remoteAddress?.replace(/^::ffff:/, '');
        if (address !== '::1' && !address?.startsWith('127.')) throw new FanError('Open Fan Control on your Mac to pair with Apple Home.', 403);
        const homeKit = options.homeKit?.();
        if (url.pathname === '/api/homekit') return send(200, homeKit?.info() ?? { enabled: false, error: options.homeKitError?.() ?? 'Open Fan Control.app to start Apple Home support.' });
        const svg = homeKit?.qr();
        if (!svg) return send(404, { error: 'No pairing code is available.' });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        return res.end(svg);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return send(200, await fan.read({ fresh: url.searchParams.get('fresh') === '1' }));
      }
      if (req.method === 'POST' && url.pathname === '/api/control') {
        if (req.headers['x-fan-control'] !== '1' || req.headers['content-type']?.split(';')[0] !== 'application/json') {
          throw new FanError('Use JSON and the X-Fan-Control: 1 header.', 400);
        }
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 1024) throw new FanError('Request is too large.', 413);
        }
        let command;
        try { command = JSON.parse(body); } catch { throw new FanError('Invalid JSON.', 400); }
        return send(200, await fan.write(command));
      }
      if (req.method === 'GET' && files.has(url.pathname)) {
        const [file, type] = files.get(url.pathname);
        const data = await readFile(resolve(root, 'public', file));
        res.writeHead(200, { 'Content-Type': type });
        return res.end(data);
      }
      send(404, { error: 'Not found.' });
    } catch (error) {
      send(error.status ?? 500, { ...fan.snapshot(), error: error.status ? error.message : 'The controller encountered an error.' });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = await loadConfig();
  const server = createApp(config);
  server.on('error', error => { console.error(`Cannot start controller: ${error.message}`); process.exit(1); });
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`Fan Control: http://localhost:${config.port}`);
    for (const ip of localAddresses()) console.log(`iPhone: http://${ip}:${config.port}`);
    console.log(`Fan: ${config.fanHost} — keep this Mac awake for access.`);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); server.closeIdleConnections(); });
}

import type { FanConfig, FanController } from './lib/types.js';
import type { HomeKitBridge } from './lib/homekit.js';
import { Scheduler } from './lib/scheduler.js';
import { isRecord } from './lib/validation.js';

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Fan, FanError } from './lib/fan.js';
import { loadConfig } from './lib/config.js';
import { isLocalAddress, localAddresses, localHostname, validHost } from './lib/network.js';
import { readCommand, readJson } from './lib/http.js';

interface AppOptions {
  scheduler?: Scheduler;
  homeKit?: () => HomeKitBridge | undefined;
  homeKitError?: () => string | undefined;
  onError?: (error: unknown) => void;
}

const root = fileURLToPath(new URL('../', import.meta.url));
const files = new Map<string, [string, string]>([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/api.js', ['api.js', 'text/javascript; charset=utf-8']],
  ['/homekit.js', ['homekit.js', 'text/javascript; charset=utf-8']],
  ['/schedules.js', ['schedules.js', 'text/javascript; charset=utf-8']],
  ['/schedules.css', ['schedules.css', 'text/css; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/apple-touch-icon.png', ['apple-touch-icon.png', 'image/png']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
]);

export function createApp(
  config: FanConfig,
  fan: FanController = new Fan(config),
  options: AppOptions = {},
) {
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      if (!isLocalAddress(req.socket.remoteAddress) || !validHost(req.headers.host))
        throw new FanError('Local network access only.', 403);
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
        throw new FanError('Cross-site requests are not allowed.', 403);
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return send(200, {
          app: 'modern-forms-local-control',
          instance: process.env.FAN_CONTROL_INSTANCE ?? null,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/info') {
        return send(200, {
          name: config.name,
          fanHost: config.fanHost,
          fanMac: config.fanMac,
          port: config.port,
          urls: localAddresses().map((ip) => `http://${ip}:${config.port}`),
          hostnameUrl: `http://${localHostname()}:${config.port}`,
        });
      }
      if (req.method === 'GET' && ['/api/homekit', '/api/homekit/qr'].includes(url.pathname)) {
        const address = req.socket.remoteAddress?.replace(/^::ffff:/, '');
        if (address !== '::1' && !address?.startsWith('127.'))
          throw new FanError('Open Fan Control on your Mac to pair with Apple Home.', 403);
        const homeKit = options.homeKit?.();
        if (url.pathname === '/api/homekit')
          return send(
            200,
            homeKit?.info() ?? {
              enabled: false,
              error:
                options.homeKitError?.() ?? 'Open Fan Control.app to start Apple Home support.',
            },
          );
        const svg = homeKit?.qr();
        if (!svg) return send(404, { error: 'No pairing code is available.' });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        return res.end(svg);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return send(200, await fan.read({ fresh: url.searchParams.get('fresh') === '1' }));
      }
      if (req.method === 'POST' && url.pathname === '/api/control') {
        const command = await readCommand(req);
        return send(200, await fan.write(command));
      }
      if (
        url.pathname === '/api/schedules' ||
        url.pathname === '/api/schedule-settings' ||
        url.pathname.startsWith('/api/schedules/')
      ) {
        const scheduler = options.scheduler;
        if (!scheduler) throw new FanError('Scheduling is not available in this controller.', 503);
        if (req.method === 'GET' && url.pathname === '/api/schedules')
          return send(200, scheduler.snapshot());
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
          const input = await readJson(req, 8192);
          if (!isRecord(input)) throw new FanError('Expected a schedule request.', 400);
          if (req.method === 'POST' && url.pathname === '/api/schedules') {
            return send(200, await scheduler.save(input.schedule, input.revision));
          }
          if (req.method === 'PUT' && url.pathname === '/api/schedule-settings') {
            return send(200, await scheduler.configure(input.settings, input.revision));
          }
          if (req.method === 'DELETE' && /^\/api\/schedules\/[a-f\d-]{36}$/i.test(url.pathname)) {
            return send(
              200,
              await scheduler.remove(url.pathname.split('/').at(-1)!, input.revision),
            );
          }
        }
      }
      const asset = files.get(url.pathname);
      if (req.method === 'GET' && asset) {
        const [file, type] = asset;
        const data = await readFile(resolve(root, 'public', file));
        res.writeHead(200, { 'Content-Type': type });
        return res.end(data);
      }
      send(404, { error: 'Not found.' });
    } catch (error) {
      if (error instanceof FanError && error.status === 413) res.setHeader('Connection', 'close');
      if (!(error instanceof FanError)) (options.onError ?? console.error)(error);
      send(error instanceof FanError ? error.status : 500, {
        ...fan.snapshot(),
        error: error instanceof FanError ? error.message : 'The controller encountered an error.',
      });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = await loadConfig();
  const fan = new Fan(config);
  const scheduler = await Scheduler.open(resolve(root, '.runtime/schedules.json'), fan);
  const server = createApp(config, fan, { scheduler });
  server.on('error', (error) => {
    console.error(`Cannot start controller: ${error.message}`);
    process.exit(1);
  });
  server.listen(config.port, '0.0.0.0', () => {
    scheduler.start();
    console.log(`Fan Control: http://localhost:${config.port}`);
    for (const ip of localAddresses()) console.log(`iPhone: http://${ip}:${config.port}`);
    console.log(`Fan: ${config.fanHost} — keep this Mac awake for access.`);
  });
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => {
      void scheduler.stop();
      server.close();
      server.closeIdleConnections();
    });
}

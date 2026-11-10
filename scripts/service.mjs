import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, open, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../build/lib/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = await loadConfig();
const runtime = resolve(root, '.runtime');
const recordPath = resolve(runtime, 'service.json');
const url = `http://127.0.0.1:${config.port}`;
const health = async () => {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
};

try {
  if (process.argv[2] === 'stop') {
    let record;
    try {
      record = JSON.parse(await readFile(recordPath, 'utf8'));
    } catch {
      console.log('No background controller to stop.');
      process.exit(0);
    }
    const running = await health();
    if (!running) {
      console.log('The controller is already stopped.');
      process.exit(0);
    }
    if (running.app !== 'modern-forms-local-control' || running.instance !== record.instance) {
      throw new Error(
        'The process on this port is not this launcher’s controller. It was left running.',
      );
    }
    process.kill(record.pid, 'SIGTERM');
    for (let attempt = 0; attempt < 20 && (await health()); attempt++) await delay(200);
    if (await health())
      throw new Error('The controller is still shutting down. Try again shortly.');
    await unlink(recordPath);
    console.log('Fan Control stopped. Your fan and light settings were not changed.');
  } else {
    const running = await health();
    if (running && running.app !== 'modern-forms-local-control')
      throw new Error(`Port ${config.port} is in use by another app.`);
    if (!running) {
      await mkdir(runtime, { recursive: true });
      const log = await open(resolve(runtime, 'server.log'), 'a', 0o600);
      const instance = randomUUID();
      const child = spawn(process.execPath, [resolve(root, 'build/server.js')], {
        cwd: root,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        env: { ...process.env, FAN_CONTROL_INSTANCE: instance },
      });
      child.on('error', (error) => console.error(error.message));
      child.unref();
      await log.close();
      let ready = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        await delay(150);
        const state = await health();
        if (state?.instance === instance) {
          ready = true;
          break;
        }
      }
      if (!ready) throw new Error('The controller could not start. See .runtime/server.log.');
      await writeFile(recordPath, JSON.stringify({ pid: child.pid, instance }), { mode: 0o600 });
    }
    console.log(`Fan Control is running at ${url}`);
    const response = await fetch(`${url}/api/info`);
    const info = await response.json();
    for (const address of info.urls) console.log(`On iPhone, open Safari: ${address}`);
    console.log('Keep this Mac awake. Use Stop Fan Control.command to stop the app.');
    if (process.argv.includes('--open')) {
      try {
        await promisify(execFile)('/usr/bin/open', [url]);
      } catch {
        throw new Error(`Could not open the default browser. Open ${url} manually.`);
      }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

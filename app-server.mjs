import { mkdir, copyFile, constants } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, loadConfig } from './server.mjs';
import { Fan } from './lib/fan.mjs';
import { startHomeKit } from './lib/homekit.mjs';

process.umask(0o077);
const root = fileURLToPath(new URL('.', import.meta.url));
const directory = process.env.FAN_CONTROL_DATA_DIR;
if (!directory) throw new Error('Fan Control requires a private data directory.');
await mkdir(directory, { recursive: true, mode: 0o700 });
const configPath = resolve(directory, 'config.json');
try { await copyFile(resolve(root, 'config.json'), configPath, constants.COPYFILE_EXCL); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const config = await loadConfig(configPath);
const fan = new Fan(config);
let homeKit;
let homeKitError;
const server = createApp(config, fan, { homeKit: () => homeKit, homeKitError: () => homeKitError });
await new Promise((resolveReady, reject) => {
  server.once('error', reject);
  server.listen(config.port, '0.0.0.0', resolveReady);
});
console.log(`Fan Control server ready on port ${config.port}.`);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(parentWatch);
  const deadline = setTimeout(() => process.exit(1), 4500);
  deadline.unref();
  server.close(); server.closeIdleConnections();
  await homeKit?.stop();
  console.log('Fan Control server stopped.');
  process.exit(0);
};
const parent = Number(process.env.FAN_CONTROL_PARENT_PID);
const parentWatch = setInterval(() => {
  if (!Number.isSafeInteger(parent) || parent <= 1) return;
  try { process.kill(parent, 0); } catch { void stop(); }
}, 1000);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void stop());
try { homeKit = await startHomeKit(config, fan, resolve(directory, 'homekit')); }
catch (error) { homeKitError = error.message; console.error(`Apple Home unavailable: ${error.message}`); }

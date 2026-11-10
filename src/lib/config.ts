import type { FanConfig } from './types.js';
import { hasErrorCode, isIntegerBetween, isRecord } from './validation.js';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isLocalAddress } from './network.js';

export const DEFAULT_HOMEKIT_PORT = 51826;

function validPort(value: unknown): value is number {
  return isIntegerBetween(value, 1024, 65535);
}

export function validateConfig(config: unknown): FanConfig {
  if (!isRecord(config)) {
    throw new Error('config.json must contain a configuration object.');
  }
  if (typeof config.name !== 'string' || !config.name.trim() || config.name.length > 80) {
    throw new Error('name must be a nonempty string of at most 80 characters.');
  }
  if (
    typeof config.fanHost !== 'string' ||
    isIP(config.fanHost) !== 4 ||
    !isLocalAddress(config.fanHost)
  ) {
    throw new Error('fanHost must be a local IPv4 address.');
  }
  if (typeof config.fanMac !== 'string' || !/^([\da-f]{2}:){5}[\da-f]{2}$/i.test(config.fanMac)) {
    throw new Error('fanMac must be a MAC address.');
  }
  if (!validPort(config.port)) throw new Error('Invalid app port.');
  if (!isIntegerBetween(config.timeoutMs, 1000, 30000)) {
    throw new Error('timeoutMs must be an integer between 1000 and 30000.');
  }
  const homeKitPort = config.homeKitPort === undefined ? DEFAULT_HOMEKIT_PORT : config.homeKitPort;
  if (!validPort(homeKitPort) || homeKitPort === config.port) {
    throw new Error('The Apple Home port must be valid and different from the app port.');
  }
  return {
    name: config.name,
    fanHost: config.fanHost,
    fanMac: config.fanMac,
    port: config.port,
    timeoutMs: config.timeoutMs,
    ...(config.homeKitPort !== undefined ? { homeKitPort } : {}),
  };
}

export async function loadConfig(
  path: string | URL = new URL('../../config.json', import.meta.url),
) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      throw new Error('Missing config.json. Copy config.example.json and enter your fan settings.');
    }
    throw error;
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error('config.json is not valid JSON. Check its commas and quotation marks.');
  }
  return validateConfig(config);
}

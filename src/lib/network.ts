import { isIP } from 'node:net';
import { networkInterfaces, hostname } from 'node:os';

export function isLocalAddress(address: unknown = '') {
  if (typeof address !== 'string') return false;
  const ip = address.replace(/^::ffff:/i, '');
  if (isIP(ip) === 4) {
    return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  }
  if (isIP(ip) === 6) {
    return ip === '::1' || /^(fc|fd|fe[89ab])/i.test(ip);
  }
  return false;
}

export function localAddresses() {
  return Object.values(networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter(
      (item) => item && !item.internal && item.family === 'IPv4' && isLocalAddress(item.address),
    )
    .map((item) => item.address);
}

export function localHostname() {
  return `${hostname().replace(/\.local$/i, '')}.local`;
}

export function validHost(value: unknown) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(`http://${value}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      return false;
    return new Set([
      'localhost',
      '127.0.0.1',
      '[::1]',
      hostname().toLowerCase(),
      localHostname().toLowerCase(),
      ...localAddresses(),
    ]).has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

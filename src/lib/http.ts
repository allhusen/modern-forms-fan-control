import type { IncomingMessage } from 'node:http';
import type { FanCommand } from './types.js';
import { FanError, validateCommand } from './fan.js';

export async function readJson(req: IncomingMessage, limit = 1024): Promise<unknown> {
  if (
    req.headers['x-fan-control'] !== '1' ||
    req.headers['content-type']?.split(';')[0] !== 'application/json'
  ) {
    throw new FanError('Use JSON and the X-Fan-Control: 1 header.', 400);
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  // Keep the socket available long enough to send a useful 413 response.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) {
      req.resume();
      throw new FanError('Request is too large.', 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof FanError) throw error;
    throw new FanError('Invalid JSON.', 400);
  }
}

export async function readCommand(req: IncomingMessage): Promise<FanCommand> {
  return validateCommand(await readJson(req));
}

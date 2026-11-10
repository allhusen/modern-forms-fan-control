import type {
  BreezeStrength,
  FanCommand,
  FanCommandFactory,
  FanConfig,
  FanController,
  FanSnapshot,
  FanSpeed,
  FanState,
  OnlineSnapshot,
} from './types.js';
import { errorMessage, isIntegerBetween, isRecord } from './validation.js';

export class FanError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'FanError';
  }
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const CACHE_DURATION_MS = 5000;

function isFanSpeed(value: unknown): value is FanSpeed {
  return isIntegerBetween(value, 1, 6);
}

function isBreezeStrength(value: unknown): value is BreezeStrength {
  return isIntegerBetween(value, 1, 3);
}

async function readResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new FanError('The fan returned an empty response.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new FanError('The fan returned an unexpectedly large response.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new FanError('The fan responded, but its reply was not valid JSON.');
  }
}

/** Validate untrusted input before it becomes a command. Numeric brightness is checked here. */
export function validateCommand(command: unknown): FanCommand {
  if (!isRecord(command) || !Object.keys(command).length) {
    throw new FanError('Choose a control to change.', 400);
  }
  for (const [key, value] of Object.entries(command)) {
    const valid =
      (['lightOn', 'fanOn', 'wind'].includes(key) && typeof value === 'boolean') ||
      (key === 'fanSpeed' && isFanSpeed(value)) ||
      (key === 'lightBrightness' && isIntegerBetween(value, 1, 100)) ||
      (key === 'windSpeed' && isBreezeStrength(value)) ||
      (key === 'fanDirection' && (value === 'forward' || value === 'reverse'));
    if (!valid) throw new FanError(`Unsupported control or value: ${key}`, 400);
  }
  // Every key and value, including nonemptiness, was checked above.
  return command as FanCommand;
}

function confirms(state: FanState, command: FanCommand): boolean {
  return Object.entries(command).every(([key, value]) => state[key as keyof FanCommand] === value);
}

type FanOptions = Pick<FanConfig, 'fanHost' | 'fanMac'> & {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class Fan implements FanController {
  private readonly url: string;
  private readonly host: string;
  private readonly mac: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;
  private currentState: FanState | null = null;
  private updatedAt: string | null = null;
  private error: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pendingRead: Promise<OnlineSnapshot> | null = null;

  constructor({ fanHost, fanMac, timeoutMs = 8000, fetchImpl = fetch }: FanOptions) {
    this.url = `http://${fanHost}/mf`;
    this.host = fanHost;
    this.mac = fanMac.replaceAll(':', '').toUpperCase();
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  get state(): FanState | null {
    return this.currentState;
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }

  private async request(body: FanCommand | { queryDynamicShadowData: 1 }): Promise<unknown> {
    try {
      const response = await this.fetch(this.url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new FanError(`The fan returned HTTP ${response.status}.`);
      return await readResponse(response);
    } catch (error) {
      if (error instanceof FanError) throw error;
      throw new FanError(
        `Cannot reach the fan at ${this.host}. Check its power and Wi-Fi, and that this Mac can reach the IoT network.`,
        503,
      );
    }
  }

  private accept(raw: unknown): OnlineSnapshot {
    if (!isRecord(raw)) throw new FanError('The fan returned an invalid status.');
    const id =
      typeof raw.clientId === 'string' ? raw.clientId.split('_').at(-1)?.toUpperCase() : '';
    if (id !== this.mac) {
      throw new FanError(
        'The device identity does not match your fan. Check its IP address and MAC in config.json.',
      );
    }
    if (
      typeof raw.fanOn !== 'boolean' ||
      typeof raw.lightOn !== 'boolean' ||
      !(raw.fanSpeed === 0 || isFanSpeed(raw.fanSpeed)) ||
      !isIntegerBetween(raw.lightBrightness, 1, 100) ||
      !(raw.fanDirection === 'forward' || raw.fanDirection === 'reverse')
    ) {
      throw new FanError(
        'The fan response is missing the expected power, speed, or direction values.',
      );
    }
    this.currentState = {
      fanOn: raw.fanOn,
      lightOn: raw.lightOn,
      lightBrightness: raw.lightBrightness,
      fanSpeed: raw.fanSpeed,
      fanDirection: raw.fanDirection,
      wind: typeof raw.wind === 'boolean' ? raw.wind : null,
      windSpeed: isBreezeStrength(raw.windSpeed) ? raw.windSpeed : null,
    };
    this.updatedAt = new Date().toISOString();
    this.error = null;
    return { online: true, state: this.currentState, updatedAt: this.updatedAt, error: null };
  }

  snapshot(): FanSnapshot {
    if (this.currentState && this.updatedAt && !this.error) {
      return { online: true, state: this.currentState, updatedAt: this.updatedAt, error: null };
    }
    return {
      online: false,
      state: this.currentState,
      updatedAt: this.updatedAt,
      error: this.error,
    };
  }

  read({ fresh = false } = {}): Promise<OnlineSnapshot> {
    if (this.pendingRead) return this.pendingRead;
    this.pendingRead = this.serial(async () => {
      const snapshot = this.snapshot();
      if (
        !fresh &&
        snapshot.online &&
        Date.now() - Date.parse(snapshot.updatedAt) < CACHE_DURATION_MS
      ) {
        return snapshot;
      }
      try {
        return this.accept(await this.request({ queryDynamicShadowData: 1 }));
      } catch (error) {
        this.error = errorMessage(error);
        throw error;
      }
    }).finally(() => {
      this.pendingRead = null;
    });
    return this.pendingRead;
  }

  /** Read-only diagnostic data, serialized and identity-checked like normal status reads. */
  inspect(): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      try {
        const raw = await this.request({ queryDynamicShadowData: 1 });
        this.accept(raw);
        if (!isRecord(raw)) throw new FanError('The fan returned an invalid status.');
        return raw;
      } catch (error) {
        this.error = errorMessage(error);
        throw error;
      }
    });
  }

  /** Send one validated change and confirm it. Physical writes are never automatically retried. */
  write(command: FanCommand | FanCommandFactory): Promise<OnlineSnapshot> {
    if (typeof command !== 'function') validateCommand(command);
    return this.serial(async () => {
      try {
        // Verify identity and refresh settings before resolving a state-dependent command.
        const current = this.accept(await this.request({ queryDynamicShadowData: 1 })).state;
        const desired = {
          ...validateCommand(typeof command === 'function' ? command({ ...current }) : command),
        };
        if (
          ('wind' in desired || 'windSpeed' in desired) &&
          (current.wind === null || current.windSpeed === null)
        ) {
          throw new FanError('This fan does not report support for Breeze mode.', 400);
        }
        if (desired.fanOn === true && !desired.fanSpeed && current.fanSpeed === 0)
          desired.fanSpeed = 1;
        const reply = await this.request(desired);
        // Some firmware only acknowledges writes; read back in that case.
        const result =
          isRecord(reply) && reply.clientId && typeof reply.fanOn === 'boolean'
            ? reply
            : await this.request({ queryDynamicShadowData: 1 });
        let confirmed = this.accept(result);
        if (!confirms(confirmed.state, desired)) {
          confirmed = this.accept(await this.request({ queryDynamicShadowData: 1 }));
          if (!confirms(confirmed.state, desired)) {
            throw new FanError(
              'The fan responded but did not confirm the change. Its reported settings are shown.',
              409,
            );
          }
        }
        return confirmed;
      } catch (error) {
        // A rejected command does not make the last verified device offline.
        if (!(error instanceof FanError) || error.status >= 500) this.error = errorMessage(error);
        throw error;
      }
    });
  }
}

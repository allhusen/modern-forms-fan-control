export class FanError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

export function validateCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command) || !Object.keys(command).length) {
    throw new FanError('Choose a control to change.', 400);
  }
  for (const [key, value] of Object.entries(command)) {
    const valid = (['lightOn', 'fanOn', 'wind'].includes(key) && typeof value === 'boolean')
      || (key === 'fanSpeed' && Number.isInteger(value) && value >= 1 && value <= 6)
      || (key === 'lightBrightness' && Number.isInteger(value) && value >= 1 && value <= 100)
      || (key === 'windSpeed' && Number.isInteger(value) && value >= 1 && value <= 3)
      || (key === 'fanDirection' && ['forward', 'reverse'].includes(value));
    if (!valid) throw new FanError(`Unsupported control or value: ${key}`, 400);
  }
  return command;
}

export class Fan {
  constructor({ fanHost, fanMac, timeoutMs = 8000, fetchImpl = fetch }) {
    this.url = `http://${fanHost}/mf`;
    this.host = fanHost;
    this.mac = fanMac.replaceAll(':', '').toUpperCase();
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.state = null;
    this.updatedAt = null;
    this.error = null;
    this.queue = Promise.resolve();
    this.pendingRead = null;
  }

  serial(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }

  async request(body) {
    try {
      const response = await this.fetch(this.url, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new FanError(`The fan returned HTTP ${response.status}.`);
      const text = await response.text();
      if (text.length > 65536) throw new FanError('The fan returned an unexpectedly large response.');
      try { return JSON.parse(text); }
      catch { throw new FanError('The fan responded, but its reply was not valid JSON.'); }
    } catch (error) {
      if (error instanceof FanError) throw error;
      throw new FanError(`Cannot reach the fan at ${this.host}. Check its power and Wi-Fi, and that this Mac can reach the IoT network.`, 503);
    }
  }

  accept(raw) {
    if (!raw || typeof raw !== 'object') throw new FanError('The fan returned an invalid status.');
    const id = typeof raw.clientId === 'string' ? raw.clientId.split('_').at(-1).toUpperCase() : '';
    if (id !== this.mac) throw new FanError('The device identity does not match your fan. Check its IP address and MAC in config.json.');
    if (typeof raw.fanOn !== 'boolean' || typeof raw.lightOn !== 'boolean'
      || !Number.isInteger(raw.fanSpeed) || raw.fanSpeed < 0 || raw.fanSpeed > 6
      || !Number.isInteger(raw.lightBrightness) || raw.lightBrightness < 1 || raw.lightBrightness > 100
      || !['forward', 'reverse'].includes(raw.fanDirection)) {
      throw new FanError('The fan response is missing the expected power, speed, or direction values.');
    }
    this.state = {
      fanOn: raw.fanOn, lightOn: raw.lightOn, lightBrightness: raw.lightBrightness,
      fanSpeed: raw.fanSpeed, fanDirection: raw.fanDirection,
      wind: typeof raw.wind === 'boolean' ? raw.wind : null,
      windSpeed: Number.isInteger(raw.windSpeed) && raw.windSpeed >= 1 && raw.windSpeed <= 3 ? raw.windSpeed : null,
    };
    this.updatedAt = new Date().toISOString();
    this.error = null;
    return this.snapshot();
  }

  snapshot() {
    return { online: Boolean(this.state) && !this.error, state: this.state, updatedAt: this.updatedAt, error: this.error };
  }

  read({ fresh = false } = {}) {
    if (this.pendingRead) return this.pendingRead;
    this.pendingRead = this.serial(async () => {
      if (!fresh && this.state && !this.error && Date.now() - Date.parse(this.updatedAt) < 5000) return this.snapshot();
      try { return this.accept(await this.request({ queryDynamicShadowData: 1 })); }
      catch (error) { this.error = error.message; throw error; }
    }).finally(() => { this.pendingRead = null; });
    return this.pendingRead;
  }

  write(command) {
    if (typeof command !== 'function') validateCommand(command);
    return this.serial(async () => {
      try {
        // Verify identity and get a fresh state before sending any physical command.
        this.accept(await this.request({ queryDynamicShadowData: 1 }));
        // Resolve state-dependent Home commands inside the device queue, after
        // refreshing its settings, so an earlier Breeze change is respected.
        const desired = { ...validateCommand(typeof command === 'function' ? command({ ...this.state }) : command) };
        if (('wind' in desired || 'windSpeed' in desired) && (this.state.wind === null || this.state.windSpeed === null)) {
          throw new FanError('This fan does not report support for Breeze mode.', 400);
        }
        if (desired.fanOn === true && !desired.fanSpeed && this.state.fanSpeed === 0) desired.fanSpeed = 1;
        const reply = await this.request(desired);
        // Some firmware versions only acknowledge writes; read back in that case.
        const result = reply?.clientId && typeof reply.fanOn === 'boolean' ? reply : await this.request({ queryDynamicShadowData: 1 });
        this.accept(result);
        if (Object.entries(desired).some(([key, value]) => this.state[key] !== value)) {
          this.accept(await this.request({ queryDynamicShadowData: 1 }));
          if (Object.entries(desired).some(([key, value]) => this.state[key] !== value)) {
            throw new FanError('The fan responded but did not confirm the change. Its reported settings are shown.', 409);
          }
        }
        return this.snapshot();
      } catch (error) {
        if (error.status !== 409) this.error = error.message;
        throw error;
      }
    });
  }
}

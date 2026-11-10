export type FanSpeed = 1 | 2 | 3 | 4 | 5 | 6;
export type BreezeStrength = 1 | 2 | 3;
export type FanDirection = 'forward' | 'reverse';

interface ControlValues {
  fanOn: boolean;
  lightOn: boolean;
  fanSpeed: FanSpeed;
  fanDirection: FanDirection;
  lightBrightness: number;
  wind: boolean;
  windSpeed: BreezeStrength;
}

// A command changes one or more supported fields, never an empty object.
type AtLeastOne<T> = {
  [K in keyof T]: Pick<T, K> & Partial<Omit<T, K>>;
}[keyof T];

export type FanCommand = AtLeastOne<ControlValues>;

export interface FanState {
  readonly fanOn: boolean;
  readonly lightOn: boolean;
  readonly fanSpeed: 0 | FanSpeed;
  readonly fanDirection: FanDirection;
  readonly lightBrightness: number;
  readonly wind: boolean | null;
  readonly windSpeed: BreezeStrength | null;
}

/** Resolved synchronously against freshly verified state, inside the device queue. */
export type FanCommandFactory = (state: FanState) => FanCommand;

export interface OnlineSnapshot {
  readonly online: true;
  readonly state: FanState;
  readonly updatedAt: string;
  readonly error: null;
}

export interface OfflineSnapshot {
  readonly online: false;
  readonly state: FanState | null;
  readonly updatedAt: string | null;
  readonly error: string | null;
}

export type FanSnapshot = OnlineSnapshot | OfflineSnapshot;

export interface FanController {
  read(options?: { fresh?: boolean }): Promise<OnlineSnapshot>;
  write(command: FanCommand | FanCommandFactory): Promise<OnlineSnapshot>;
  snapshot(): FanSnapshot;
}

export interface FanConfig {
  name: string;
  fanHost: string;
  fanMac: string;
  port: number;
  timeoutMs: number;
  homeKitPort?: number;
}

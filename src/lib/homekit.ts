import type { Characteristic, CharacteristicValue } from 'hap-nodejs';
import type {
  BreezeStrength,
  FanCommand,
  FanConfig,
  FanController,
  FanSnapshot,
  FanSpeed,
  FanState,
} from './types.js';
import { hasErrorCode, isRecord } from './validation.js';

import hap from 'hap-nodejs';
import QRCode from 'qrcode';
import { DEFAULT_HOMEKIT_PORT } from './config.js';
import { randomBytes, randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface HomeKitIdentity {
  username: string;
  pincode: string;
  setupID: string;
}

interface CharacteristicBinding {
  characteristic: Characteristic;
  label: string;
  read: (state: FanState) => CharacteristicValue;
  command: (value: CharacteristicValue, state: FanState) => FanCommand;
}

export interface HomeKitInfo {
  enabled: true;
  paired: boolean;
  ready: boolean;
  name: string;
  accessories: string[];
  pincode?: string;
}

export interface HomeKitBridge {
  info(): HomeKitInfo;
  qr(): string | null;
  stop(): Promise<void>;
}

const {
  Accessory,
  AccessoryInfo,
  Bridge,
  Categories,
  Characteristic: C,
  HAPStorage,
  HapStatusError,
  HAPStatus,
  Service,
  uuid,
} = hap;

export function speedCommand(
  percent: unknown,
  state: Pick<FanState, 'wind'> = { wind: false },
): FanCommand {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100)
    throw new Error('Invalid fan speed.');
  if (percent === 0) return { fanOn: false };
  return state.wind
    ? { fanOn: true, windSpeed: Math.max(1, Math.round((percent * 3) / 100)) as BreezeStrength }
    : { fanOn: true, fanSpeed: Math.max(1, Math.round((percent * 6) / 100)) as FanSpeed };
}

export function speedPercent(state: Pick<FanState, 'wind' | 'windSpeed' | 'fanSpeed'>): number {
  // Active reports power separately. Keep the selected speed visible while off
  // so Home can restore it instead of replacing a reported zero with 100%.
  return Math.round(state.wind ? ((state.windSpeed ?? 0) * 100) / 3 : (state.fanSpeed * 100) / 6);
}

export function brightnessCommand(percent: unknown): FanCommand {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100)
    throw new Error('Invalid brightness.');
  return percent === 0
    ? { lightOn: false }
    : { lightOn: true, lightBrightness: Math.max(1, Math.round(percent)) };
}

export async function loadIdentity(directory: string): Promise<HomeKitIdentity> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, 'bridge.json');
  let saved;
  try {
    saved = await readFile(file, 'utf8');
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
  if (saved !== undefined) {
    let identity: unknown;
    try {
      identity = JSON.parse(saved);
    } catch {
      throw new Error(
        'The saved Apple Home identity is unreadable. Its pairing data was left unchanged.',
      );
    }
    if (
      !isRecord(identity) ||
      typeof identity.username !== 'string' ||
      typeof identity.pincode !== 'string' ||
      typeof identity.setupID !== 'string' ||
      !/^([\dA-F]{2}:){5}[\dA-F]{2}$/i.test(identity.username) ||
      !/^\d{3}-\d{2}-\d{3}$/.test(identity.pincode) ||
      !/^[A-Z0-9]{4}$/.test(identity.setupID)
    ) {
      throw new Error(
        'The saved Apple Home identity is invalid. Its pairing data was left unchanged.',
      );
    }
    return { username: identity.username, pincode: identity.pincode, setupID: identity.setupID };
  }
  const bytes = randomBytes(6);
  bytes[0] = ((bytes[0] ?? 0) | 2) & 254;
  let digits;
  do {
    digits = String(randomInt(100000000)).padStart(8, '0');
  } while (/^(\d)\1{7}$/.test(digits) || ['12345678', '87654321'].includes(digits));
  const identity = {
    username: [...bytes]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join(':')
      .toUpperCase(),
    pincode: `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`,
    setupID: Array.from(
      { length: 4 },
      () => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[randomInt(36)],
    ).join(''),
  };
  await writeFile(file, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
  return identity;
}

// Kept separate from publication so tests exercise real HomeKit handlers without
// advertising a bridge or sending anything to a physical fan.
export function createAccessories(
  config: Pick<FanConfig, 'fanMac'>,
  fan: FanController,
  { logControl = () => {} }: { logControl?: (message: string) => void } = {},
) {
  const make = (name: string, suffix: string) => {
    const accessory = new Accessory(name, uuid.generate(`fan-control:${config.fanMac}:${suffix}`));
    const information =
      accessory.getService(Service.AccessoryInformation) ??
      accessory.addService(Service.AccessoryInformation);
    information
      .setCharacteristic(C.Manufacturer, 'Local Fan Control')
      .setCharacteristic(C.Model, 'Modern Forms local bridge')
      .setCharacteristic(C.SerialNumber, `${config.fanMac.replaceAll(':', '')}-${suffix}`)
      .setCharacteristic(C.FirmwareRevision, '2.0.0');
    accessory.on('identify', (_paired, callback) => callback());
    return accessory;
  };
  const motor = make('Ceiling Fan', 'fan');
  const light = make('Ceiling Light', 'light');
  const fanService = motor.addService(Service.Fanv2, 'Ceiling Fan');
  const lightService = light.addService(Service.Lightbulb, 'Ceiling Light');
  const fields: CharacteristicBinding[] = [
    {
      characteristic: fanService.getCharacteristic(C.Active),
      label: 'Ceiling Fan Active',
      read: (state) => (state.fanOn ? C.Active.ACTIVE : C.Active.INACTIVE),
      command: (value) => ({ fanOn: value === C.Active.ACTIVE }),
    },
    {
      characteristic: fanService.getCharacteristic(C.RotationSpeed),
      label: 'Ceiling Fan Rotation Speed',
      read: speedPercent,
      command: speedCommand,
    },
    {
      characteristic: lightService.getCharacteristic(C.On),
      label: 'Ceiling Light On',
      read: (state) => state.lightOn,
      command: (value) => ({ lightOn: Boolean(value) }),
    },
    {
      characteristic: lightService.getCharacteristic(C.Brightness),
      label: 'Ceiling Light Brightness',
      // Home remembers brightness separately from power, including while off.
      read: (state) => state.lightBrightness,
      command: brightnessCommand,
    },
  ];
  const update = (snapshot: FanSnapshot) => {
    for (const { characteristic, read } of fields) {
      characteristic.updateValue(
        snapshot.online
          ? read(snapshot.state)
          : new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
      );
    }
  };
  for (const { characteristic, label, read, command } of fields) {
    characteristic
      .onGet(async () => {
        try {
          return read((await fan.read()).state);
        } catch {
          throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      })
      .onSet(async (value) => {
        logControl(`${label}: requested ${value}`);
        try {
          const result = await fan.write((state) => command(value, state));
          update(result);
          logControl(`${label}: confirmed ${read(result.state)}`);
        } catch {
          update(fan.snapshot());
          logControl(`${label}: change failed`);
          throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });
  }
  return { accessories: [motor, light], fanService, lightService, update };
}

export async function startHomeKit(
  config: FanConfig,
  fan: FanController,
  directory: string,
): Promise<HomeKitBridge> {
  const identity = await loadIdentity(directory);
  const persist = resolve(directory, 'persist');
  await mkdir(persist, { recursive: true, mode: 0o700 });
  HAPStorage.setCustomStoragePath(persist);
  const bridge = new Bridge(
    'Fan Control',
    uuid.generate(`fan-control:bridge:${identity.username}`),
  );
  const information =
    bridge.getService(Service.AccessoryInformation) ??
    bridge.addService(Service.AccessoryInformation);
  information
    .setCharacteristic(C.Manufacturer, 'Local Fan Control')
    .setCharacteristic(C.Model, 'Fan Control for Mac')
    .setCharacteristic(C.SerialNumber, identity.username.replaceAll(':', ''));
  bridge.on('identify', (_paired, callback) => callback());
  const { accessories, update } = createAccessories(config, fan, {
    logControl: (message) => console.log(`${new Date().toISOString()} Apple Home ${message}`),
  });
  bridge.addBridgedAccessories(accessories);
  let paired = Boolean(AccessoryInfo.load(identity.username)?.paired());
  let advertised = false;
  let listening = false;
  bridge.on('paired', () => {
    paired = true;
    console.log('Apple Home paired.');
  });
  bridge.on('unpaired', () => {
    paired = false;
    console.log('Apple Home pairing removed.');
  });
  bridge.on('listening', () => {
    listening = true;
  });
  bridge.on('advertised', () => {
    advertised = true;
    console.log('Apple Home bridge discoverable.');
  });
  await bridge.publish({
    ...identity,
    port: config.homeKitPort ?? DEFAULT_HOMEKIT_PORT,
    category: Categories.BRIDGE,
  });
  const svg = await QRCode.toString(bridge.setupURI(), { type: 'svg', margin: 4, width: 240 });
  let reading = false;
  const poll = async () => {
    if (reading) return;
    reading = true;
    try {
      update(await fan.read());
    } catch {
      update(fan.snapshot());
    } finally {
      reading = false;
    }
  };
  const timer = setInterval(poll, 5000);
  void poll();
  return {
    info: () => ({
      enabled: true,
      paired,
      ready: listening && advertised,
      name: 'Fan Control',
      accessories: ['Ceiling Fan', 'Ceiling Light'],
      ...(!paired ? { pincode: identity.pincode } : {}),
    }),
    qr: () => (paired ? null : svg),
    stop: async () => {
      clearInterval(timer);
      await bridge.unpublish();
    },
  };
}

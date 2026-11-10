import hap from 'hap-nodejs';
import QRCode from 'qrcode';
import { randomBytes, randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const { Accessory, AccessoryInfo, Bridge, Categories, Characteristic: C, HAPStorage, HapStatusError, HAPStatus, Service, uuid } = hap;

export function speedCommand(percent, state = {}) {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('Invalid fan speed.');
  if (percent === 0) return { fanOn: false };
  return state.wind
    ? { fanOn: true, windSpeed: Math.max(1, Math.round(percent * 3 / 100)) }
    : { fanOn: true, fanSpeed: Math.max(1, Math.round(percent * 6 / 100)) };
}

export function speedPercent(state) {
  // Active reports power separately. Keep the selected speed visible while off
  // so Home can restore it instead of replacing a reported zero with 100%.
  return Math.round(state.wind ? state.windSpeed * 100 / 3 : state.fanSpeed * 100 / 6);
}

export function brightnessCommand(percent) {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('Invalid brightness.');
  return percent === 0 ? { lightOn: false } : { lightOn: true, lightBrightness: Math.max(1, Math.round(percent)) };
}

export async function loadIdentity(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, 'bridge.json');
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const bytes = randomBytes(6); bytes[0] = (bytes[0] | 2) & 254;
  let digits;
  do { digits = String(randomInt(100000000)).padStart(8, '0'); }
  while (/^(\d)\1{7}$/.test(digits) || ['12345678', '87654321'].includes(digits));
  const identity = {
    username: [...bytes].map(n => n.toString(16).padStart(2, '0')).join(':').toUpperCase(),
    pincode: `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`,
    setupID: Array.from({ length: 4 }, () => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[randomInt(36)]).join(''),
  };
  await writeFile(file, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
  return identity;
}

// Kept separate from publication so tests exercise real HomeKit handlers without
// advertising a bridge or sending anything to a physical fan.
export function createAccessories(config, fan, { logControl = () => {} } = {}) {
  const make = (name, suffix) => {
    const accessory = new Accessory(name, uuid.generate(`fan-control:${config.fanMac}:${suffix}`));
    accessory.getService(Service.AccessoryInformation)
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
  const fields = [
    [fanService, C.Active, state => state.fanOn ? C.Active.ACTIVE : C.Active.INACTIVE, value => ({ fanOn: value === C.Active.ACTIVE })],
    [fanService, C.RotationSpeed, speedPercent, speedCommand],
    [lightService, C.On, state => state.lightOn, value => ({ lightOn: Boolean(value) })],
    // Home stores brightness separately from power. Reporting zero while off
    // discards the remembered level from Home's view of the accessory.
    [lightService, C.Brightness, state => state.lightBrightness, brightnessCommand],
  ];
  const update = snapshot => {
    for (const [service, characteristic, get] of fields) {
      service.getCharacteristic(characteristic).updateValue(snapshot?.online
        ? get(snapshot.state) : new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    }
  };
  for (const [service, characteristic, get, command] of fields) {
    service.getCharacteristic(characteristic)
      .onGet(async () => {
        try { return get((await fan.read()).state); }
        catch { throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE); }
      })
      .onSet(async value => {
        const label = `${service.displayName} ${service.getCharacteristic(characteristic).displayName}`;
        logControl(`${label}: requested ${value}`);
        try {
          const result = await fan.write(state => command(value, state));
          update(result);
          logControl(`${label}: confirmed ${get(result.state)}`);
        } catch {
          update(fan.snapshot());
          logControl(`${label}: change failed`);
          throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });
  }
  return { accessories: [motor, light], fanService, lightService, update };
}

export async function startHomeKit(config, fan, directory) {
  const identity = await loadIdentity(directory);
  const persist = resolve(directory, 'persist');
  await mkdir(persist, { recursive: true, mode: 0o700 });
  HAPStorage.setCustomStoragePath(persist);
  const bridge = new Bridge('Fan Control', uuid.generate(`fan-control:bridge:${identity.username}`));
  bridge.getService(Service.AccessoryInformation)
    .setCharacteristic(C.Manufacturer, 'Local Fan Control')
    .setCharacteristic(C.Model, 'Fan Control for Mac')
    .setCharacteristic(C.SerialNumber, identity.username.replaceAll(':', ''));
  bridge.on('identify', (_paired, callback) => callback());
  const { accessories, update } = createAccessories(config, fan, {
    logControl: message => console.log(`${new Date().toISOString()} Apple Home ${message}`),
  });
  bridge.addBridgedAccessories(accessories);
  let paired = Boolean(AccessoryInfo.load(identity.username)?.paired());
  let advertised = false;
  let listening = false;
  bridge.on('paired', () => { paired = true; console.log('Apple Home paired.'); });
  bridge.on('unpaired', () => { paired = false; console.log('Apple Home pairing removed.'); });
  bridge.on('listening', () => { listening = true; });
  bridge.on('advertised', () => { advertised = true; console.log('Apple Home bridge discoverable.'); });
  await bridge.publish({ ...identity, port: config.homeKitPort ?? 51826, category: Categories.BRIDGE });
  const svg = await QRCode.toString(bridge.setupURI(), { type: 'svg', margin: 4, width: 240 });
  let reading = false;
  const poll = async () => {
    if (reading) return;
    reading = true;
    try { update(await fan.read()); } catch { update(fan.snapshot()); }
    finally { reading = false; }
  };
  const timer = setInterval(poll, 5000);
  void poll();
  return {
    info: () => ({ enabled: true, paired, ready: listening && advertised, name: 'Fan Control', accessories: ['Ceiling Fan', 'Ceiling Light'], ...(!paired ? { pincode: identity.pincode } : {}) }),
    qr: () => paired ? null : svg,
    stop: async () => { clearInterval(timer); await bridge.unpublish(); },
  };
}

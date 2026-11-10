import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import hap from 'hap-nodejs';
import { brightnessCommand, speedCommand, speedPercent, createAccessories, loadIdentity } from '../lib/homekit.mjs';

const C = hap.Characteristic;

test('Home speeds map to six physical steps, with zero only switching power off', () => {
  assert.deepEqual(speedCommand(0), { fanOn: false });
  for (const [percent, speed] of [[1, 1], [17, 1], [33, 2], [50, 3], [67, 4], [83, 5], [100, 6]]) {
    assert.deepEqual(speedCommand(percent), { fanOn: true, fanSpeed: speed });
  }
  for (const value of [-1, 101, NaN, '50', null]) assert.throws(() => speedCommand(value));
});

test('Home speed respects Breeze and reports its actual strength', () => {
  for (const [percent, strength] of [[1, 1], [33, 1], [50, 2], [67, 2], [100, 3]]) {
    assert.deepEqual(speedCommand(percent, { wind: true }), { fanOn: true, windSpeed: strength });
    assert.equal(speedPercent({ fanOn: true, wind: true, windSpeed: strength, fanSpeed: 6 }), Math.round(strength * 100 / 3));
  }
  assert.deepEqual(speedCommand(0, { wind: true, windSpeed: 2 }), { fanOn: false });
  assert.equal(speedPercent({ fanOn: false, wind: true, windSpeed: 2 }), 67);
});

for (const wind of [false, true]) {
  test(`Home remembers ${wind ? 'Breeze strength' : 'steady speed'} across power cycles and bridge restarts`, async () => {
    let state = { fanOn: true, fanSpeed: 3, wind, windSpeed: 1, lightOn: false, lightBrightness: 70 };
    const expectedPercent = wind ? 33 : 50;
    const commands = [];
    const fan = {
      snapshot: () => ({ online: true, state }),
      async read() { return this.snapshot(); },
      async write(command) {
        if (typeof command === 'function') command = command(state);
        commands.push(command);
        state = { ...state, ...command };
        return this.snapshot();
      },
    };
    const config = { fanMac: '00:00:00:00:00:02' };
    let bridge = createAccessories(config, fan);
    const speed = () => bridge.fanService.getCharacteristic(C.RotationSpeed);
    const power = () => bridge.fanService.getCharacteristic(C.Active);
    bridge.update(fan.snapshot());
    await power().handleSetRequest(C.Active.INACTIVE);
    assert.deepEqual(commands.at(-1), { fanOn: false });
    assert.equal(speed().value, expectedPercent, 'power-off notification keeps the selected speed');
    assert.equal(await speed().handleGetRequest(), expectedPercent, 'Home can read the setting while off');

    bridge = createAccessories(config, fan);
    bridge.update(fan.snapshot());
    assert.equal(await power().handleGetRequest(), C.Active.INACTIVE);
    assert.equal(await speed().handleGetRequest(), expectedPercent, 'restart preserves the device setting');
    // Home sends both RotationSpeed and Active when switching this fan on.
    await speed().handleSetRequest(await speed().handleGetRequest());
    await power().handleSetRequest(C.Active.ACTIVE);
    assert.deepEqual(state, { fanOn: true, fanSpeed: 3, wind, windSpeed: 1, lightOn: false, lightBrightness: 70 });

    await speed().handleSetRequest(0);
    bridge.update(fan.snapshot());
    assert.equal(await power().handleGetRequest(), C.Active.INACTIVE);
    assert.equal(speed().value, expectedPercent, 'slider-off also retains the setting on refresh');
    await speed().handleSetRequest(100);
    assert.equal(state.fanOn, true);
    assert.equal(state[wind ? 'windSpeed' : 'fanSpeed'], wind ? 3 : 6, 'an explicit maximum-speed choice still works');
  });
}

test('Home dimming preserves the remembered brightness when switched off', () => {
  assert.deepEqual(brightnessCommand(0), { lightOn: false });
  assert.deepEqual(brightnessCommand(66), { lightOn: true, lightBrightness: 66 });
  for (const value of [-1, 101, NaN, '66']) assert.throws(() => brightnessCommand(value));
});

test('real HomeKit characteristic handlers control only the requested simulated state', async () => {
  let state = { fanOn: true, fanSpeed: 6, wind: false, windSpeed: 2, lightOn: true, lightBrightness: 66 };
  const commands = [];
  let fail = false;
  const fan = {
    snapshot: () => ({ online: !fail, state }),
    async read() { if (fail) throw new Error('offline'); return this.snapshot(); },
    async write(command) { if (fail) throw new Error('offline'); if (typeof command === 'function') command = command(state); commands.push(command); state = { ...state, ...command }; return this.snapshot(); },
  };
  const { fanService, lightService } = createAccessories({ fanMac: '00:00:00:00:00:01' }, fan);
  await fanService.getCharacteristic(C.RotationSpeed).handleSetRequest(50);
  assert.deepEqual(commands.at(-1), { fanOn: true, fanSpeed: 3 });
  assert.equal(await fanService.getCharacteristic(C.RotationSpeed).handleGetRequest(), 50);
  await lightService.getCharacteristic(C.Brightness).handleSetRequest(0);
  assert.equal(state.lightOn, false);
  assert.equal(state.lightBrightness, 66);
  assert.equal(await lightService.getCharacteristic(C.Brightness).handleGetRequest(), 66);
  await lightService.getCharacteristic(C.On).handleSetRequest(true);
  assert.equal(await lightService.getCharacteristic(C.Brightness).handleGetRequest(), 66);
  await lightService.getCharacteristic(C.Brightness).handleSetRequest(70);
  await lightService.getCharacteristic(C.On).handleSetRequest(false);
  assert.equal(await lightService.getCharacteristic(C.Brightness).handleGetRequest(), 70);
  await lightService.getCharacteristic(C.On).handleSetRequest(true);
  assert.equal(await lightService.getCharacteristic(C.Brightness).handleGetRequest(), 70);
  assert.equal(state.fanSpeed, 3);
  state.wind = true;
  await fanService.getCharacteristic(C.Active).handleSetRequest(C.Active.INACTIVE);
  await fanService.getCharacteristic(C.Active).handleSetRequest(C.Active.ACTIVE);
  assert.equal(state.wind, true);
  assert.equal(state.windSpeed, 2);
  await fanService.getCharacteristic(C.RotationSpeed).handleSetRequest(33);
  assert.equal(state.wind, true);
  assert.equal(state.windSpeed, 1);
  assert.equal(state.fanSpeed, 3);
  assert.equal(await fanService.getCharacteristic(C.RotationSpeed).handleGetRequest(), 33);
  fail = true;
  await assert.rejects(fanService.getCharacteristic(C.Active).handleGetRequest());
  await assert.rejects(lightService.getCharacteristic(C.On).handleSetRequest(false));
});

test('HomeKit identity and pairing code survive restarts in a private file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fan-homekit-'));
  try {
    const first = await loadIdentity(directory);
    assert.deepEqual(await loadIdentity(directory), first);
    assert.match(first.username, /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
    assert.match(first.pincode, /^\d{3}-\d{2}-\d{3}$/);
    assert.match(first.setupID, /^[A-Z0-9]{4}$/);
    assert.equal((await stat(join(directory, 'bridge.json'))).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateConfig } from '../build/lib/config.js';
import { isLocalAddress, validHost } from '../build/lib/network.js';

const example = JSON.parse(
  await readFile(new URL('../config.example.json', import.meta.url), 'utf8'),
);

test('the example configuration is valid without personal device details', () => {
  assert.deepEqual(validateConfig(example), example);
});

test('configuration errors identify the field that needs attention', () => {
  for (const value of [null, [], 'fan']) assert.throws(() => validateConfig(value), /object/);
  for (const [field, value, message] of [
    ['name', '', /name/],
    ['name', 42, /name/],
    ['fanHost', '192.168.1.999', /local IPv4/],
    ['fanHost', '8.8.8.8', /local IPv4/],
    ['fanHost', '192.168.001.1', /local IPv4/],
    ['fanHost', 'localhost', /local IPv4/],
    ['fanMac', 'invalid', /MAC/],
    ['port', '8787', /port/],
    ['timeoutMs', 0, /timeoutMs/],
    ['homeKitPort', 80, /Apple Home port/],
  ]) {
    assert.throws(() => validateConfig({ ...example, [field]: value }), message);
  }
});

test('app and HomeKit ports cannot collide, including the default HomeKit port', () => {
  assert.throws(() => validateConfig({ ...example, homeKitPort: example.port }), /different/);
  assert.throws(() => validateConfig({ ...example, port: 51826 }), /different/);
  assert.equal(validateConfig({ ...example, port: 51826, homeKitPort: 51827 }).homeKitPort, 51827);
});

test('local address checks validate full IPs rather than just a prefix', () => {
  for (const address of ['fd00::1', 'fc00::2', 'fe80::1', 'febf::1', '::ffff:10.1.2.3']) {
    assert.equal(isLocalAddress(address), true, address);
  }
  for (const address of [
    'fdomain.example',
    '192.168.1.999',
    '10.example.com',
    'febad',
    'fec0::1',
    '2001:4860:4860::8888',
    null,
  ]) {
    assert.equal(isLocalAddress(address), false, String(address));
  }
});

test('Host checks accept local authorities and reject URL components and outside hosts', () => {
  for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787']) {
    assert.equal(validHost(host), true);
  }
  for (const host of [
    'attacker.example',
    'attacker.example@localhost',
    'localhost/api/state',
    'localhost?x=1',
    undefined,
  ]) {
    assert.equal(validHost(host), false);
  }
});

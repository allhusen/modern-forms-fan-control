import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Fan, validateCommand } from '../lib/fan.mjs';
import { createApp, isLocalAddress } from '../server.mjs';

const config = { name: 'Test fan', fanHost: '127.0.0.1', fanMac: '02:00:00:00:00:01', port: 8787, timeoutMs: 1000 };
const initial = () => ({ clientId: 'MF_020000000001', fanOn: false, lightOn: true, lightBrightness: 66, fanSpeed: 3, fanDirection: 'forward', wind: false, windSpeed: 2 });
function fixture(options = {}) {
  let state = initial();
  const calls = [];
  const fan = new Fan({ ...config, fetchImpl: async (url, request) => {
    const body = JSON.parse(request.body);
    calls.push(body);
    if (options.fail?.()) throw new Error('No route to host');
    if (!body.queryDynamicShadowData && !options.ignoreWrites) state = { ...state, ...body };
    return new Response(JSON.stringify(options.reply ? options.reply(body, state) : state), { status: 200 });
  } });
  return { fan, calls };
}

test('validates only requested controls and rejects resets, timers, invalid types and speeds', () => {
  for (const value of [{ lightOn: true }, { fanOn: false }, { fanSpeed: 1 }, { fanSpeed: 6 }, { fanDirection: 'reverse' }]) assert.equal(validateCommand(value), value);
  for (const value of [null, [], {}, { factoryReset: true }, { fanSpeed: 0 }, { fanSpeed: 7 }, { fanSpeed: 1.5 }, { fanOn: 'true' }, { fanDirection: 'clockwise' }]) assert.throws(() => validateCommand(value));
});

test('deduplicates concurrent status requests and caches briefly', async () => {
  const { fan, calls } = fixture();
  const states = await Promise.all([fan.read(), fan.read(), fan.read()]);
  assert.equal(calls.length, 1);
  assert.equal(states[0].online, true);
  await fan.read();
  assert.equal(calls.length, 1);
  await fan.read({ fresh: true });
  assert.equal(calls.length, 2);
});

test('checks identity before issuing physical commands', async () => {
  const { fan, calls } = fixture({ reply: () => ({ ...initial(), clientId: 'MF_000000000000' }) });
  await assert.rejects(fan.write({ lightOn: false }), /identity does not match/);
  assert.deepEqual(calls, [{ queryDynamicShadowData: 1 }]);
});

test('serializes commands and changes only selected controls', async () => {
  const { fan, calls } = fixture();
  await Promise.all([fan.write({ fanSpeed: 2 }), fan.write({ fanDirection: 'reverse' }), fan.write({ fanOn: true })]);
  assert.deepEqual(calls.filter(body => !body.queryDynamicShadowData), [{ fanSpeed: 2 }, { fanDirection: 'reverse' }, { fanOn: true }]);
  assert.deepEqual(fan.state, { fanOn: true, lightOn: true, lightBrightness: 66, fanSpeed: 2, fanDirection: 'reverse', wind: false, windSpeed: 2 });
});

test('reads back firmware acknowledgements instead of assuming success', async () => {
  const { fan, calls } = fixture({ reply: (body, state) => body.queryDynamicShadowData ? state : { success: true } });
  await fan.write({ lightOn: false });
  assert.equal(fan.state.lightOn, false);
  assert.equal(calls.length, 3);
});

test('state-dependent Home writes use the settings from earlier queued commands', async () => {
  const { fan, calls } = fixture();
  await Promise.all([
    fan.write({ wind: true, windSpeed: 2 }),
    fan.write(state => state.wind ? { fanOn: true, windSpeed: 1 } : { fanOn: true, fanSpeed: 2 }),
  ]);
  assert.equal(fan.state.wind, true);
  assert.equal(fan.state.windSpeed, 1);
  assert.equal(fan.state.fanSpeed, 3);
  assert.deepEqual(calls.filter(body => !body.queryDynamicShadowData).at(-1), { fanOn: true, windSpeed: 1 });
  const before = calls.length;
  await assert.rejects(fan.write(() => ({ factoryReset: true })), /Unsupported/);
  assert.equal(calls.length, before + 1, 'invalid resolved commands must only read status');
});

test('reports ignored commands without falsely displaying the requested state', async () => {
  const { fan, calls } = fixture({ ignoreWrites: true });
  await assert.rejects(fan.write({ fanOn: true }), error => error.status === 409);
  assert.equal(fan.state.fanOn, false);
  assert.equal(fan.snapshot().online, true);
  assert.equal(calls.filter(body => body.fanOn).length, 1, 'writes must never be retried automatically');
});

test('retains last known status on network failure and recovers', async () => {
  let fail = false;
  const { fan } = fixture({ fail: () => fail });
  await fan.read();
  fail = true;
  await assert.rejects(fan.read({ fresh: true }), /Cannot reach/);
  assert.equal(fan.snapshot().online, false);
  assert.equal(fan.state.lightOn, true);
  fail = false;
  assert.equal((await fan.read({ fresh: true })).online, true);
});

test('rejects malformed device status', async () => {
  const { fan } = fixture({ reply: () => ({ ...initial(), fanOn: 'false' }) });
  await assert.rejects(fan.read(), /missing the expected/);
  assert.equal(fan.state, null);
});

test('dimming and Breeze strength round trip without changing unrelated settings', async () => {
  const { fan } = fixture();
  await fan.write({ lightBrightness: 42, lightOn: true });
  await fan.write({ wind: true, windSpeed: 1, fanOn: true });
  assert.equal(fan.state.lightBrightness, 42);
  assert.equal(fan.state.wind, true);
  assert.equal(fan.state.windSpeed, 1);
  assert.equal(fan.state.fanDirection, 'forward');
  await fan.write({ wind: false });
  assert.equal(fan.state.fanOn, true);
  assert.equal(fan.state.fanSpeed, 3);
  for (const value of [{ lightBrightness: 0 }, { lightBrightness: 101 }, { lightBrightness: '50' }, { wind: 1 }, { windSpeed: 0 }, { windSpeed: 4 }]) assert.throws(() => validateCommand(value));
});

test('Breeze controls do not write to a fan that lacks support', async () => {
  const { fan, calls } = fixture({ reply: () => ({ ...initial(), wind: undefined, windSpeed: undefined }) });
  await assert.rejects(fan.write({ wind: true }), /does not report support/);
  assert.deepEqual(calls, [{ queryDynamicShadowData: 1 }]);
});

test('HTTP API talks to a local fake fan and rejects unsafe HTTP requests', async t => {
  let state = initial();
  const commands = [];
  const device = http.createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/mf');
    let text = ''; for await (const part of req) text += part;
    const body = JSON.parse(text); commands.push(body);
    if (!body.queryDynamicShadowData) state = { ...state, ...body };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state));
  });
  device.listen(0, '127.0.0.1'); await once(device, 'listening');
  t.after(() => { device.closeAllConnections(); device.close(); });
  const fan = new Fan({ ...config, fanHost: `127.0.0.1:${device.address().port}` });
  const app = createApp(config, fan);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => { app.closeAllConnections(); app.close(); });
  const url = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await (await fetch(`${url}/api/state`)).json()).online, true);
  const headers = { 'Content-Type': 'application/json', 'X-Fan-Control': '1' };
  const write = (body, extra = {}) => fetch(`${url}/api/control`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const response = await write({ lightOn: false });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state.lightOn, false);
  const before = commands.length;
  assert.equal((await write({ factoryReset: true })).status, 400);
  assert.equal((await write({ fanOn: true }, { Origin: 'http://malicious.example' })).status, 403);
  // Node's fetch rewrites Host; use a raw HTTP client to exercise rebinding protection.
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = http.request(`${url}/api/control`, { method: 'POST', headers: { ...headers, Host: 'malicious.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(JSON.stringify({ fanOn: true }));
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await write({ fanOn: true }, { 'X-Fan-Control': '' })).status, 400);
  assert.equal((await write({ fanOn: true }, { 'Content-Type': 'text/plain' })).status, 400);
  assert.equal((await fetch(`${url}/api/control?fanOn=true`)).status, 404);
  assert.equal(commands.length, before, 'rejected requests must not reach the device');
});

test('LAN address policy excludes public Internet addresses', () => {
  for (const ip of ['127.0.0.1', '192.168.1.100', '10.0.0.1', '172.16.0.5', '172.31.255.1', '::ffff:192.168.88.94', '::1']) assert.equal(isLocalAddress(ip), true);
  for (const ip of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '1.1.1.1']) assert.equal(isLocalAddress(ip), false);
});

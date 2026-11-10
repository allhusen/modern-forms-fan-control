import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Scheduler } from '../build/lib/scheduler.js';
import { wallTime, occurrence, nextOccurrence, MINUTE } from '../build/lib/schedule-time.js';
import { validateSchedule, validateScheduleSettings } from '../build/lib/schedule-validation.js';
import { createApp } from '../build/server.js';

const settings = { timeZone: 'UTC', location: null };
const schedule = (patch = {}) => ({
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Evening lights',
  enabled: true,
  days: [0, 1, 2, 3, 4, 5, 6],
  trigger: { kind: 'time', time: '18:00' },
  command: { lightOn: true, lightBrightness: 70 },
  offAfterMinutes: null,
  ...patch,
});

async function fixture(t, start = '2026-11-09T17:59:00Z') {
  const directory = await mkdtemp(join(tmpdir(), 'fan-scheduler-test-'));
  const path = join(directory, 'schedules.json');
  let now = Date.parse(start);
  const calls = [];
  let fail = false;
  const fan = {
    write: async (command) => {
      calls.push(command);
      if (fail) throw new Error('Unconfirmed write');
    },
    snapshot: () => ({ online: true, state: null }),
  };
  const scheduler = await Scheduler.open(path, fan, () => now);
  await scheduler.configure(settings, 0);
  t.after(async () => {
    await scheduler.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    scheduler,
    path,
    fan,
    calls,
    now: () => now,
    at: (time) => {
      now = Date.parse(time);
    },
    fail: () => {
      fail = true;
    },
  };
}

test('schedule validation rejects unsafe commands, empty days, missing sunset location, and invalid durations', () => {
  assert.equal(validateSchedule(schedule(), settings).command.lightBrightness, 70);
  for (const patch of [
    { days: [] },
    { days: [1, 1] },
    { days: [7] },
    { name: ' ' },
    { enabled: 'yes' },
    { command: { factoryReset: true } },
    { command: {} },
    { command: { lightBrightness: 101 } },
    { offAfterMinutes: 0 },
    { offAfterMinutes: 1441 },
    { command: { lightOn: false }, offAfterMinutes: 60 },
    { trigger: { kind: 'time', time: '24:00' } },
    { trigger: { kind: 'sunset', offsetMinutes: 0 } },
  ])
    assert.throws(() => validateSchedule(schedule(patch), settings));
  for (const value of [
    { timeZone: 'not/a/zone', location: null },
    { ...settings, location: { latitude: 91, longitude: 0 } },
    { ...settings, location: { latitude: 0, longitude: Infinity } },
  ])
    assert.throws(() => validateScheduleSettings(value));
});

test('wall-clock scheduling skips DST gaps, picks the first repeated time, and handles fractional offsets', () => {
  assert.equal(wallTime('2026-03-08', '02:30', 'America/New_York'), null);
  assert.equal(
    new Date(wallTime('2026-11-01', '01:30', 'America/New_York')).toISOString(),
    '2026-11-01T05:30:00.000Z',
  );
  assert.equal(
    new Date(wallTime('2026-11-09', '08:15', 'Asia/Kathmandu')).toISOString(),
    '2026-11-09T02:30:00.000Z',
  );
  const weekdays = schedule({ days: [1, 2, 3, 4, 5] });
  assert.equal(
    new Date(nextOccurrence(weekdays, settings, Date.parse('2026-11-06T19:00:00Z'))).toISOString(),
    '2026-11-09T18:00:00.000Z',
  );
});

test('sunset follows the location and date, supports offsets, and has no event in polar summer', () => {
  const london = { timeZone: 'Europe/London', location: { latitude: 51.5, longitude: -0.1 } };
  const sunset = schedule({ trigger: { kind: 'sunset', offsetMinutes: 0 } });
  const at = occurrence(sunset, london, '2026-06-21');
  assert.ok(at > Date.parse('2026-06-21T20:15:00Z') && at < Date.parse('2026-06-21T20:30:00Z'));
  assert.equal(
    occurrence(
      { ...sunset, trigger: { kind: 'sunset', offsetMinutes: -30 } },
      london,
      '2026-06-21',
    ),
    at - 30 * MINUTE,
  );
  assert.equal(
    occurrence(
      sunset,
      { timeZone: 'Europe/Oslo', location: { latitude: 69.65, longitude: 18.96 } },
      '2026-06-21',
    ),
    null,
  );
});

test('a scheduled light command is confirmed once, survives restart, and does not change the fan', async (t) => {
  const f = await fixture(t);
  await f.scheduler.save(schedule(), 1);
  assert.deepEqual(f.calls, []);
  f.at('2026-11-09T18:00:05Z');
  await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
  assert.deepEqual(f.calls, [{ lightOn: true, lightBrightness: 70 }]);
  assert.equal(f.scheduler.snapshot().runs[0].status, 'completed');
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  const reopened = await Scheduler.open(f.path, f.fan, f.now);
  await reopened.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(reopened.snapshot().schedules[0].nextRun, '2026-11-10T18:00:00.000Z');
});

test('off-after crosses midnight, survives restart, and switches off only devices turned on by the schedule', async (t) => {
  const f = await fixture(t, '2026-11-09T22:59:00Z');
  await f.scheduler.save(
    schedule({ trigger: { kind: 'time', time: '23:00' }, offAfterMinutes: 180 }),
    1,
  );
  f.at('2026-11-09T23:00:05Z');
  await f.scheduler.tick();
  assert.equal(f.scheduler.snapshot().pendingOff[0].at, '2026-11-10T02:00:00.000Z');
  await f.scheduler.stop();
  f.at('2026-11-10T01:59:00Z');
  const reopened = await Scheduler.open(f.path, f.fan, f.now);
  f.at('2026-11-10T02:00:10Z');
  await reopened.tick();
  assert.deepEqual(f.calls, [{ lightOn: true, lightBrightness: 70 }, { lightOn: false }]);
  assert.equal(reopened.snapshot().pendingOff.length, 0);
  assert.equal(reopened.snapshot().runs[0].phase, 'off');
});

test('pausing or deleting a schedule cancels its pending off timer', async (t) => {
  const f = await fixture(t);
  await f.scheduler.save(schedule({ offAfterMinutes: 60 }), 1);
  f.at('2026-11-09T18:00:01Z');
  await f.scheduler.tick();
  assert.equal(f.scheduler.snapshot().pendingOff.length, 1);
  await f.scheduler.save(schedule({ enabled: false, offAfterMinutes: 60 }), 2);
  f.at('2026-11-09T19:00:01Z');
  await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.scheduler.snapshot().pendingOff.length, 0);
  await f.scheduler.remove(schedule().id, 3);
  assert.equal(f.scheduler.snapshot().schedules.length, 0);
});

test('sleeping through a trigger records a missed action without replay; restart never replays earlier start times', async (t) => {
  const f = await fixture(t);
  await f.scheduler.save(schedule(), 1);
  f.at('2026-11-09T20:00:00Z');
  await f.scheduler.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.scheduler.snapshot().runs[0].status, 'missed');
  f.at('2026-11-10T20:00:00Z');
  const reopened = await Scheduler.open(f.path, f.fan, f.now);
  await reopened.tick();
  assert.equal(f.calls.length, 0);
});

test('missed off timers are cleared without sending a late command', async (t) => {
  const f = await fixture(t);
  await f.scheduler.save(schedule({ offAfterMinutes: 60 }), 1);
  f.at('2026-11-09T18:00:00Z');
  await f.scheduler.tick();
  f.at('2026-11-09T21:00:00Z');
  await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.scheduler.snapshot().pendingOff.length, 0);
  assert.equal(f.scheduler.snapshot().runs[0].status, 'missed');
});

test('device failures are recorded without retrying or arming an off timer', async (t) => {
  const f = await fixture(t);
  await f.scheduler.save(schedule({ command: { fanOn: true }, offAfterMinutes: 60 }), 1);
  f.fail();
  f.at('2026-11-09T18:00:05Z');
  await f.scheduler.tick();
  await f.scheduler.tick();
  assert.deepEqual(f.calls, [{ fanOn: true }], 'default fan schedule preserves Breeze and speed');
  assert.equal(f.scheduler.snapshot().runs[0].status, 'failed');
  assert.equal(f.scheduler.snapshot().pendingOff.length, 0);
});

test('an action claimed before a crash is not replayed and its uncertain result is reported', async (t) => {
  const f = await fixture(t);
  await f.scheduler.save(schedule(), 1);
  const stored = JSON.parse(await readFile(f.path, 'utf8'));
  stored.lastOccurrence[schedule().id] = '2026-11-09';
  stored.runs.push({
    scheduleId: schedule().id,
    name: 'Evening lights',
    at: '2026-11-09T18:00:00Z',
    phase: 'start',
    status: 'running',
    message: null,
  });
  await writeFile(f.path, JSON.stringify(stored));
  f.at('2026-11-09T18:00:10Z');
  const reopened = await Scheduler.open(f.path, f.fan, f.now);
  await reopened.tick();
  assert.equal(f.calls.length, 0);
  assert.match(reopened.snapshot().runs[0].message, /will not be retried/);
});

test('saving after a trigger does not run it immediately; an edited future time can still run today', async (t) => {
  const f = await fixture(t);
  f.at('2026-11-09T18:00:05Z');
  await f.scheduler.save(schedule(), 1);
  await f.scheduler.tick();
  assert.equal(f.calls.length, 0);
  await f.scheduler.save(schedule({ trigger: { kind: 'time', time: '19:00' } }), 2);
  f.at('2026-11-09T19:00:01Z');
  await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
});

test('stale concurrent edits cannot overwrite another window and snapshots cannot mutate stored state', async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    f.scheduler.save(schedule(), 1),
    f.scheduler.save(schedule({ name: 'Other window' }), 1),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.status, 409);
  const snapshot = f.scheduler.snapshot();
  snapshot.schedules[0].command.lightBrightness = 1;
  assert.equal(f.scheduler.snapshot().schedules[0].command.lightBrightness, 70);
});

test('corrupt schedule files are preserved and prevent edits or physical commands', async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, '{ damaged file');
  const reopened = await Scheduler.open(f.path, f.fan, f.now);
  assert.match(reopened.snapshot().error, /preserved/);
  await assert.rejects(reopened.save(schedule(), 0), /preserved/);
  await reopened.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(f.path, 'utf8'), '{ damaged file');
});

test('a persistence failure prevents the physical action and pauses scheduling', async (t) => {
  const f = await fixture(t);
  await f.scheduler.save(schedule(), 1);
  await rm(f.path);
  await mkdir(f.path);
  f.at('2026-11-09T18:00:01Z');
  await assert.rejects(f.scheduler.tick(), /could not be saved/);
  assert.equal(f.calls.length, 0);
  assert.match(f.scheduler.snapshot().error, /paused/);
});

test('schedule API supports CRUD and assets while enforcing the same request boundary as device controls', async (t) => {
  const f = await fixture(t);
  const app = createApp(
    {
      name: 'Test fan',
      fanHost: '127.0.0.1',
      fanMac: '02:00:00:00:00:01',
      port: 8787,
      timeoutMs: 1000,
    },
    f.fan,
    { scheduler: f.scheduler },
  );
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => {
    app.closeAllConnections();
    app.close();
  });
  const url = `http://127.0.0.1:${app.address().port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Fan-Control': '1' };
  const post = (body, extra = {}) =>
    fetch(`${url}/api/schedules`, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  for (const path of ['/', '/schedules.js', '/schedules.css', '/api/schedules'])
    assert.equal((await fetch(url + path)).status, 200);
  assert.equal(
    (await post({ schedule: schedule(), revision: 1 }, { 'X-Fan-Control': '' })).status,
    400,
  );
  assert.equal(
    (await post({ schedule: schedule(), revision: 1 }, { Origin: 'http://outside.example' }))
      .status,
    403,
  );
  const saved = await post({ schedule: schedule(), revision: 1 });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).schedules.length, 1);
  assert.equal((await post({ schedule: schedule(), revision: 1 })).status, 409);
  const removed = await fetch(`${url}/api/schedules/${schedule().id}`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ revision: 2 }),
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).schedules.length, 0);
  assert.equal(f.calls.length, 0, 'editing schedules must never change the physical fan');
});

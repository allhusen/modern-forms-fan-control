// Read-only investigation aid. The four-byte layout is inferred, not an API contract.
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../build/lib/config.js';
import { Fan } from '../build/lib/fan.js';

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--snapshot')) {
    throw new Error('Usage: node scripts/inspect-schedule.mjs [--snapshot path.json]');
  }
  const config = await loadConfig();
  let data;
  if (args.length) {
    data = JSON.parse(await readFile(args[1], 'utf8'));
  } else {
    const fan = new Fan(config);
    data = await fan.inspect();
  }
  const expectedMac = config.fanMac.replaceAll(':', '').toUpperCase();
  if (data?.clientId?.split('_').at(-1)?.toUpperCase() !== expectedMac) {
    throw new Error('Snapshot/device identity does not match the configured fan.');
  }
  if (typeof data.schedule !== 'string')
    throw new Error('The fan did not report a schedule string.');
  const bytes = Buffer.from(data.schedule, 'base64');
  if (bytes.toString('base64') !== data.schedule)
    throw new Error('Schedule is not canonical base64; interpretation stopped.');
  if (bytes.length % 4 !== 0)
    throw new Error(
      'Schedule does not fit the candidate four-byte layout; interpretation stopped.',
    );
  const records = [];
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const minute = bytes.readUInt16LE(offset);
    if (minute >= 7 * 24 * 60)
      throw new Error('Time value is outside the candidate weekly range; interpretation stopped.');
    const minuteOfDay = minute % 1440;
    records.push({
      offset,
      hex: bytes.subarray(offset, offset + 4).toString('hex'),
      candidateDayIndex: Math.floor(minute / 1440),
      candidateTime: `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`,
      byte2: bytes[offset + 2],
      byte3: bytes[offset + 3],
    });
  }
  console.log(
    JSON.stringify(
      {
        source: args.length ? args[1] : config.fanHost,
        capturedAt: args.length ? (data.capturedAt ?? null) : new Date().toISOString(),
        clientId: data.clientId,
        timezone: data.timezone ?? null,
        adaptiveLearning: data.adaptiveLearning ?? null,
        schedule: data.schedule,
        byteLength: bytes.length,
        interpretation:
          'Candidate layout only: uint16 little-endian minute of week, byte2 unknown (possibly motor), byte3 light level. Day-zero weekday and motor/no-change semantics are unverified. Validate any interpretation against the manufacturer app; this tool never writes a schedule.',
        records,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

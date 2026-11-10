import { FanError, validateCommand } from './fan.js';
import { isIntegerBetween, isRecord } from './validation.js';
import type { Schedule, ScheduleSettings } from './schedule-types.js';

export function validateScheduleSettings(input: unknown): ScheduleSettings {
  if (!isRecord(input) || typeof input.timeZone !== 'string') {
    throw new FanError('Choose a time zone for your schedules.', 400);
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format();
  } catch {
    throw new FanError('Choose a valid time zone, such as America/New_York.', 400);
  }
  let location: ScheduleSettings['location'] = null;
  if (input.location !== null) {
    const value = input.location;
    if (
      !isRecord(value) ||
      typeof value.latitude !== 'number' ||
      !Number.isFinite(value.latitude) ||
      Math.abs(value.latitude) > 90 ||
      typeof value.longitude !== 'number' ||
      !Number.isFinite(value.longitude) ||
      Math.abs(value.longitude) > 180
    )
      throw new FanError('Enter a valid latitude and longitude for sunset.', 400);
    location = { latitude: value.latitude, longitude: value.longitude };
  }
  return { timeZone: input.timeZone, location };
}

export function validateSchedule(input: unknown, settings: ScheduleSettings): Schedule {
  if (!isRecord(input)) throw new FanError('Enter a schedule.', 400);
  if (typeof input.id !== 'string' || !/^[a-f\d-]{36}$/i.test(input.id)) {
    throw new FanError('Invalid schedule identifier.', 400);
  }
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 60) {
    throw new FanError('Give the schedule a name of up to 60 characters.', 400);
  }
  if (typeof input.enabled !== 'boolean') throw new FanError('Invalid enabled setting.', 400);
  if (
    !Array.isArray(input.days) ||
    input.days.length < 1 ||
    input.days.length > 7 ||
    !input.days.every((day) => isIntegerBetween(day, 0, 6)) ||
    new Set(input.days).size !== input.days.length
  ) {
    throw new FanError('Choose at least one day of the week.', 400);
  }
  const trigger = input.trigger;
  if (!isRecord(trigger)) throw new FanError('Choose a start time.', 400);
  let when: Schedule['trigger'];
  if (
    trigger.kind === 'time' &&
    typeof trigger.time === 'string' &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time)
  ) {
    when = { kind: 'time', time: trigger.time };
  } else if (trigger.kind === 'sunset' && isIntegerBetween(trigger.offsetMinutes, -120, 120)) {
    if (!settings.location)
      throw new FanError('Set your location before saving a sunset schedule.', 400);
    when = { kind: 'sunset', offsetMinutes: trigger.offsetMinutes };
  } else throw new FanError('Choose a valid time or sunset offset (up to 120 minutes).', 400);
  const command = { ...validateCommand(input.command) };
  if (
    input.offAfterMinutes !== null &&
    (!isIntegerBetween(input.offAfterMinutes, 1, 1440) ||
      (command.fanOn !== true && command.lightOn !== true))
  ) {
    throw new FanError(
      'Turn off after requires an On action and a duration of 1–1440 minutes.',
      400,
    );
  }
  return {
    id: input.id,
    name: input.name.trim(),
    enabled: input.enabled,
    days: [...input.days].sort((a, b) => a - b),
    trigger: when,
    command,
    offAfterMinutes: input.offAfterMinutes,
  };
}

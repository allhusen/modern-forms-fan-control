import { getTimes } from 'suncalc';
import type { Schedule, ScheduleSettings } from './schedule-types.js';

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(instant: number, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    if (formatters.size > 50) formatters.clear();
    formatters.set(timeZone, formatter);
  }
  const result: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(instant))) result[part.type] = part.value;
  return result;
}

export function localDate(instant: number, timeZone: string): string {
  const p = parts(instant, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

function offsetAt(instant: number, timeZone: string) {
  const p = parts(instant, timeZone);
  return (
    Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) -
    Math.floor(instant / MINUTE) * MINUTE
  );
}

/** Resolve a wall time. Skip nonexistent DST times; use the first repeated time only. */
export function wallTime(date: string, time: string, timeZone: string): number | null {
  const wall = Date.parse(`${date}T${time}:00Z`);
  const offsets = new Set([-DAY, 0, DAY].map((delta) => offsetAt(wall + delta, timeZone)));
  const candidates = [...offsets]
    .map((offset) => wall - offset)
    .filter((instant) => {
      const p = parts(instant, timeZone);
      return `${p.year}-${p.month}-${p.day}` === date && `${p.hour}:${p.minute}` === time;
    });
  return candidates.length ? Math.min(...candidates) : null;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

export function occurrence(
  schedule: Schedule,
  settings: ScheduleSettings,
  date: string,
): number | null {
  if (!schedule.days.includes(new Date(`${date}T12:00:00Z`).getUTCDay())) return null;
  if (schedule.trigger.kind === 'time')
    return wallTime(date, schedule.trigger.time, settings.timeZone);
  const location = settings.location;
  const noon = wallTime(date, '12:00', settings.timeZone);
  if (!location || noon === null) return null;
  const sunset = getTimes(
    new Date(noon),
    location.latitude,
    location.longitude,
    0,
    offsetAt(noon, settings.timeZone) / MINUTE,
  ).sunset;
  return sunset ? sunset.getTime() + schedule.trigger.offsetMinutes * MINUTE : null;
}

export function nextOccurrence(
  schedule: Schedule,
  settings: ScheduleSettings,
  after: number,
  lastDate?: string,
): number | null {
  const today = localDate(after, settings.timeZone);
  let next: number | null = null;
  // Yesterday accounts for sunset offsets crossing midnight. A week covers all selected days.
  for (let day = -1; day <= 8; day++) {
    const date = addDays(today, day);
    if (lastDate && date <= lastDate) continue;
    const at = occurrence(schedule, settings, date);
    if (at !== null && at > after && (next === null || at < next)) next = at;
  }
  return next;
}

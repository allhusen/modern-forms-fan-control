import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FanError, validateCommand } from './fan.js';
import { errorMessage, hasErrorCode, isIntegerBetween, isRecord } from './validation.js';
import { validateSchedule, validateScheduleSettings } from './schedule-validation.js';
import { addDays, localDate, MINUTE, nextOccurrence, occurrence } from './schedule-time.js';
import type { FanCommand, FanController } from './types.js';
import type {
  PendingOff,
  Schedule,
  ScheduleData,
  ScheduleRun,
  ScheduleSnapshot,
} from './schedule-types.js';

const HISTORY_LIMIT = 50;
const MAX_SCHEDULES = 30;
const MAX_LATE_MS = MINUTE;

function emptyData(): ScheduleData {
  return {
    version: 1,
    revision: 0,
    settings: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, location: null },
    schedules: [],
    lastOccurrence: {},
    pendingOff: [],
    runs: [],
  };
}

function validInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Persisted data is untrusted too; a damaged file is preserved and the scheduler stays stopped. */
function validateData(input: unknown): ScheduleData {
  if (
    !isRecord(input) ||
    input.version !== 1 ||
    !isIntegerBetween(input.revision, 0, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(input.schedules) ||
    input.schedules.length > MAX_SCHEDULES ||
    !isRecord(input.lastOccurrence) ||
    !Array.isArray(input.pendingOff) ||
    input.pendingOff.length > MAX_SCHEDULES ||
    !Array.isArray(input.runs) ||
    input.runs.length > HISTORY_LIMIT
  ) {
    throw new Error('Invalid schedule file.');
  }
  const settings = validateScheduleSettings(input.settings);
  const schedules = input.schedules.map((schedule) => validateSchedule(schedule, settings));
  const ids = new Set(schedules.map((schedule) => schedule.id));
  if (ids.size !== schedules.length) throw new Error('Duplicate schedule identifier.');
  const lastOccurrence: Record<string, string> = {};
  for (const [id, date] of Object.entries(input.lastOccurrence)) {
    if (
      !ids.has(id) ||
      typeof date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    )
      throw new Error('Invalid occurrence.');
    lastOccurrence[id] = date;
  }
  const pendingOff: PendingOff[] = input.pendingOff.map((value: unknown) => {
    if (
      !isRecord(value) ||
      typeof value.scheduleId !== 'string' ||
      !ids.has(value.scheduleId) ||
      !validInstant(value.at)
    )
      throw new Error('Invalid pending timer.');
    const command = validateCommand(value.command);
    if (
      !Object.entries(command).every(
        ([key, val]) => ['fanOn', 'lightOn'].includes(key) && val === false,
      )
    ) {
      throw new Error('Invalid off command.');
    }
    return { scheduleId: value.scheduleId, at: value.at, command: { ...command } };
  });
  const runs: ScheduleRun[] = input.runs.map((value: unknown) => {
    if (
      !isRecord(value) ||
      typeof value.scheduleId !== 'string' ||
      typeof value.name !== 'string' ||
      !validInstant(value.at) ||
      (value.phase !== 'start' && value.phase !== 'off') ||
      !['running', 'completed', 'failed', 'missed'].includes(String(value.status)) ||
      (value.message !== null && typeof value.message !== 'string')
    )
      throw new Error('Invalid run history.');
    return {
      scheduleId: value.scheduleId,
      name: value.name,
      at: value.at,
      phase: value.phase,
      status: value.status === 'running' ? 'failed' : (value.status as ScheduleRun['status']),
      message:
        value.status === 'running'
          ? 'App stopped before confirmation. This action will not be retried.'
          : value.message,
    };
  });
  return {
    version: 1,
    revision: input.revision,
    settings,
    schedules,
    lastOccurrence,
    pendingOff,
    runs,
  };
}

export class Scheduler {
  private data = emptyData();
  private error: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastCheck: number;
  private stopped = false;

  private constructor(
    private readonly path: string,
    private readonly fan: FanController,
    private readonly now: () => number,
  ) {
    this.lastCheck = now();
  }

  static async open(path: string, fan: FanController, now = Date.now): Promise<Scheduler> {
    const scheduler = new Scheduler(path, fan, now);
    try {
      if ((await stat(path)).size > 256 * 1024) throw new Error('Schedule file too large.');
      scheduler.data = validateData(JSON.parse(await readFile(path, 'utf8')) as unknown);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        scheduler.error =
          'Schedules could not be loaded. The saved file has been preserved; schedules are paused.';
      }
    }
    return scheduler;
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }

  private async persist(data: ScheduleData): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(data, null, 2) + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
      this.data = data;
    } catch {
      this.error =
        'Schedules are paused because their state could not be saved. Check disk access and reopen Fan Control.';
      throw new FanError(this.error, 503);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  snapshot(): ScheduleSnapshot {
    const now = this.now();
    return structuredClone({
      revision: this.data.revision,
      settings: this.data.settings,
      schedules: this.data.schedules.map((schedule) => {
        const next =
          schedule.enabled && !this.error
            ? nextOccurrence(
                schedule,
                this.data.settings,
                now,
                this.data.lastOccurrence[schedule.id],
              )
            : null;
        return { ...schedule, nextRun: next === null ? null : new Date(next).toISOString() };
      }),
      pendingOff: this.data.pendingOff,
      runs: this.data.runs,
      error: this.error,
    });
  }

  private checkRevision(revision: unknown): void {
    if (this.error) throw new FanError(this.error, 503);
    if (!Number.isSafeInteger(revision) || revision !== this.data.revision) {
      throw new FanError(
        'Schedules changed in another window. Close the editor and reopen it to use the latest version.',
        409,
      );
    }
  }

  /** Mark past occurrences when enabling/editing, so saving a schedule never runs it immediately. */
  private markPast(data: ScheduleData, schedule: Schedule): void {
    delete data.lastOccurrence[schedule.id];
    const now = this.now();
    const today = localDate(now, data.settings.timeZone);
    for (let day = -8; day <= 1; day++) {
      const date = addDays(today, day);
      const at = occurrence(schedule, data.settings, date);
      if (at !== null && at <= now) data.lastOccurrence[schedule.id] = date;
    }
  }

  save(input: unknown, revision: unknown): Promise<ScheduleSnapshot> {
    return this.serial(async () => {
      this.checkRevision(revision);
      const schedule = validateSchedule(input, this.data.settings);
      const data = structuredClone(this.data);
      const index = data.schedules.findIndex((item) => item.id === schedule.id);
      if (index < 0 && data.schedules.length >= MAX_SCHEDULES)
        throw new FanError('You can save up to 30 schedules.', 400);
      if (index < 0) data.schedules.push(schedule);
      else data.schedules[index] = schedule;
      data.pendingOff = data.pendingOff.filter((item) => item.scheduleId !== schedule.id);
      this.markPast(data, schedule);
      data.revision++;
      await this.persist(data);
      return this.snapshot();
    });
  }

  remove(id: string, revision: unknown): Promise<ScheduleSnapshot> {
    return this.serial(async () => {
      this.checkRevision(revision);
      if (!this.data.schedules.some((schedule) => schedule.id === id))
        throw new FanError('Schedule not found.', 404);
      const data = structuredClone(this.data);
      data.schedules = data.schedules.filter((schedule) => schedule.id !== id);
      data.pendingOff = data.pendingOff.filter((item) => item.scheduleId !== id);
      delete data.lastOccurrence[id];
      data.revision++;
      await this.persist(data);
      return this.snapshot();
    });
  }

  configure(input: unknown, revision: unknown): Promise<ScheduleSnapshot> {
    return this.serial(async () => {
      this.checkRevision(revision);
      const settings = validateScheduleSettings(input);
      for (const schedule of this.data.schedules) validateSchedule(schedule, settings);
      const data = structuredClone(this.data);
      data.settings = settings;
      // Pending off times are absolute instants and survive a location/time-zone change.
      for (const schedule of data.schedules) this.markPast(data, schedule);
      data.revision++;
      await this.persist(data);
      return this.snapshot();
    });
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 10_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.queue;
  }

  tick(): Promise<void> {
    return this.serial(async () => {
      if (this.error || this.stopped) return;
      const now = this.now();
      const after = this.lastCheck;
      this.lastCheck = now;
      const events: { schedule: Schedule; at: number; date: string | null; command: FanCommand }[] =
        [];
      for (const pending of this.data.pendingOff) {
        const schedule = this.data.schedules.find(
          (item) => item.id === pending.scheduleId && item.enabled,
        );
        if (schedule && Date.parse(pending.at) <= now) {
          events.push({
            schedule,
            at: Date.parse(pending.at),
            date: null,
            command: pending.command,
          });
        }
      }
      for (const schedule of this.data.schedules.filter((item) => item.enabled)) {
        const today = localDate(now, this.data.settings.timeZone);
        // A wake after a long sleep records recent missed actions without replaying a backlog.
        for (let day = -2; day <= 1; day++) {
          const date = addDays(today, day);
          if (date <= (this.data.lastOccurrence[schedule.id] ?? '')) continue;
          const at = occurrence(schedule, this.data.settings, date);
          if (at !== null && at > after && at <= now)
            events.push({ schedule, at, date, command: schedule.command });
        }
      }
      events.sort((a, b) => a.at - b.at || Number(a.date !== null) - Number(b.date !== null));
      for (const event of events) {
        if (this.stopped) break;
        const { schedule, at, date, command } = event;
        const data = structuredClone(this.data);
        if (date) data.lastOccurrence[schedule.id] = date;
        else
          data.pendingOff = data.pendingOff.filter(
            (item) => item.scheduleId !== schedule.id || Date.parse(item.at) !== at,
          );
        const missed = this.now() - at > MAX_LATE_MS;
        const run: ScheduleRun = {
          scheduleId: schedule.id,
          name: schedule.name,
          at: new Date(at).toISOString(),
          phase: date ? 'start' : 'off',
          status: missed ? 'missed' : 'running',
          message: missed
            ? 'Skipped: Fan Control was not ready within one minute of this time.'
            : null,
        };
        data.runs = [run, ...data.runs].slice(0, HISTORY_LIMIT);
        // Claim the occurrence on disk before issuing a physical command. Never retry on uncertainty.
        await this.persist(data);
        if (missed) continue;
        try {
          await this.fan.write(command);
          run.status = 'completed';
          if (date && schedule.offAfterMinutes) {
            const off: Record<string, boolean> = {};
            if (command.fanOn === true) off.fanOn = false;
            if (command.lightOn === true) off.lightOn = false;
            data.pendingOff = data.pendingOff.filter((item) => item.scheduleId !== schedule.id);
            data.pendingOff.push({
              scheduleId: schedule.id,
              at: new Date(at + schedule.offAfterMinutes * MINUTE).toISOString(),
              command: validateCommand(off),
            });
          }
        } catch (error) {
          run.status = 'failed';
          run.message = errorMessage(error);
        }
        await this.persist(data);
      }
    });
  }
}

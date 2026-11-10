import type { FanCommand } from './types.js';

export interface ScheduleSettings {
  timeZone: string;
  location: { latitude: number; longitude: number } | null;
}

export type ScheduleTrigger =
  { kind: 'time'; time: string } | { kind: 'sunset'; offsetMinutes: number };

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  /** Sunday = 0, Saturday = 6, in the schedule's time zone. */
  days: number[];
  trigger: ScheduleTrigger;
  command: FanCommand;
  offAfterMinutes: number | null;
}

export interface ScheduleRun {
  scheduleId: string;
  name: string;
  at: string;
  phase: 'start' | 'off';
  status: 'running' | 'completed' | 'failed' | 'missed';
  message: string | null;
}

export interface PendingOff {
  scheduleId: string;
  at: string;
  command: FanCommand;
}

export interface ScheduleData {
  version: 1;
  revision: number;
  settings: ScheduleSettings;
  schedules: Schedule[];
  /** Calendar-day watermark prevents replay after restarts or a clock moving backwards. */
  lastOccurrence: Record<string, string>;
  pendingOff: PendingOff[];
  runs: ScheduleRun[];
}

export interface ScheduleSnapshot {
  revision: number;
  settings: ScheduleSettings;
  schedules: (Schedule & { nextRun: string | null })[];
  pendingOff: PendingOff[];
  runs: ScheduleRun[];
  error: string | null;
}

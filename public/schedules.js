import { request } from './api.js';

const $ = (id) => document.getElementById(id);
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const strengths = ['Gentle', 'Medium', 'Strong'];
let data = null;
let editingId = null;
let editRevision;
let settingsRevision;
let mutating = false;
let generation = 0;
let timer;
let lastRendered = '';
let confirmDelete = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function errorAt(id, message = '') {
  $(id).textContent = message;
  $(id).hidden = !message;
}

function dateText(instant) {
  return new Date(instant).toLocaleString([], {
    timeZone: data.settings.timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function repeatText(selected) {
  if (selected.length === 7) return 'Every day';
  if (String(selected) === '1,2,3,4,5') return 'Weekdays';
  if (String(selected) === '0,6') return 'Weekends';
  return selected.map((day) => days[day].slice(0, 3)).join(', ');
}

function actionText(command) {
  const actions = [];
  if (command.lightOn === false) actions.push('Light off');
  else if (command.lightOn === true)
    actions.push(`Light ${command.lightBrightness ?? 'on'}${command.lightBrightness ? '%' : ''}`);
  if (command.fanOn === false) actions.push('Fan off');
  else if (command.fanOn === true) {
    if (command.wind === true) actions.push(`${strengths[(command.windSpeed ?? 1) - 1]} breeze`);
    else if (command.fanSpeed) actions.push(`Fan ${command.fanSpeed} / 6`);
    else actions.push('Fan on · current settings');
  }
  return actions.join(' · ');
}

function render() {
  if (!data) return;
  errorAt('schedules-error', data.error ?? '');
  $('schedule-add').disabled = mutating || Boolean(data.error);
  $('schedule-settings-open').disabled = mutating || Boolean(data.error);
  $('schedule-zone').textContent = data.settings.timeZone.split('/').at(-1).replaceAll('_', ' ');
  $('schedule-empty').hidden = data.schedules.length > 0 || Boolean(data.error);
  const rendered = JSON.stringify(data) + mutating;
  if (rendered === lastRendered) return;
  lastRendered = rendered;
  $('schedule-list').replaceChildren();
  for (const schedule of data.schedules) {
    const card = element('article', undefined, 'schedule-card');
    const top = element('div', undefined, 'schedule-card-top');
    const edit = element('button', undefined, 'schedule-edit');
    edit.append(element('strong', schedule.name));
    const when =
      schedule.trigger.kind === 'time'
        ? schedule.trigger.time
        : `Sunset${schedule.trigger.offsetMinutes ? ` ${schedule.trigger.offsetMinutes > 0 ? '+' : '−'} ${Math.abs(schedule.trigger.offsetMinutes)} min` : ''}`;
    edit.append(element('span', `${when} · ${repeatText(schedule.days)}`));
    edit.setAttribute('aria-label', `Edit ${schedule.name}`);
    edit.disabled = mutating || Boolean(data.error);
    edit.addEventListener('click', () => openEditor(schedule));
    const toggle = element('button', undefined, 'schedule-toggle');
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(schedule.enabled));
    toggle.setAttribute('aria-label', `Enable ${schedule.name}`);
    toggle.disabled = mutating || Boolean(data.error);
    toggle.addEventListener('click', async () => {
      try {
        await mutate('/api/schedules', 'POST', {
          revision: data.revision,
          schedule: { ...schedule, enabled: !schedule.enabled },
        });
      } catch (error) {
        errorAt('schedules-error', error.message);
      }
    });
    top.append(edit, toggle);
    card.append(top, element('p', actionText(schedule.command), 'schedule-description'));
    if (schedule.offAfterMinutes)
      card.append(
        element(
          'p',
          `Then off after ${schedule.offAfterMinutes % 60 ? `${schedule.offAfterMinutes} min` : `${schedule.offAfterMinutes / 60} hr`}`,
          'schedule-description',
        ),
      );
    card.append(
      element(
        'p',
        !schedule.enabled
          ? 'Paused'
          : schedule.nextRun
            ? `Next · ${dateText(schedule.nextRun)}`
            : 'No occurrence in the next week',
        'schedule-next',
      ),
    );
    const pending = data.pendingOff.find((item) => item.scheduleId === schedule.id);
    if (pending) card.append(element('p', `Off timer · ${dateText(pending.at)}`, 'schedule-next'));
    $('schedule-list').append(card);
  }
  $('schedule-runs').replaceChildren();
  if (!data.runs.length)
    $('schedule-runs').append(element('p', 'No scheduled actions yet.', 'field-note'));
  for (const run of data.runs.slice(0, 8)) {
    const row = element('div', undefined, 'schedule-run');
    row.append(element('strong', `${run.name}${run.phase === 'off' ? ' · Off timer' : ''}`));
    row.append(
      element(
        'span',
        `${dateText(run.at)} · ${run.status === 'running' ? 'Confirming' : run.status}`,
      ),
    );
    if (run.message) row.append(element('p', run.message));
    $('schedule-runs').append(row);
  }
}

async function load() {
  if (mutating) return;
  const started = generation;
  try {
    const next = await request('/api/schedules');
    if (started !== generation || mutating) return;
    data = next;
    render();
  } catch (error) {
    if (started === generation) errorAt('schedules-error', error.message);
  }
}

async function mutate(path, method, body) {
  if (mutating) throw new Error('A save is already in progress.');
  mutating = true;
  generation++;
  render();
  for (const id of ['schedule-save', 'schedule-delete', 'schedule-settings-save'])
    $(id).disabled = true;
  try {
    data = await request(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Fan-Control': '1' },
      body: JSON.stringify(body),
    });
  } finally {
    mutating = false;
    for (const id of ['schedule-save', 'schedule-delete', 'schedule-settings-save'])
      $(id).disabled = false;
    render();
  }
}

function updateFields() {
  const sunset = $('schedule-trigger').value === 'sunset';
  $('schedule-time-field').hidden = sunset;
  $('schedule-time').disabled = sunset;
  $('schedule-offset-field').hidden = !sunset;
  $('schedule-offset').disabled = !sunset;
  $('schedule-sunset-hint').hidden = !sunset;
  $('schedule-location-link').textContent = data?.settings.location
    ? 'Location & time'
    : 'Set your location';
  $('schedule-brightness-field').hidden = $('schedule-light').value !== 'on';
  $('schedule-fan-options').hidden = $('schedule-fan').value !== 'on';
  const breeze = $('schedule-fan-mode').value === 'breeze';
  $('schedule-speed-field').hidden = $('schedule-fan-mode').value === 'keep';
  $('schedule-speed').max = breeze ? '3' : '6';
  $('schedule-speed-label').textContent = breeze ? 'Strength' : 'Speed';
  $('schedule-speed-value').textContent = breeze
    ? strengths[Number($('schedule-speed').value) - 1]
    : `${$('schedule-speed').value} / 6`;
  $('schedule-brightness-value').textContent = `${$('schedule-brightness').value}%`;
  for (const id of ['schedule-brightness', 'schedule-speed']) {
    $(id).style.setProperty(
      '--fill',
      `${((Number($(id).value) - 1) / (Number($(id).max) - 1)) * 100}%`,
    );
  }
  const canTurnOff = $('schedule-light').value === 'on' || $('schedule-fan').value === 'on';
  $('schedule-after').disabled = !canTurnOff;
  if (!canTurnOff) $('schedule-after').value = 'leave';
  const turnOff = canTurnOff && $('schedule-after').value === 'off';
  $('schedule-duration-field').hidden = !turnOff;
  $('schedule-duration').disabled = !turnOff;
  $('schedule-after-hint').hidden = !turnOff;
}

function openEditor(schedule = null) {
  if (!data || data.error || mutating) return;
  editingId = schedule?.id ?? null;
  editRevision = data.revision;
  confirmDelete = false;
  $('schedule-delete').textContent = 'Delete';
  $('schedule-delete').hidden = !schedule;
  $('schedule-edit-note').hidden = !data.pendingOff.some((item) => item.scheduleId === editingId);
  $('schedule-editor-title').textContent = schedule ? 'Edit schedule' : 'New schedule';
  $('schedule-form').reset();
  $('schedule-name').value = schedule?.name ?? '';
  $('schedule-trigger').value = schedule?.trigger.kind ?? 'time';
  $('schedule-time').value = schedule?.trigger.kind === 'time' ? schedule.trigger.time : '18:00';
  $('schedule-offset').value =
    schedule?.trigger.kind === 'sunset' ? schedule.trigger.offsetMinutes : 0;
  for (const input of $('schedule-days').querySelectorAll('input'))
    input.checked = schedule ? schedule.days.includes(Number(input.value)) : true;
  const command = schedule?.command ?? {};
  for (const device of ['light', 'fan'])
    $('schedule-' + device).value =
      command[device + 'On'] === true ? 'on' : command[device + 'On'] === false ? 'off' : 'keep';
  $('schedule-brightness').value = command.lightBrightness ?? 70;
  $('schedule-fan-mode').value =
    command.wind === true ? 'breeze' : command.fanSpeed ? 'steady' : 'keep';
  $('schedule-speed').max = command.wind === true ? '3' : '6';
  $('schedule-speed').value =
    command.wind === true ? (command.windSpeed ?? 1) : (command.fanSpeed ?? 3);
  $('schedule-after').value = schedule?.offAfterMinutes ? 'off' : 'leave';
  $('schedule-duration').value = schedule?.offAfterMinutes ? schedule.offAfterMinutes / 60 : 3;
  $('schedule-enabled').checked = schedule?.enabled ?? true;
  errorAt('schedule-form-error');
  updateFields();
  $('schedule-editor').showModal();
  $('schedule-name').focus();
}

function newId() {
  // getRandomValues also works on the LAN page where randomUUID may require HTTPS.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function draft() {
  const command = {};
  for (const device of ['light', 'fan']) {
    const value = $('schedule-' + device).value;
    if (value !== 'keep') command[device + 'On'] = value === 'on';
  }
  if (command.lightOn) command.lightBrightness = Number($('schedule-brightness').value);
  if (command.fanOn && $('schedule-fan-mode').value !== 'keep') {
    const breeze = $('schedule-fan-mode').value === 'breeze';
    command.wind = breeze;
    command[breeze ? 'windSpeed' : 'fanSpeed'] = Number($('schedule-speed').value);
  }
  return {
    id: editingId ?? newId(),
    name: $('schedule-name').value,
    enabled: $('schedule-enabled').checked,
    days: [...$('schedule-days').querySelectorAll('input:checked')].map((input) =>
      Number(input.value),
    ),
    trigger:
      $('schedule-trigger').value === 'time'
        ? { kind: 'time', time: $('schedule-time').value }
        : { kind: 'sunset', offsetMinutes: Number($('schedule-offset').value) },
    command,
    offAfterMinutes:
      $('schedule-after').value === 'off' ? Number($('schedule-duration').value) * 60 : null,
  };
}

function openSettings() {
  if (!data || data.error || mutating) return;
  settingsRevision = data.revision;
  $('schedule-latitude').value = data.settings.location?.latitude ?? '';
  $('schedule-longitude').value = data.settings.location?.longitude ?? '';
  $('schedule-time-zone').value = data.settings.timeZone;
  $('schedule-location-status').textContent = '';
  errorAt('schedule-settings-error');
  $('schedule-settings').showModal();
}

async function locate() {
  $('schedule-use-location').disabled = true;
  $('schedule-location-status').textContent = 'Finding your location…';
  try {
    let location;
    const native = window.webkit?.messageHandlers?.scheduleLocation;
    if (native) location = await native.postMessage({});
    else {
      if (!window.isSecureContext || !navigator.geolocation)
        throw new Error('Use location in the Mac app, or enter your town’s coordinates below.');
      const result = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 20000,
          maximumAge: 300000,
          enableHighAccuracy: false,
        }),
      );
      location = {
        latitude: result.coords.latitude,
        longitude: result.coords.longitude,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    }
    if (!$('schedule-settings').open) return;
    $('schedule-latitude').value = Number(location.latitude).toFixed(3);
    $('schedule-longitude').value = Number(location.longitude).toFixed(3);
    $('schedule-time-zone').value = location.timeZone;
    $('schedule-location-status').textContent =
      'Location found. Save settings to use it for sunset.';
  } catch (error) {
    $('schedule-location-status').textContent =
      error.message || 'Location unavailable. Enter your town’s coordinates below.';
  } finally {
    $('schedule-use-location').disabled = false;
  }
}

export function setupSchedules() {
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    const label = element('label');
    const input = element('input');
    input.type = 'checkbox';
    input.value = day;
    input.checked = true;
    input.setAttribute('aria-label', `Repeat on ${days[day]}`);
    label.append(input, element('span', days[day].slice(0, 1)));
    $('schedule-days').append(label);
  }
  for (const timeZone of Intl.supportedValuesOf?.('timeZone') ?? []) {
    const option = element('option');
    option.value = timeZone;
    $('schedule-time-zones').append(option);
  }
  for (const view of ['controls', 'schedules'])
    $(view + '-tab').addEventListener('click', () => {
      for (const target of ['controls', 'schedules']) {
        $(target + '-view').hidden = view !== target;
        if (view === target) $(target + '-tab').setAttribute('aria-current', 'page');
        else $(target + '-tab').removeAttribute('aria-current');
      }
      clearInterval(timer);
      if (view === 'schedules') {
        void load();
        timer = setInterval(() => {
          if (!document.hidden) void load();
        }, 15000);
      }
    });
  $('schedule-add').disabled = true;
  $('schedule-add').addEventListener('click', () => openEditor());
  for (const id of ['schedule-editor-close', 'schedule-cancel'])
    $(id).addEventListener('click', () => $('schedule-editor').close());
  for (const id of ['schedule-settings-close', 'schedule-settings-cancel'])
    $(id).addEventListener('click', () => $('schedule-settings').close());
  for (const id of ['schedule-settings-open', 'schedule-location-link'])
    $(id).addEventListener('click', openSettings);
  for (const id of [
    'schedule-trigger',
    'schedule-light',
    'schedule-fan',
    'schedule-fan-mode',
    'schedule-after',
  ])
    $(id).addEventListener('change', updateFields);
  for (const id of ['schedule-brightness', 'schedule-speed'])
    $(id).addEventListener('input', updateFields);
  $('schedule-use-location').addEventListener('click', locate);
  $('schedule-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    errorAt('schedule-form-error');
    try {
      await mutate('/api/schedules', 'POST', { revision: editRevision, schedule: draft() });
      $('schedule-editor').close();
    } catch (error) {
      errorAt('schedule-form-error', error.message);
    }
  });
  $('schedule-delete').addEventListener('click', async () => {
    if (!confirmDelete) {
      confirmDelete = true;
      $('schedule-delete').textContent = 'Confirm delete';
      return;
    }
    try {
      await mutate(`/api/schedules/${editingId}`, 'DELETE', { revision: editRevision });
      $('schedule-editor').close();
    } catch (error) {
      errorAt('schedule-form-error', error.message);
    }
  });
  $('schedule-settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    errorAt('schedule-settings-error');
    const latitude = $('schedule-latitude').value.trim();
    const longitude = $('schedule-longitude').value.trim();
    if (Boolean(latitude) !== Boolean(longitude)) {
      errorAt('schedule-settings-error', 'Enter both latitude and longitude, or leave both blank.');
      return;
    }
    try {
      const previousRevision = settingsRevision;
      await mutate('/api/schedule-settings', 'PUT', {
        revision: settingsRevision,
        settings: {
          timeZone: $('schedule-time-zone').value.trim(),
          location: latitude ? { latitude: Number(latitude), longitude: Number(longitude) } : null,
        },
      });
      if (editRevision === previousRevision) editRevision = data.revision;
      $('schedule-settings').close();
      errorAt('schedule-form-error');
      updateFields();
    } catch (error) {
      errorAt('schedule-settings-error', error.message);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('schedules-view').hidden) void load();
  });
}

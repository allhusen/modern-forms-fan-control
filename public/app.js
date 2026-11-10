const $ = id => document.getElementById(id);
let status = { online: false, state: null, updatedAt: null };
let busy = false;
let polling = false;
let timer;
let revision = 0;
let editing = null;
let homeTimer;
const strengths = ['Off', 'Gentle', 'Medium', 'Strong'];

function sliderDisplay(id, value, known = true) {
  const input = $(id);
  const brightness = id === 'light-brightness';
  const breeze = !brightness && status.state?.wind;
  const text = !known ? '—' : Number(value) === 0 ? 'Off' : brightness ? `${value}%` : breeze ? strengths[value] : `${value} / 6`;
  $(id + '-value').textContent = text;
  input.style.setProperty('--fill', `${Number(value) / Number(input.max) * 100}%`);
  input.setAttribute('aria-valuetext', !known ? 'Unknown' : Number(value) === 0 ? 'Off' : brightness ? `${value} percent` : breeze ? `${strengths[value]} breeze` : `Speed ${value} of 6`);
}

function render() {
  const state = status.state;
  const online = status.online;
  $('connection').className = `connection ${online ? 'online' : 'offline'}`;
  $('connection-label').textContent = online ? 'Connected locally' : 'Unavailable';
  for (const device of ['fan', 'light']) {
    const on = state?.[device + 'On'];
    $(device + '-power').setAttribute('aria-checked', String(Boolean(on)));
    $(device + '-power').disabled = busy || !online;
    $(device + '-power-label').textContent = state ? on ? 'On' : 'Off' : '—';
    const description = device === 'fan' ? on ? state.wind ? 'Breeze is flowing' : 'Running' : 'Stopped' : on ? 'Lighting the room' : 'Lights out';
    $(device + '-status').textContent = !state ? 'Status unknown' : `${description}${online ? '' : ' · last known'}`;
  }
  document.querySelector('.fan-section').classList.toggle('reverse', state?.fanDirection === 'reverse');
  document.querySelector('.fan-section').classList.toggle('offline', !online);
  for (const direction of ['forward', 'reverse']) {
    $('direction-' + direction).setAttribute('aria-pressed', String(state?.fanDirection === direction));
    $('direction-' + direction).disabled = busy || !online;
  }
  $('breeze').disabled = busy || !online || state?.wind == null || state?.windSpeed == null;
  $('breeze').setAttribute('aria-pressed', String(Boolean(state?.wind)));
  $('speed-label').textContent = state?.wind ? 'Strength' : 'Speed';
  $('fan-speed').max = state?.wind ? '3' : '6';
  $('speed-low-label').textContent = state?.wind ? 'Gentle' : 'Low';
  $('speed-high-label').textContent = state?.wind ? 'Strong' : 'High';
  for (const [id, value] of [['fan-speed', state?.fanOn ? state.wind ? state.windSpeed : state.fanSpeed : 0], ['light-brightness', state?.lightOn ? state.lightBrightness : 0]]) {
    $(id).disabled = busy || !online;
    if (editing !== id) { $(id).value = value; sliderDisplay(id, value, Boolean(state)); }
  }
  $('last-response').textContent = status.updatedAt ? new Date(status.updatedAt).toLocaleString() : 'Not yet connected';
  $('refresh').disabled = busy || polling;
  $('retry').disabled = busy || polling;
}

function notice(title, message) {
  $('notice').hidden = !message;
  $('notice-title').textContent = title;
  $('notice-text').textContent = message ?? '';
}

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(35000), cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'The controller could not complete this request.');
    error.data = data;
    throw error;
  }
  return data;
}

function schedule() {
  clearTimeout(timer);
  if (!document.hidden) timer = setTimeout(() => refresh(), status.online ? 10000 : 15000);
}

async function refresh(fresh = false) {
  if (busy || polling || editing) return;
  polling = true;
  const startedAt = revision;
  $('refresh').disabled = true;
  $('retry').disabled = true;
  try {
    const data = await request('/api/state' + (fresh ? '?fresh=1' : ''));
    if (startedAt === revision && !busy) { status = data; notice('', ''); }
  } catch (error) {
    if (startedAt === revision && !busy) {
      if (error.data) status = error.data;
      status.online = false;
      notice('Fan unavailable', error.message === 'Failed to fetch' ? 'Keep the Mac awake and connected to your home network. Reopen Fan Control.app if needed.' : error.message);
    }
  } finally { polling = false; render(); schedule(); }
}

async function control(command, message) {
  if (busy || !status.online) { render(); return; }
  busy = true;
  revision++;
  clearTimeout(timer);
  // Keep the selected slider value visible while the device confirms it.
  for (const element of document.querySelectorAll('.control-panel button, .control-panel input')) element.disabled = true;
  $('refresh').disabled = true;
  $('feedback').textContent = 'Updating…';
  try {
    status = await request('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fan-Control': '1' }, body: JSON.stringify(command) });
    notice('', '');
    $('feedback').textContent = message;
  } catch (error) {
    if (error.data) status = error.data;
    else status.online = false;
    notice('Change not confirmed', error.message);
    $('feedback').textContent = 'Showing the last reported settings.';
  } finally { busy = false; render(); schedule(); }
}

$('fan-power').addEventListener('click', () => {
  const on = !status.state.fanOn;
  control({ fanOn: on }, on ? 'Fan on.' : 'Fan off.');
});
$('light-power').addEventListener('click', () => {
  const on = !status.state.lightOn;
  control(on ? { lightOn: true, lightBrightness: status.state.lightBrightness } : { lightOn: false }, on ? 'Light on.' : 'Light off.');
});
$('breeze').addEventListener('click', () => {
  const on = !status.state.wind;
  control(on ? { wind: true, fanOn: true, windSpeed: status.state.windSpeed } : { wind: false }, on ? 'Breeze mode on.' : 'Steady speed selected.');
});

for (const id of ['fan-speed', 'light-brightness']) {
  const input = $(id);
  input.addEventListener('input', () => { editing = id; sliderDisplay(id, input.value); });
  input.addEventListener('change', () => {
    const value = Number(input.value);
    editing = null;
    if (id === 'fan-speed') {
      const command = !value ? { fanOn: false } : status.state.wind ? { fanOn: true, windSpeed: value } : { fanOn: true, fanSpeed: value };
      control(command, !value ? 'Fan off.' : status.state.wind ? `${strengths[value]} breeze.` : `Fan speed ${value}.`);
    } else control(value ? { lightOn: true, lightBrightness: value } : { lightOn: false }, value ? `Brightness ${value}%.` : 'Light off.');
  });
  input.addEventListener('blur', () => { if (editing === id) { editing = null; render(); schedule(); } });
  input.addEventListener('pointercancel', () => { editing = null; render(); schedule(); });
}
$('direction-forward').addEventListener('click', () => control({ fanDirection: 'forward' }, 'Summer direction.'));
$('direction-reverse').addEventListener('click', () => control({ fanDirection: 'reverse' }, 'Winter direction.'));
$('refresh').addEventListener('click', () => refresh(true));
$('retry').addEventListener('click', () => refresh(true));
$('help-open').addEventListener('click', () => { loadInfo(); $('help').showModal(); });
$('help-close').addEventListener('click', () => $('help').close());
$('help').addEventListener('click', event => {
  if (event.target === $('help')) { const box = $('help').getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('help').close(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(timer); editing = null; } else refresh(true); });
window.addEventListener('online', () => refresh(true));

async function loadHomeKit() {
  clearTimeout(homeTimer);
  if (!$('home-setup').open) return;
  try {
    const info = await request('/api/homekit');
    $('home-pairing').hidden = !info.enabled || info.paired || !info.ready;
    $('home-paired').hidden = !info.enabled || !info.paired;
    $('home-title').textContent = info.paired ? 'Connected to Apple Home.' : 'Add to Apple Home.';
    $('home-status').textContent = !info.enabled ? info.error : info.paired ? 'Your fan and light are paired with Home.' : info.ready ? 'Scan this code from your iPhone to add both controls.' : 'Starting Apple Home discovery…';
    if (info.enabled && !info.paired && info.ready) {
      $('home-code').textContent = info.pincode;
      if (!$('home-qr').getAttribute('src')) $('home-qr').src = '/api/homekit/qr';
    } else { $('home-qr').removeAttribute('src'); $('home-code').textContent = ''; }
  } catch (error) {
    $('home-pairing').hidden = true;
    $('home-paired').hidden = true;
    $('home-status').textContent = error.message;
  }
  if ($('home-setup').open) homeTimer = setTimeout(loadHomeKit, 3000);
}
$('home-open').addEventListener('click', () => { $('home-setup').showModal(); loadHomeKit(); });
$('home-close').addEventListener('click', () => $('home-setup').close());
$('home-setup').addEventListener('close', () => clearTimeout(homeTimer));

async function loadInfo() {
  try {
    const response = await fetch('/api/info');
    if (!response.ok) return;
    const info = await response.json();
    $('room-name').textContent = info.name;
    $('fan-address').textContent = info.fanHost;
    $('fan-mac').textContent = info.fanMac;
    $('phone-links').replaceChildren();
    for (const url of [...info.urls, info.hostnameUrl]) {
      const link = document.createElement('a'); link.href = url; link.textContent = url; $('phone-links').append(link);
    }
  } catch { /* The status request presents connection errors. */ }
}
loadInfo();
refresh();

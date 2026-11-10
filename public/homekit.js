import { request } from './api.js';

const $ = (id) => document.getElementById(id);

function pairingStatus(info) {
  if (!info.enabled) return info.error;
  if (info.paired) return 'Your fan and light are paired with Home.';
  if (info.ready) return 'Scan this code from your iPhone to add both controls.';
  return 'Starting Apple Home discovery…';
}

export function setupHomeKit() {
  let homeTimer;
  async function loadHomeKit() {
    clearTimeout(homeTimer);
    if (!$('home-setup').open) return;
    try {
      const info = await request('/api/homekit');
      $('home-pairing').hidden = !info.enabled || info.paired || !info.ready;
      $('home-paired').hidden = !info.enabled || !info.paired;
      $('home-status').textContent = pairingStatus(info);
      if (info.enabled && !info.paired && info.ready) {
        $('home-code').textContent = info.pincode;
        if (!$('home-qr').getAttribute('src')) $('home-qr').src = '/api/homekit/qr';
      } else {
        $('home-qr').removeAttribute('src');
        $('home-code').textContent = '';
      }
    } catch (error) {
      $('home-pairing').hidden = true;
      $('home-paired').hidden = true;
      $('home-status').textContent = error.message;
    }
    if ($('home-setup').open) homeTimer = setTimeout(loadHomeKit, 3000);
  }
  $('home-open').addEventListener('click', () => {
    $('home-setup').showModal();
    loadHomeKit();
  });
  $('home-close').addEventListener('click', () => $('home-setup').close());
  $('home-setup').addEventListener('close', () => clearTimeout(homeTimer));
}

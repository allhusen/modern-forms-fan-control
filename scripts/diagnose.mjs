import { loadConfig, localAddresses } from '../server.mjs';
import { Fan } from '../lib/fan.mjs';
const config = await loadConfig();
console.log('Mac addresses:', localAddresses().join(', '));
console.log('Fan:', config.fanHost, 'MAC:', config.fanMac);
try {
  const fan = new Fan(config);
  const state = await fan.read({ fresh: true });
  console.log('Verified fan identity. Current state:', JSON.stringify(state.state, null, 2));
} catch (error) {
  console.error(error.message);
  console.error('If the Mac is on the same Wi-Fi, check macOS Local Network permission for the app running this command, Wi-Fi client isolation, and fan power.');
  process.exitCode = 1;
}

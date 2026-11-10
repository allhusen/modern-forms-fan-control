// Compile-only contract checks. These calls are never executed or shipped.
import type { Fan } from '../src/lib/fan.js';
import type { FanCommand } from '../src/lib/types.js';
import { validateCommand } from '../src/lib/fan.js';

declare const fan: Fan;
declare const input: unknown;

fan.write({ fanOn: true, fanSpeed: 3 });
fan.write({ lightOn: true, lightBrightness: 70 });
fan.write((state) => (state.wind ? { fanOn: false } : { fanOn: true, fanSpeed: 2 }));
fan.write(validateCommand(input));

// @ts-expect-error Empty commands have no effect and are rejected.
fan.write({});
// @ts-expect-error Device power is boolean, not a string.
fan.write({ fanOn: 'true' });
// @ts-expect-error The fan has six speed steps.
fan.write({ fanSpeed: 7 });
// @ts-expect-error Breeze has three strength steps.
fan.write({ windSpeed: 4 });
// @ts-expect-error Unsupported device fields cannot be sent by typed callers.
fan.write({ factoryReset: true });
// @ts-expect-error A state-dependent command must return a supported command.
fan.write(() => ({ fanDirection: 'clockwise' }));
// @ts-expect-error Command factories must be synchronous.
fan.write(async () => ({ fanOn: true }));
// @ts-expect-error External JSON must pass runtime validation first.
fan.write(input);
// @ts-expect-error Callers cannot bypass identity checks through the transport method.
fan.request({ fanOn: true });
fan.write((state) => {
  // @ts-expect-error Observed device state is read-only to callers.
  state.fanSpeed = 6;
  return { fanOn: false };
});

// @ts-expect-error Observed status is not a control command.
const invalid: FanCommand = { online: true };
void invalid;

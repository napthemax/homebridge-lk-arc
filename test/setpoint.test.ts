import { describe, expect, it } from 'vitest';
import { SETPOINT_DEBOUNCE_MS } from '../src/settings';
import { SetpointDebouncer, type ScheduleFn } from '../src/roomAccessory';
import { captureLogger } from './helpers';

function manualScheduler(): { schedule: ScheduleFn; pending: Array<{ fn: () => Promise<void> | void; ms: number; cancelled: boolean }> } {
  const pending: Array<{ fn: () => Promise<void> | void; ms: number; cancelled: boolean }> = [];
  const schedule: ScheduleFn = (fn, ms) => {
    const item = { fn, ms, cancelled: false };
    pending.push(item);
    return {
      cancel() {
        item.cancelled = true;
      },
    };
  };
  return { schedule, pending };
}

describe('setpoint debouncer', () => {
  it('waits 1.5s and sends only the latest change', async () => {
    const sent: number[] = [];
    const { schedule, pending } = manualScheduler();
    const logger = captureLogger();
    const debouncer = new SetpointDebouncer(SETPOINT_DEBOUNCE_MS, async (tenths) => {
      sent.push(tenths);
    }, schedule, logger.log, 'Vardagsrum', 220);

    debouncer.push(21);
    debouncer.push(21.26);
    expect(sent).toEqual([]);
    expect(pending[0].cancelled).toBe(true);
    expect(pending[1].cancelled).toBe(false);
    expect(pending[1].ms).toBe(1500);
    await pending[1].fn();
    expect(sent).toEqual([215]);
  });

  it('does not post when the rounded value matches the last setpoint', async () => {
    const sent: number[] = [];
    const { schedule, pending } = manualScheduler();
    const logger = captureLogger();
    const debouncer = new SetpointDebouncer(SETPOINT_DEBOUNCE_MS, async (tenths) => {
      sent.push(tenths);
    }, schedule, logger.log, 'Vardagsrum', 220);

    debouncer.push(22);
    debouncer.push(21.99);
    await pending.at(-1)?.fn();
    expect(sent).toEqual([]);
    expect(logger.text()).toContain('unchanged');
  });

  it('clamps before sending and keeps the previous value when the post fails', async () => {
    const sent: number[] = [];
    const { schedule, pending } = manualScheduler();
    const logger = captureLogger();
    let fail = true;
    const debouncer = new SetpointDebouncer(SETPOINT_DEBOUNCE_MS, async (tenths) => {
      sent.push(tenths);
      if (fail) {
        throw new Error('cloud rejected');
      }
    }, schedule, logger.log, 'Vardagsrum', 220);

    debouncer.push(3);
    await pending.at(-1)?.fn();
    expect(sent).toEqual([50]);
    expect(logger.text()).toContain('failed');

    debouncer.push(5);
    await pending.at(-1)?.fn();
    expect(sent).toEqual([50, 50]);

    fail = false;
    debouncer.push(35);
    await pending.at(-1)?.fn();
    expect(sent).toEqual([50, 50, 300]);

    debouncer.push(30);
    await pending.at(-1)?.fn();
    expect(sent).toEqual([50, 50, 300]);
  });

  it('ignores a remote update while a slider change is waiting', async () => {
    const sent: number[] = [];
    const { schedule, pending } = manualScheduler();
    const debouncer = new SetpointDebouncer(SETPOINT_DEBOUNCE_MS, async (tenths) => {
      sent.push(tenths);
    }, schedule, captureLogger().log, 'Vardagsrum', 220);

    debouncer.push(21.5);
    debouncer.noteRemoteTenths(220);
    await pending.at(-1)?.fn();
    expect(sent).toEqual([215]);
  });
});

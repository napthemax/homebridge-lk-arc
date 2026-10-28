import { afterEach, describe, expect, it, vi } from 'vitest';
import * as hap from 'hap-nodejs';
import type { API, PlatformAccessory } from 'homebridge';
import { PlatformAccessory as HapAccessory } from 'homebridge/lib/platformAccessory';
import { LkArcPlatform } from '../src/platform';
import { LkClient } from '../src/lkClient';
import { LkRoomAccessory, type ScheduleFn } from '../src/roomAccessory';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings';
import type { HubStructure, LkApi, Realestate, SenseMeasurements } from '../src/types';
import {
  EMAIL,
  PASSWORD,
  captureLogger,
  fixture,
  instantSleep,
  jsonResponse,
  makeJwt,
  recordFetch,
} from './helpers';

const MAC_SENSE = 'AA:BB:CC:DD:EE:01';
const MAC_TUNE = 'AA:BB:CC:DD:EE:02';
const MAC_NULL = 'AA:BB:CC:DD:EE:03';
const MAC_GONE = 'AA:BB:CC:DD:EE:99';

function cloneStructure(): Realestate[] {
  const structure = fixture<Realestate[]>('user_structure.json');
  structure[0].realestateMachines?.push(
    {
      identity: 'CUBIC-1',
      deviceGroup: 'cubicsecure',
      deviceType: 'detector',
      deviceRole: 'detector',
      zone: { zoneName: 'Detector' },
    },
    {
      identity: MAC_NULL,
      deviceGroup: 'arc',
      deviceType: 'arc-sense',
      deviceRole: 'arc-sense',
      zone: { zoneName: 'Garage' },
    },
  );
  return structure;
}

function tuneMeasurement(): SenseMeasurements {
  return {
    mac: MAC_TUNE,
    currentTemperature: 230,
    desiredTemperature: 210,
    currentBattery: 15,
    connectionState: 'disconnected',
  };
}

function nullMeasurement(): SenseMeasurements {
  return {
    mac: MAC_NULL,
    currentTemperature: 180,
    desiredTemperature: null,
    connectionState: 'connected',
  };
}

function createApi() {
  const registered: PlatformAccessory[] = [];
  const unregistered: PlatformAccessory[] = [];
  const updated: PlatformAccessory[] = [];
  const listeners = new Map<string, Array<() => void>>();
  const api = {
    hap,
    platformAccessory: HapAccessory,
    registerPlatformAccessories: (plugin: string, platform: string, accessories: PlatformAccessory[]) => {
      expect(plugin).toBe(PLUGIN_NAME);
      expect(platform).toBe(PLATFORM_NAME);
      registered.push(...accessories);
    },
    unregisterPlatformAccessories: (_plugin: string, _platform: string, accessories: PlatformAccessory[]) => {
      unregistered.push(...accessories);
    },
    updatePlatformAccessories: (accessories: PlatformAccessory[]) => {
      updated.push(...accessories);
    },
    on: (event: string, cb: () => void) => {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
    },
    registered,
    unregistered,
    updated,
  };
  return api;
}

function manualSchedule(): { schedule: ScheduleFn; pending: Array<{ fn: () => Promise<void> | void; ms: number }> } {
  const pending: Array<{ fn: () => Promise<void> | void; ms: number }> = [];
  const schedule: ScheduleFn = (fn, ms) => {
    const item = { fn, ms };
    pending.push(item);
    return { cancel() {} };
  };
  return { schedule, pending };
}

function thermostat(accessory: PlatformAccessory) {
  const service = accessory.getService(hap.Service.Thermostat);
  if (!service) {
    throw new Error(`missing thermostat on ${accessory.displayName}`);
  }
  return service;
}

describe('platform', () => {
  const logger = captureLogger();
  const { schedule, pending } = manualSchedule();
  const api = createApi();
  const measured: string[] = [];

  const lk: LkApi = {
    async ensureUserId() {
      return fixture<{ userId: string }>('user.json').userId;
    },
    async getUserStructure() {
      return cloneStructure();
    },
    async getHubStructure() {
      return fixture<HubStructure>('hub_structure.json');
    },
    async getSenseMeasurement(mac: string) {
      measured.push(mac);
      if (mac === MAC_TUNE) return tuneMeasurement();
      if (mac === MAC_NULL) return nullMeasurement();
      throw new Error(`no measurement for ${mac}`);
    },
    async setTemperature() {
      throw new Error('not used');
    },
  };

  const platform = new LkArcPlatform(logger.log, {
    platform: PLATFORM_NAME,
    name: 'LK Arc',
    email: EMAIL,
    password: PASSWORD,
    pollIntervalMinutes: 5,
  }, api as unknown as API, { client: lk, schedule });

  const cached = new HapAccessory('Old room', hap.uuid.generate(MAC_GONE));
  cached.context.mac = MAC_GONE;
  cached.context.deviceRole = 'arc-sense';
  platform.configureAccessory(cached);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers arc-sense and arc-tune rooms and drops hub, cubic, null setpoint and stale cache', async () => {
    await platform.pollOnce();

    const names = api.registered.map((accessory) => accessory.displayName).sort();
    expect(names).toEqual(['Badrum', 'Vardagsrum']);
    expect(api.registered.map((accessory) => accessory.context.mac).sort()).toEqual([MAC_SENSE, MAC_TUNE]);
    expect(measured).toEqual([MAC_TUNE, MAC_NULL]);
    expect(api.unregistered.map((accessory) => accessory.context.mac)).toEqual([MAC_GONE]);
    expect(logger.text()).toContain('Discovered 2 room(s) on 1 hub(s)');
    expect(logger.text()).toContain('Vardagsrum');
    expect(logger.text()).toContain('Badrum');
    expect(logger.text()).not.toContain('Hall');
    expect(logger.text()).not.toContain('Garage');
    expect(logger.text()).not.toContain('Detector');

    const living = api.registered.find((accessory) => accessory.displayName === 'Vardagsrum');
    const bath = api.registered.find((accessory) => accessory.displayName === 'Badrum');
    if (!living || !bath) {
      throw new Error('rooms were not registered');
    }

    const livingService = thermostat(living);
    const { Characteristic } = hap;
    expect(livingService.getCharacteristic(Characteristic.CurrentTemperature).value).toBeCloseTo(21.4, 5);
    expect(livingService.getCharacteristic(Characteristic.TargetTemperature).value).toBeCloseTo(22, 5);
    expect(livingService.getCharacteristic(Characteristic.TargetTemperature).props).toMatchObject({
      minValue: 5,
      maxValue: 30,
      minStep: 0.5,
    });
    expect(livingService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value)
      .toBe(Characteristic.CurrentHeatingCoolingState.HEAT);
    expect(livingService.getCharacteristic(Characteristic.TargetHeatingCoolingState).props.validValues)
      .toEqual([Characteristic.TargetHeatingCoolingState.HEAT]);
    expect(livingService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value)
      .toBe(Characteristic.TemperatureDisplayUnits.CELSIUS);
    expect(livingService.getCharacteristic(Characteristic.CurrentRelativeHumidity).value).toBeCloseTo(41.2, 5);
    expect(livingService.getCharacteristic(Characteristic.StatusFault).value)
      .toBe(Characteristic.StatusFault.NO_FAULT);

    const info = living.getService(hap.Service.AccessoryInformation);
    expect(info?.getCharacteristic(Characteristic.Manufacturer).value).toBe('LK Systems');
    expect(info?.getCharacteristic(Characteristic.Model).value).toBe('arc-sense');
    expect(info?.getCharacteristic(Characteristic.SerialNumber).value).toBe(MAC_SENSE);
    expect(living.getService(hap.Service.Battery)?.getCharacteristic(Characteristic.BatteryLevel).value).toBe(87);

    const bathService = thermostat(bath);
    expect(bathService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value)
      .toBe(Characteristic.CurrentHeatingCoolingState.OFF);
    expect(infoModel(bath)).toBe('arc-tune');
    expect(bath.getService(hap.Service.Battery)?.getCharacteristic(Characteristic.StatusLowBattery).value)
      .toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
    expect(bathService.getCharacteristic(Characteristic.StatusFault).value)
      .toBe(Characteristic.StatusFault.GENERAL_FAULT);

    expect(living.UUID).toBe(hap.uuid.generate(MAC_SENSE));
    expect(pending.some((item) => item.ms === 5 * 60 * 1000)).toBe(false);
  });

  it('keeps last values when the next poll throws', async () => {
    const living = api.registered.find((accessory) => accessory.displayName === 'Vardagsrum');
    if (!living) {
      throw new Error('living room missing');
    }
    const before = thermostat(living).getCharacteristic(hap.Characteristic.CurrentTemperature).value;
    const removedBefore = api.unregistered.length;

    lk.getUserStructure = async () => {
      throw new Error('network down');
    };
    await platform.pollLoopOnce();

    expect(thermostat(living).getCharacteristic(hap.Characteristic.CurrentTemperature).value).toBe(before);
    expect(api.unregistered).toHaveLength(removedBefore);
    expect(logger.text()).toContain('Keeping last known values');
    expect(pending.at(-1)?.ms).toBe(10 * 60 * 1000);
  });

  it('keeps last values when every room read fails and does not hammer the next poll', async () => {
    const calls = { hub: 0, sense: 0 };
    const localLog = captureLogger();
    const localSchedule = manualSchedule();
    const localApi = createApi();
    let failReads = false;
    const client: LkApi = {
      async ensureUserId() {
        return 'user-1';
      },
      async getUserStructure() {
        return fixture<Realestate[]>('user_structure.json');
      },
      async getHubStructure() {
        calls.hub += 1;
        if (failReads) {
          throw new Error('hub down');
        }
        return fixture<HubStructure>('hub_structure.json');
      },
      async getSenseMeasurement(mac: string) {
        calls.sense += 1;
        if (failReads) {
          throw new Error('sense down');
        }
        if (mac === MAC_TUNE) return tuneMeasurement();
        throw new Error(`unexpected ${mac}`);
      },
      async setTemperature() {},
    };
    const local = new LkArcPlatform(localLog.log, {
      platform: PLATFORM_NAME,
      email: EMAIL,
      password: PASSWORD,
    }, localApi as unknown as API, { client, schedule: localSchedule.schedule });

    await local.pollLoopOnce();
    const living = localApi.registered.find((accessory) => accessory.context.mac === MAC_SENSE);
    if (!living) throw new Error('missing living room');
    const temperature = thermostat(living).getCharacteristic(hap.Characteristic.CurrentTemperature).value;
    const registered = localApi.registered.length;

    failReads = true;
    await local.pollLoopOnce();
    expect(thermostat(living).getCharacteristic(hap.Characteristic.CurrentTemperature).value).toBe(temperature);
    expect(localApi.registered).toHaveLength(registered);
    expect(localApi.unregistered).toHaveLength(0);
    expect(localLog.text()).toContain('Keeping last known values');
    expect(localSchedule.pending.at(-1)?.ms).toBe(10 * 60 * 1000);
    expect(calls.hub).toBeGreaterThan(0);
    expect(calls.sense).toBeGreaterThan(0);
  });

  it('hides a room listed in the config', async () => {
    const localApi = createApi();
    const local = new LkArcPlatform(captureLogger().log, {
      platform: PLATFORM_NAME,
      email: EMAIL,
      password: PASSWORD,
      hideRooms: ['Badrum'],
    }, localApi as unknown as API, {
      schedule,
      client: {
        async ensureUserId() {
          return 'user-1';
        },
        async getUserStructure() {
          return fixture<Realestate[]>('user_structure.json');
        },
        async getHubStructure() {
          return fixture<HubStructure>('hub_structure.json');
        },
        async getSenseMeasurement() {
          return tuneMeasurement();
        },
        async setTemperature() {},
      },
    });
    await local.pollOnce();
    expect(localApi.registered.map((accessory) => accessory.displayName)).toEqual(['Vardagsrum']);
  });

  it('loads the plugin entry and registers the platform constructor', async () => {
    const registered: unknown[][] = [];
    const plugin = (await import('../src/index')).default as (api: API) => void;
    const register = typeof plugin === 'function' ? plugin : (plugin as any).default;
    register({
      registerPlatform: (...args: unknown[]) => registered.push(args),
    } as unknown as API);
    expect(registered[0]?.[0]).toBe('homebridge-lk-arc');
    expect(registered[0]?.[1]).toBe('LkArc');
    expect(registered[0]?.[2]).toBe(LkArcPlatform);
  });

  it('wires a HomeKit target temperature through the debouncer without posting an unchanged value', async () => {
    const sent: number[] = [];
    const queued: Array<() => Promise<void> | void> = [];
    const accessory = new HapAccessory('Vardagsrum', hap.uuid.generate(MAC_SENSE));
    const room = new LkRoomAccessory({
      hap,
      log: captureLogger().log,
      accessory,
      mac: MAC_SENSE,
      deviceRole: 'arc-sense',
      roomName: 'Vardagsrum',
      schedule: (fn, ms) => {
        expect(ms).toBe(1500);
        queued.push(fn);
        return { cancel() {} };
      },
      setTemperature: async (_mac, tenths) => {
        sent.push(tenths);
      },
    });
    room.apply(fixture<SenseMeasurements>('sense_measurement.json'));
    room.handleTargetTemperature(22);
    await queued.at(-1)?.();
    expect(sent).toEqual([]);
    room.handleTargetTemperature(21.5);
    await queued.at(-1)?.();
    expect(sent).toEqual([215]);
  });

  it('keeps a written setpoint when the cached hub read is still stale', async () => {
    let now = 1_000_000;
    const queued: Array<() => Promise<void> | void> = [];
    const accessory = new HapAccessory('Vardagsrum', hap.uuid.generate('stale-setpoint'));
    const room = new LkRoomAccessory({
      hap,
      log: captureLogger().log,
      accessory,
      mac: MAC_SENSE,
      deviceRole: 'arc-sense',
      roomName: 'Vardagsrum',
      now: () => now,
      schedule: (fn) => {
        queued.push(fn);
        return { cancel() {} };
      },
      setTemperature: async () => {},
    });
    const measurement = fixture<SenseMeasurements>('sense_measurement.json');
    room.apply(measurement);
    room.handleTargetTemperature(21.5);
    await queued.at(-1)?.();
    room.apply(measurement);
    const target = thermostat(accessory).getCharacteristic(hap.Characteristic.TargetTemperature);
    expect(target.value).toBeCloseTo(21.5, 5);

    room.apply({ ...measurement, desiredTemperature: 215 });
    expect(target.value).toBeCloseTo(21.5, 5);
    room.apply(measurement);
    expect(target.value).toBeCloseTo(22, 5);

    room.handleTargetTemperature(21);
    await queued.at(-1)?.();
    room.apply(measurement);
    expect(target.value).toBeCloseTo(21, 5);
    now += 21_000;
    room.apply(measurement);
    expect(target.value).toBeCloseTo(22, 5);
  });
});

function infoModel(accessory: PlatformAccessory): unknown {
  return accessory.getService(hap.Service.AccessoryInformation)
    ?.getCharacteristic(hap.Characteristic.Model).value;
}

describe('platform HTTP smoke', () => {
  it('discovers rooms through the injected fetch client', async () => {
    const login = fixture('login.json');
    const user = fixture('user.json');
    const structure = fixture('user_structure.json');
    const hub = fixture('hub_structure.json');
    const measurement = fixture<SenseMeasurements>('sense_measurement.json');
    const configuration = fixture('sense_configuration.json');
    expect(configuration.mac).toBe(MAC_SENSE);

    const { calls, fetchImpl } = recordFetch((call) => {
      if (call.url.endsWith('/auth/auth/login')) return jsonResponse({ ...login, accessToken: makeJwt(1_900_000_000) });
      if (call.url.endsWith('/auth/auth/user')) return jsonResponse(user);
      if (call.url.includes('/service/users/user/') && call.url.endsWith('/structure/false')) return jsonResponse(structure);
      if (call.url.endsWith('/service/arc/hub/ARCHUB000123/structure/false')) return jsonResponse(hub);
      if (call.url.includes('/service/arc/sense/') && call.url.endsWith('/measurement/true')) {
        return jsonResponse({ ...measurement, mac: MAC_TUNE, desiredTemperature: 210, currentTemperature: 200 });
      }
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });

    const localApi = createApi();
    const platform = new LkArcPlatform(captureLogger().log, {
      platform: PLATFORM_NAME,
      email: EMAIL,
      password: PASSWORD,
      debug: true,
    }, localApi as unknown as API, { fetchImpl, sleep: instantSleep, schedule: manualSchedule().schedule });

    await platform.pollOnce();
    expect(localApi.registered.map((accessory) => accessory.displayName).sort()).toEqual(['Badrum', 'Vardagsrum']);
    const paths = calls.map((call) => call.url.replace('https://link2.lk.nu/', ''));
    expect(paths).toContain('auth/auth/login');
    expect(paths).toContain('auth/auth/user');
    expect(paths).toContain(`service/users/user/${user.userId}/structure/false`);
    expect(paths).toContain('service/arc/hub/ARCHUB000123/structure/false');
    expect(paths).toContain(`service/arc/sense/${MAC_TUNE}/measurement/true`);
    expect(paths.some((entry) => entry.includes('/configuration/'))).toBe(false);
    expect(LkClient).toBeTypeOf('function');
  });
});

import { describe, expect, it } from 'vitest';
import {
  celsiusToSetpointTenths,
  classifyDevices,
  isHeating,
  isHub,
  isRoomSensor,
  looksOffline,
  clampBatteryPercent,
  roomName,
  selectRooms,
  tenthsToCelsius,
} from '../src/mapping';
import { nextPollDelayMs, resolvePollIntervalMinutes, resolveSettings } from '../src/settings';
import { isAccessTokenValid } from '../src/token';
import { maskSecrets } from '../src/redact';
import type { DeviceTitle, Realestate, SenseMeasurements } from '../src/types';
import { fixture, makeJwt } from './helpers';

describe('mapping', () => {
  it('converts tenths to celsius and percent', () => {
    expect(tenthsToCelsius(214)).toBeCloseTo(21.4, 5);
    expect(tenthsToCelsius(220)).toBeCloseTo(22, 5);
    expect(tenthsToCelsius(412)).toBeCloseTo(41.2, 5);
  });

  it('rounds to 0.5 °C and clamps to 5–30', () => {
    expect(celsiusToSetpointTenths(21.24)).toBe(210);
    expect(celsiusToSetpointTenths(21.26)).toBe(215);
    expect(celsiusToSetpointTenths(21)).toBe(210);
    expect(celsiusToSetpointTenths(21.5)).toBe(215);
    expect(celsiusToSetpointTenths(22)).toBe(220);
    expect(celsiusToSetpointTenths(3)).toBe(50);
    expect(celsiusToSetpointTenths(35)).toBe(300);
    expect(celsiusToSetpointTenths(Number.NaN)).toBeNull();
  });

  it('infers heating only when current is below the setpoint', () => {
    expect(isHeating(214, 220)).toBe(true);
    expect(isHeating(220, 220)).toBe(false);
    expect(isHeating(230, 210)).toBe(false);
    expect(isHeating(null, 220)).toBeNull();
  });

  it('clamps battery and treats only clearly offline connection states as faults', () => {
    expect(clampBatteryPercent(87)).toBe(87);
    expect(clampBatteryPercent(120)).toBe(100);
    expect(clampBatteryPercent(-4)).toBe(0);
    expect(looksOffline('connected')).toBe(false);
    expect(looksOffline('Connected')).toBe(false);
    expect(looksOffline(undefined)).toBe(false);
    expect(looksOffline('something-new')).toBe(false);
    expect(looksOffline('disconnected')).toBe(true);
    expect(looksOffline('offline')).toBe(true);
  });

  it('keeps arc-sense and arc-tune, drops the hub and cubic devices', () => {
    const structure = fixture<Realestate[]>('user_structure.json');
    structure[0].realestateMachines?.push(
      {
        identity: 'CUBIC-1',
        deviceGroup: 'cubicsecure',
        deviceType: 'detector',
        deviceRole: 'detector',
        zone: { zoneName: 'Hallway detector' },
      },
      {
        identity: 'AA:BB:CC:DD:EE:09',
        deviceGroup: 'arc',
        deviceType: 'arc-other',
        deviceRole: 'arc-sense',
        zone: { zoneName: 'Ignored' },
      },
    );

    const { hubs, roomCandidates } = classifyDevices(structure);
    expect(hubs.map((device) => device.identity)).toEqual(['ARCHUB000123']);
    expect(roomCandidates.map((device) => device.identity)).toEqual([
      'AA:BB:CC:DD:EE:01',
      'AA:BB:CC:DD:EE:02',
    ]);
    expect(roomCandidates.every(isRoomSensor)).toBe(true);
    expect(hubs.every(isHub)).toBe(true);
    expect(roomName(roomCandidates[0])).toBe('Vardagsrum');
    expect(roomName(roomCandidates[1])).toBe('Badrum');
  });

  it('falls back to the MAC when the zone name is missing and skips a null setpoint', () => {
    const nameless: DeviceTitle = {
      identity: 'AA:BB:CC:DD:EE:08',
      deviceGroup: 'arc',
      deviceType: 'arc-sense',
      deviceRole: 'arc-sense',
      zone: { zoneName: '  ' },
    };
    expect(roomName(nameless)).toBe('AA:BB:CC:DD:EE:08');

    const measurements = new Map<string, SenseMeasurements>([
      ['AA:BB:CC:DD:EE:01', fixture('sense_measurement.json')],
      ['AA:BB:CC:DD:EE:02', { desiredTemperature: null, currentTemperature: 180 }],
      ['AA:BB:CC:DD:EE:08', { desiredTemperature: 200, currentTemperature: 190 }],
    ]);
    const selection = selectRooms(
      [
        fixture<Realestate[]>('user_structure.json')[0].realestateMachines![1],
        fixture<Realestate[]>('user_structure.json')[0].realestateMachines![2],
        nameless,
      ],
      measurements,
      new Set(['AA:BB:CC:DD:EE:07']),
      ['Badrum'],
    );

    expect(selection.exposed.map((room) => room.name)).toEqual(['Vardagsrum', 'AA:BB:CC:DD:EE:08']);
    expect(selection.removedMacs).toEqual(['AA:BB:CC:DD:EE:02']);
    expect(selection.unresolvedMacs).toEqual([]);
  });

  it('keeps a room unresolved when its read failed', () => {
    const device = fixture<Realestate[]>('user_structure.json')[0].realestateMachines![1];
    const selection = selectRooms([device], new Map(), new Set(['AA:BB:CC:DD:EE:01']), []);
    expect(selection.exposed).toEqual([]);
    expect(selection.unresolvedMacs).toEqual(['AA:BB:CC:DD:EE:01']);
  });
});

describe('settings and token lifetime', () => {
  it('defaults the poll interval and enforces the minimum', () => {
    expect(resolvePollIntervalMinutes(undefined)).toBe(5);
    expect(resolvePollIntervalMinutes(0)).toBe(1);
    expect(resolvePollIntervalMinutes(1.9)).toBe(1);
    expect(resolvePollIntervalMinutes('4')).toBe(4);
    expect(resolveSettings({ platform: 'LkArc' })).toBeNull();
    const resolved = resolveSettings({
      platform: 'LkArc',
      email: ' you@example.com ',
      password: 'secret',
      pollIntervalMinutes: 5,
      encodeMac: true,
      hideRooms: [' Bath ', 3, ''],
    });
    expect(resolved).toMatchObject({
      email: 'you@example.com',
      password: 'secret',
      pollIntervalMinutes: 5,
      pollIntervalMs: 300_000,
      encodeMac: true,
      hideRooms: ['Bath'],
      debug: false,
    });
  });

  it('backs off the poll loop and caps at 30 minutes', () => {
    expect(nextPollDelayMs(0, 300_000)).toBe(300_000);
    expect(nextPollDelayMs(1, 300_000)).toBe(600_000);
    expect(nextPollDelayMs(2, 300_000)).toBe(1_200_000);
    expect(nextPollDelayMs(10, 300_000)).toBe(30 * 60 * 1000);
  });

  it('treats a token as stale when fewer than five minutes remain', () => {
    const nowMs = 1_700_000_000_000;
    const nowSec = 1_700_000_000;
    expect(isAccessTokenValid(makeJwt(nowSec + 300), nowMs)).toBe(true);
    expect(isAccessTokenValid(makeJwt(nowSec + 299), nowMs)).toBe(false);
    expect(isAccessTokenValid('not-a-jwt', nowMs)).toBe(false);
    expect(isAccessTokenValid(fixture<{ accessToken: string }>('login.json').accessToken, nowMs)).toBe(true);
  });

  it('masks passwords, bearer tokens and token fields', () => {
    const masked = maskSecrets(
      'Bearer abc.def.ghi password super-secret-password {"password":"super-secret-password","accessToken":"abc.def.ghi","refreshToken":"refresh-me"}',
      ['super-secret-password', 'abc.def.ghi', 'refresh-me'],
    );
    expect(masked).not.toContain('super-secret-password');
    expect(masked).not.toContain('abc.def.ghi');
    expect(masked).not.toContain('refresh-me');
    expect(masked).toContain('***');
    expect(masked).toContain('Bearer ***');
  });
});

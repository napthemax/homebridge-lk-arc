import { MAX_CELSIUS, MIN_CELSIUS } from './settings';
import type { DeviceTitle, Realestate, SenseMeasurements } from './types';

const OFFLINE_CONNECTION_STATES = new Set([
  'offline',
  'disconnected',
  'false',
  '0',
  'lost',
  'error',
]);

export function normalizeMac(mac: string): string {
  return mac.trim().toUpperCase();
}

export function isHub(device: DeviceTitle): boolean {
  return device.deviceGroup === 'arc'
    && device.deviceType === 'arc-hub'
    && device.deviceRole === 'arc-hub';
}

export function isRoomSensor(device: DeviceTitle): boolean {
  return device.deviceGroup === 'arc'
    && device.deviceType === 'arc-sense'
    && (device.deviceRole === 'arc-sense' || device.deviceRole === 'arc-tune');
}

export function roomName(device: DeviceTitle): string {
  const zone = device.zone?.zoneName?.trim();
  if (zone) {
    return zone;
  }
  const identity = device.identity?.trim();
  return identity && identity.length > 0 ? identity : 'LK Arc room';
}

export interface ClassifiedDevices {
  hubs: DeviceTitle[];
  roomCandidates: DeviceTitle[];
}

export function classifyDevices(realestates: Realestate[]): ClassifiedDevices {
  const hubs: DeviceTitle[] = [];
  const roomCandidates: DeviceTitle[] = [];
  for (const estate of realestates) {
    for (const device of estate.realestateMachines ?? []) {
      if (!device.identity?.trim()) {
        continue;
      }
      if (isHub(device)) {
        hubs.push(device);
      } else if (isRoomSensor(device)) {
        roomCandidates.push(device);
      }
    }
  }
  return { hubs, roomCandidates };
}

export function tenthsToCelsius(tenths: number): number {
  return tenths / 10;
}

/**
 * Clamp to 5–30 °C and round to the nearest 0.5 before converting to tenths.
 * `Math.round(t * 2) * 5` yields 50..300 in steps of 5.
 */
export function celsiusToSetpointTenths(celsius: number): number | null {
  if (!Number.isFinite(celsius)) {
    return null;
  }
  const clamped = Math.min(MAX_CELSIUS, Math.max(MIN_CELSIUS, celsius));
  return Math.round(clamped * 2) * 5;
}

/** HEAT when the room is below the setpoint, otherwise OFF. Null if either side is missing. */
export function isHeating(
  currentTenths: number | null | undefined,
  targetTenths: number | null | undefined,
): boolean | null {
  if (typeof currentTenths !== 'number' || typeof targetTenths !== 'number') {
    return null;
  }
  return currentTenths < targetTenths;
}

export function clampBatteryPercent(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/**
 * connectionState values are not documented. Only clearly negative strings
 * count as offline so an unknown enum does not raise a fault.
 */
export function looksOffline(connectionState: string | null | undefined): boolean {
  if (!connectionState) {
    return false;
  }
  return OFFLINE_CONNECTION_STATES.has(connectionState.trim().toLowerCase());
}

export function isHiddenRoom(name: string, mac: string, hideRooms: string[]): boolean {
  if (hideRooms.length === 0) {
    return false;
  }
  const keys = new Set(hideRooms.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0));
  return keys.has(name.trim().toLowerCase()) || keys.has(mac.trim().toLowerCase());
}

export interface ExposedRoom {
  mac: string;
  name: string;
  deviceRole: string;
  measurement: SenseMeasurements;
}

export interface RoomSelection {
  exposed: ExposedRoom[];
  /** Normalised MACs with an explicit null/missing setpoint, or a hidden room. */
  removedMacs: string[];
  /** Normalised MACs whose read failed. Keep the cached accessory. */
  unresolvedMacs: string[];
}

export function selectRooms(
  candidates: DeviceTitle[],
  measurements: Map<string, SenseMeasurements>,
  failedMacs: Set<string>,
  hideRooms: string[],
): RoomSelection {
  const exposed: ExposedRoom[] = [];
  const removedMacs: string[] = [];
  const unresolvedMacs: string[] = [];

  for (const device of candidates) {
    const mac = device.identity?.trim();
    if (!mac) {
      continue;
    }
    const key = normalizeMac(mac);
    const name = roomName(device);
    if (isHiddenRoom(name, mac, hideRooms)) {
      removedMacs.push(key);
      continue;
    }
    if (failedMacs.has(key) && !measurements.has(key)) {
      unresolvedMacs.push(key);
      continue;
    }
    const measurement = measurements.get(key);
    if (!measurement) {
      unresolvedMacs.push(key);
      continue;
    }
    if (measurement.desiredTemperature == null) {
      removedMacs.push(key);
      continue;
    }
    exposed.push({
      mac,
      name,
      deviceRole: device.deviceRole?.trim() || 'arc-sense',
      measurement,
    });
  }

  return { exposed, removedMacs, unresolvedMacs };
}

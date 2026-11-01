import type { API, DynamicPlatformPlugin, PlatformAccessory, PlatformConfig } from 'homebridge';
import { LkClient, type FetchLike, type PluginLogger } from './lkClient';
import {
  classifyDevices,
  normalizeMac,
  roomName,
  selectRooms,
  type RoomSelection,
} from './mapping';
import { errorMessage } from './redact';
import { LkRoomAccessory, defaultSchedule, type ScheduleFn } from './roomAccessory';
import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  SETPOINT_REFRESH_DELAY_MS,
  nextPollDelayMs,
  resolveSettings,
  type ResolvedSettings,
} from './settings';
import type { LkApi, SenseMeasurements } from './types';

export interface PlatformDeps {
  client?: LkApi;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  schedule?: ScheduleFn;
}

export class LkArcPlatform implements DynamicPlatformPlugin {
  private readonly settings: ResolvedSettings | null;
  private readonly client: LkApi | null;
  private readonly schedule: ScheduleFn;
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly rooms = new Map<string, LkRoomAccessory>();

  private failures = 0;
  private stopped = false;
  private started = false;
  private signature = '';
  private timer: { cancel(): void } | undefined;
  private refreshTimer: { cancel(): void } | undefined;
  private pollFlight: Promise<void> | null = null;

  constructor(
    private readonly log: PluginLogger,
    config: PlatformConfig,
    private readonly api: API,
    deps: PlatformDeps = {},
  ) {
    this.settings = resolveSettings(config);
    this.schedule = deps.schedule ?? defaultSchedule;
    if (deps.client) {
      this.client = deps.client;
    } else if (this.settings) {
      this.client = new LkClient({
        email: this.settings.email,
        password: this.settings.password,
        encodeMac: this.settings.encodeMac,
        debug: this.settings.debug,
        logger: log,
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
        now: deps.now,
      });
    } else {
      this.client = null;
    }

    this.api.on('didFinishLaunching', () => {
      void this.start();
    });
    this.api.on('shutdown', () => {
      this.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
    const mac = typeof accessory.context.mac === 'string' ? accessory.context.mac : undefined;
    const deviceRole = typeof accessory.context.deviceRole === 'string'
      ? accessory.context.deviceRole
      : 'arc-sense';
    if (mac) {
      this.attach(accessory, mac, deviceRole, accessory.displayName);
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    if (!this.settings || !this.client) {
      this.log.error('LK Arc needs an email and password.');
      return;
    }
    this.log.info(`${this.settings.name} polling every ${this.settings.pollIntervalMinutes} minute(s).`);
    await this.pollLoopOnce();
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.refreshTimer?.cancel();
    for (const room of this.rooms.values()) {
      room.dispose();
    }
  }

  /**
   * One poll, then schedule the next. Failures keep the last HomeKit values
   * and back off so a dead cloud is not polled at the normal interval.
   */
  async pollLoopOnce(): Promise<void> {
    if (this.stopped || !this.client || !this.settings) {
      return;
    }
    try {
      await this.pollOnce();
      this.failures = 0;
      this.arm(this.settings.pollIntervalMs);
    } catch (err) {
      this.failures += 1;
      const delay = nextPollDelayMs(this.failures, this.settings.pollIntervalMs);
      this.log.warn(
        `Poll failed. Keeping last known values. Next attempt in ${Math.round(delay / 1000)}s. ${errorMessage(err)}`,
      );
      this.arm(delay);
    }
  }

  pollOnce(): Promise<void> {
    if (!this.client || !this.settings) {
      return Promise.reject(new Error('LK Arc is not configured'));
    }
    if (this.pollFlight) {
      return this.pollFlight;
    }
    this.pollFlight = this.pollOnceInner().finally(() => {
      this.pollFlight = null;
    });
    return this.pollFlight;
  }

  requestRefreshSoon(): void {
    if (this.stopped || this.refreshTimer) {
      return;
    }
    this.refreshTimer = this.schedule(() => {
      this.refreshTimer = undefined;
      void this.pollOnce().catch((err) => {
        this.log.warn(`Refresh after setpoint failed. Keeping last known values. ${errorMessage(err)}`);
      });
    }, SETPOINT_REFRESH_DELAY_MS);
  }

  private arm(delayMs: number): void {
    this.timer?.cancel();
    if (this.stopped) {
      return;
    }
    this.timer = this.schedule(() => {
      void this.pollLoopOnce();
    }, delayMs);
  }

  private async pollOnceInner(): Promise<void> {
    if (!this.client || !this.settings) {
      throw new Error('LK Arc is not configured');
    }

    const userId = await this.client.ensureUserId();
    const structure = await this.client.getUserStructure(userId);
    const { hubs, roomCandidates } = classifyDevices(structure);
    const measurements = new Map<string, SenseMeasurements>();
    const failed = new Set<string>();

    for (const hub of hubs) {
      const hubId = hub.identity?.trim();
      if (!hubId) {
        continue;
      }
      try {
        const hubStructure = await this.client.getHubStructure(hubId);
        for (const device of hubStructure.devices ?? []) {
          if (!device.mac || !device.measurement) {
            continue;
          }
          measurements.set(normalizeMac(device.mac), device.measurement);
        }
      } catch (err) {
        this.log.warn(
          `Hub ${hubId} structure failed. Falling back to per-room reads. ${errorMessage(err)}`,
        );
      }
    }

    for (const candidate of roomCandidates) {
      const mac = candidate.identity?.trim();
      if (!mac) {
        continue;
      }
      const key = normalizeMac(mac);
      if (measurements.has(key)) {
        continue;
      }
      try {
        measurements.set(key, await this.client.getSenseMeasurement(mac));
      } catch (err) {
        failed.add(key);
        this.log.warn(
          `Could not read ${roomName(candidate)} (${mac}). Keeping last known values. ${errorMessage(err)}`,
        );
      }
    }

    const allFailed = roomCandidates.length > 0 && roomCandidates.every((candidate) => {
      const mac = candidate.identity?.trim();
      return !!mac && failed.has(normalizeMac(mac));
    });
    if (allFailed) {
      throw new Error(`Failed to read all ${roomCandidates.length} room(s)`);
    }

    this.reconcile(hubs.length, selectRooms(roomCandidates, measurements, failed, this.settings.hideRooms));
  }

  private reconcile(hubCount: number, selection: RoomSelection): void {
    const exposedUuids = new Set<string>();
    const unresolved = new Set(selection.unresolvedMacs);

    for (const room of selection.exposed) {
      const uuid = this.api.hap.uuid.generate(room.mac);
      exposedUuids.add(uuid);
      let accessory = this.accessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(
          room.name,
          uuid,
          this.api.hap.Categories.THERMOSTAT,
        );
        accessory.context.mac = room.mac;
        accessory.context.deviceRole = room.deviceRole;
        this.accessories.set(uuid, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added room ${room.name} (${room.mac})`);
      } else if (accessory.displayName !== room.name) {
        accessory.displayName = room.name;
        this.api.updatePlatformAccessories([accessory]);
      }
      this.attach(accessory, room.mac, room.deviceRole, room.name).apply(room.measurement);
    }

    for (const [uuid, accessory] of this.accessories) {
      if (exposedUuids.has(uuid)) {
        continue;
      }
      const mac = typeof accessory.context.mac === 'string' ? normalizeMac(accessory.context.mac) : undefined;
      if (mac && unresolved.has(mac)) {
        continue;
      }
      this.rooms.get(uuid)?.dispose();
      this.rooms.delete(uuid);
      this.accessories.delete(uuid);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`Removed room ${accessory.displayName}`);
    }

    const names = selection.exposed.map((room) => room.name);
    const signature = selection.exposed.map((room) => `${room.mac}=${room.name}`).sort().join('|');
    const summary = `Discovered ${selection.exposed.length} room(s) on ${hubCount} hub(s)${names.length ? `: ${names.join(', ')}` : ''}`;
    if (signature !== this.signature) {
      this.log.info(summary);
      this.signature = signature;
    } else {
      this.log.debug(summary);
    }
  }

  private attach(
    accessory: PlatformAccessory,
    mac: string,
    deviceRole: string,
    name: string,
  ): LkRoomAccessory {
    let room = this.rooms.get(accessory.UUID);
    if (!room) {
      room = new LkRoomAccessory({
        hap: this.api.hap,
        log: this.log,
        accessory,
        mac,
        deviceRole,
        roomName: name,
        schedule: this.schedule,
        setTemperature: async (targetMac, tenths) => {
          if (!this.client) {
            throw new Error('LK Arc is not configured');
          }
          await this.client.setTemperature(targetMac, tenths);
        },
        onCommitted: () => this.requestRefreshSoon(),
        onRename: () => this.api.updatePlatformAccessories([accessory]),
      });
      this.rooms.set(accessory.UUID, room);
    } else {
      room.setIdentity(name, deviceRole);
    }
    return room;
  }
}

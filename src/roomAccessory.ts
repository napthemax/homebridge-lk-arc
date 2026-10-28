import type { API, PlatformAccessory, Service, WithUUID } from 'homebridge';
import {
  clampBatteryPercent,
  isHeating,
  looksOffline,
  tenthsToCelsius,
  celsiusToSetpointTenths,
} from './mapping';
import { errorMessage } from './redact';
import type { PluginLogger } from './lkClient';
import { MAX_CELSIUS, MIN_CELSIUS, SETPOINT_DEBOUNCE_MS, SETPOINT_ECHO_GRACE_MS } from './settings';
import type { Characteristic } from 'homebridge';
import type { SenseMeasurements } from './types';

type Hap = API['hap'];
type CharacteristicCtor = WithUUID<new (...args: any[]) => Characteristic>;

export interface ScheduledTimer {
  cancel(): void;
}

export type ScheduleFn = (fn: () => Promise<void> | void, ms: number) => ScheduledTimer;

export class SetpointDebouncer {
  private timer: ScheduledTimer | undefined;
  private pendingCelsius: number | undefined;
  private lastTenths: number | null;

  constructor(
    private readonly delayMs: number,
    private readonly send: (tenths: number) => Promise<void>,
    private readonly schedule: ScheduleFn,
    private readonly log: PluginLogger,
    private readonly label: string,
    initialTenths: number | null = null,
  ) {
    this.lastTenths = initialTenths;
  }

  hasPending(): boolean {
    return this.pendingCelsius !== undefined;
  }

  noteRemoteTenths(tenths: number | null): void {
    if (this.pendingCelsius !== undefined) {
      return;
    }
    this.lastTenths = tenths;
  }

  push(celsius: number): void {
    this.pendingCelsius = celsius;
    this.timer?.cancel();
    this.timer = this.schedule(() => this.flush(), this.delayMs);
  }

  cancel(): void {
    this.timer?.cancel();
    this.timer = undefined;
    this.pendingCelsius = undefined;
  }

  private async flush(): Promise<void> {
    const celsius = this.pendingCelsius;
    this.pendingCelsius = undefined;
    this.timer = undefined;
    if (celsius === undefined) {
      return;
    }
    const tenths = celsiusToSetpointTenths(celsius);
    if (tenths === null) {
      return;
    }
    if (this.lastTenths === tenths) {
      this.log.debug(`Setpoint for ${this.label} unchanged at ${tenths / 10}°C; not sending`);
      return;
    }
    try {
      await this.send(tenths);
      this.lastTenths = tenths;
    } catch (err) {
      this.log.error(`Setpoint for ${this.label} failed: ${errorMessage(err)}`);
    }
  }
}

export interface RoomAccessoryOptions {
  hap: Hap;
  log: PluginLogger;
  accessory: PlatformAccessory;
  mac: string;
  deviceRole: string;
  roomName: string;
  setTemperature: (mac: string, tenths: number) => Promise<void>;
  onCommitted?: () => void;
  onRename?: (name: string) => void;
  schedule?: ScheduleFn;
  debounceMs?: number;
  now?: () => number;
}

export function defaultSchedule(fn: () => Promise<void> | void, ms: number): ScheduledTimer {
  const handle = setTimeout(() => {
    void fn();
  }, ms);
  return { cancel: () => clearTimeout(handle) };
}

export class LkRoomAccessory {
  private readonly hap: Hap;
  private readonly log: PluginLogger;
  private readonly accessory: PlatformAccessory;
  private readonly mac: string;
  private readonly thermostat: Service;
  private readonly debouncer: SetpointDebouncer;
  private readonly setTemperature: (mac: string, tenths: number) => Promise<void>;
  private readonly onCommitted?: () => void;
  private readonly onRename?: (name: string) => void;
  private roomName: string;
  private deviceRole: string;
  private readonly now: () => number;
  private acceptedTenths: number | null = null;
  private acceptRemoteAfter = 0;

  constructor(options: RoomAccessoryOptions) {
    this.hap = options.hap;
    this.log = options.log;
    this.accessory = options.accessory;
    this.mac = options.mac;
    this.roomName = options.roomName;
    this.deviceRole = options.deviceRole;
    this.setTemperature = options.setTemperature;
    this.onCommitted = options.onCommitted;
    this.onRename = options.onRename;
    this.now = options.now ?? Date.now;
    this.accessory.context.mac = options.mac;
    this.accessory.context.deviceRole = options.deviceRole;

    const { Service, Characteristic } = this.hap;
    const existing = this.accessory.getService(Service.Thermostat);
    this.thermostat = existing ?? this.accessory.addService(Service.Thermostat, this.roomName);

    this.thermostat.addOptionalCharacteristic(Characteristic.StatusFault);
    this.thermostat.addOptionalCharacteristic(Characteristic.StatusActive);
    this.thermostat.addOptionalCharacteristic(Characteristic.CurrentRelativeHumidity);

    const targetTemperature = this.characteristic(Characteristic.TargetTemperature);
    targetTemperature.setProps({
      minValue: MIN_CELSIUS,
      maxValue: MAX_CELSIUS,
      minStep: 0.5,
    });
    targetTemperature.onSet((value) => {
      this.handleTargetTemperature(Number(value));
    });

    const targetState = this.characteristic(Characteristic.TargetHeatingCoolingState);
    targetState.updateValue(Characteristic.TargetHeatingCoolingState.HEAT);
    targetState.setProps({
      validValues: [Characteristic.TargetHeatingCoolingState.HEAT],
    });
    targetState.onSet((value) => {
      if (value !== Characteristic.TargetHeatingCoolingState.HEAT) {
        targetState.updateValue(Characteristic.TargetHeatingCoolingState.HEAT);
      }
    });

    const units = this.characteristic(Characteristic.TemperatureDisplayUnits);
    units.updateValue(Characteristic.TemperatureDisplayUnits.CELSIUS);
    units.setProps({
      validValues: [Characteristic.TemperatureDisplayUnits.CELSIUS],
    });

    this.characteristic(Characteristic.CurrentRelativeHumidity).setProps({
      minValue: 0,
      maxValue: 100,
      minStep: 0.1,
    });

    this.debouncer = new SetpointDebouncer(
      options.debounceMs ?? SETPOINT_DEBOUNCE_MS,
      (tenths) => this.commitSetpoint(tenths),
      options.schedule ?? defaultSchedule,
      this.log,
      this.roomName,
    );

    this.writeInformation();
  }

  handleTargetTemperature(celsius: number): void {
    this.debouncer.push(celsius);
  }

  apply(measurement: SenseMeasurements): void {
    const { Characteristic } = this.hap;
    if (typeof measurement.currentTemperature === 'number') {
      this.characteristic(Characteristic.CurrentTemperature)
        .updateValue(tenthsToCelsius(measurement.currentTemperature));
    }

    const remoteDesired = measurement.desiredTemperature;
    const holdLocal = this.acceptedTenths !== null
      && this.now() < this.acceptRemoteAfter
      && remoteDesired !== this.acceptedTenths;
    if (typeof remoteDesired === 'number' && !this.debouncer.hasPending() && !holdLocal) {
      if (remoteDesired === this.acceptedTenths) {
        this.acceptedTenths = null;
      }
      this.debouncer.noteRemoteTenths(remoteDesired);
      this.characteristic(Characteristic.TargetTemperature)
        .updateValue(tenthsToCelsius(remoteDesired));
    }

    if (!this.debouncer.hasPending()) {
      const desiredForState = holdLocal ? this.acceptedTenths : remoteDesired;
      const heating = isHeating(measurement.currentTemperature, desiredForState);
      if (heating !== null) {
        const state = Characteristic.CurrentHeatingCoolingState;
        this.characteristic(state).updateValue(heating ? state.HEAT : state.OFF);
      }
    }

    if (typeof measurement.currentHumidity === 'number') {
      const percent = Math.min(100, Math.max(0, tenthsToCelsius(measurement.currentHumidity)));
      this.characteristic(Characteristic.CurrentRelativeHumidity).updateValue(percent);
    }

    const offline = looksOffline(measurement.connectionState);
    const fault = Characteristic.StatusFault;
    this.characteristic(fault).updateValue(offline ? fault.GENERAL_FAULT : fault.NO_FAULT);
    this.characteristic(Characteristic.StatusActive).updateValue(!offline);
    this.writeBattery(measurement);
    this.characteristic(Characteristic.TargetHeatingCoolingState)
      .updateValue(Characteristic.TargetHeatingCoolingState.HEAT);
    this.characteristic(Characteristic.TemperatureDisplayUnits)
      .updateValue(Characteristic.TemperatureDisplayUnits.CELSIUS);
  }

  setIdentity(roomName: string, deviceRole: string): void {
    this.deviceRole = deviceRole;
    if (this.roomName !== roomName) {
      this.roomName = roomName;
      this.accessory.displayName = roomName;
      const info = this.accessory.getService(this.hap.Service.AccessoryInformation);
      info?.updateCharacteristic(this.hap.Characteristic.Name, roomName);
      this.onRename?.(roomName);
    }
    this.writeInformation();
  }

  dispose(): void {
    this.debouncer.cancel();
  }

  private async commitSetpoint(tenths: number): Promise<void> {
    await this.setTemperature(this.mac, tenths);
    this.acceptedTenths = tenths;
    this.acceptRemoteAfter = this.now() + SETPOINT_ECHO_GRACE_MS;
    this.characteristic(this.hap.Characteristic.TargetTemperature).updateValue(tenths / 10);
    this.log.info(`Setpoint for ${this.roomName} set to ${tenths / 10}°C`);
    this.onCommitted?.();
  }

  private writeInformation(): void {
    const { Characteristic, Service } = this.hap;
    const info = this.accessory.getService(Service.AccessoryInformation);
    if (!info) {
      return;
    }
    info.setCharacteristic(Characteristic.Manufacturer, 'LK Systems');
    info.setCharacteristic(Characteristic.Model, this.deviceRole);
    info.setCharacteristic(Characteristic.SerialNumber, this.mac);
    info.setCharacteristic(Characteristic.Name, this.roomName);
  }

  private writeBattery(measurement: SenseMeasurements): void {
    if (typeof measurement.currentBattery !== 'number') {
      return;
    }
    const { Service, Characteristic } = this.hap;
    const percent = clampBatteryPercent(measurement.currentBattery);
    let battery = this.accessory.getService(Service.Battery);
    if (!battery) {
      battery = this.accessory.addService(Service.Battery);
    }
    battery.getCharacteristic(Characteristic.BatteryLevel).updateValue(percent);
    const low = Characteristic.StatusLowBattery;
    battery.getCharacteristic(low).updateValue(
      percent <= 20 ? low.BATTERY_LEVEL_LOW : low.BATTERY_LEVEL_NORMAL,
    );
    battery.getCharacteristic(Characteristic.ChargingState)
      .updateValue(Characteristic.ChargingState.NOT_CHARGEABLE);
  }

  private characteristic(type: CharacteristicCtor) {
    return this.thermostat.getCharacteristic(type);
  }
}

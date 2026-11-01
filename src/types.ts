export interface LoginResponse {
  accessToken?: string | null;
  accessTokenExpire?: number;
  refreshToken?: string | null;
  refreshTokenExpire?: number;
}

export interface UserResponse {
  userId?: string | null;
}

export interface DeviceZone {
  zoneId?: string | null;
  zoneName?: string | null;
  cacheTimer?: number;
  cacheUpdated?: number;
}

export interface DeviceTitle {
  identity?: string | null;
  deviceGroup?: string | null;
  deviceType?: string | null;
  deviceRole?: string | null;
  realestateId?: string | null;
  realestateMachineId?: string | null;
  externalId?: string | null;
  createdAt?: number | null;
  cacheTimer?: number;
  cacheUpdated?: number;
  zone?: DeviceZone | null;
}

export interface Realestate {
  realestateId?: string | null;
  name?: string | null;
  address?: string | null;
  city?: string | null;
  zip?: string | null;
  country?: string | null;
  coordinates?: string | null;
  ownerId?: string | null;
  status?: string | null;
  cacheTimer?: number;
  cacheUpdated?: number;
  userPermissions?: unknown[] | null;
  realestateMachines?: DeviceTitle[] | null;
}

export interface SenseMeasurements {
  mac?: string | null;
  currentTemperature?: number | null;
  desiredTemperature?: number | null;
  currentHumidity?: number | null;
  currentBattery?: number | null;
  currentRssi?: number | null;
  connectionState?: string | null;
  lastActivityTime?: string | null;
  actuators?: Array<Record<string, number>> | null;
  cacheTimer?: number;
  cacheUpdated?: number;
}

export interface SenseConfiguration {
  mac?: string | null;
  hub?: string | null;
  actuators?: number[] | null;
  wired?: boolean | null;
  byPass?: boolean | null;
  overrideActive?: boolean | null;
  overrideLevel?: number | null;
  cacheTimer?: number;
  cacheUpdated?: number;
}

export interface HubStructureDevice {
  mac?: string | null;
  cacheTimer?: number;
  cacheUpdated?: number;
  deviceTitle?: DeviceTitle | null;
  measurement?: SenseMeasurements | null;
  configuration?: SenseConfiguration | null;
}

export interface HubStructure {
  cacheTimer?: number;
  cacheUpdated?: number;
  devices?: HubStructureDevice[] | null;
}

export interface SenseTemperature {
  temperature?: number;
}

export interface ProblemDetails {
  type?: string | null;
  title?: string | null;
  status?: number | null;
  detail?: string | null;
  instance?: string | null;
}

/** HTTP surface the platform needs. LkClient implements this. */
export interface LkApi {
  ensureUserId(): Promise<string>;
  getUserStructure(userId: string): Promise<Realestate[]>;
  getHubStructure(hubIdentity: string): Promise<HubStructure>;
  getSenseMeasurement(mac: string): Promise<SenseMeasurements>;
  setTemperature(mac: string, tenths: number): Promise<void>;
}

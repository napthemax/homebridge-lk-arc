# homebridge-lk-arc

Homebridge plugin that shows each [LK Systems](https://www.lksystems.se/) Arc floor-heating room as a HomeKit thermostat. It talks to the LK cloud at `https://link2.lk.nu/` using the same calls as the LK app.

Version 0.1.0. This is the first cut: one account, polling, and a target temperature. It does not publish itself anywhere.

The request and response shapes come from [angoyd/ha-lksystems](https://github.com/angoyd/ha-lksystems) (MIT), pinned at commit `eab11b3`, and from LK's published OpenAPI. Thank you to that project for the API work. This plugin is not affiliated with LK Systems.

## What it does

On each poll the plugin:

1. Signs in with `POST auth/auth/login` and reads your user id from `GET auth/auth/user`.
2. Loads `GET service/users/user/{userId}/structure/false`.
3. Treats `arc` / `arc-hub` / `arc-hub` devices as hubs, and `arc` / `arc-sense` devices with role `arc-sense` or `arc-tune` as rooms.
4. Prefers one `GET service/arc/hub/{hub}/structure/false` per hub (measurements are included). Sensors that hub call does not cover are read with `GET service/arc/sense/{mac}/measurement/true`.
5. Skips a sensor whose `desiredTemperature` is null, and removes a HomeKit accessory when its room disappears.
6. Maps each room to a Thermostat: temperatures and humidity are the cloud values divided by 10. Heating is inferred (current below target means heating). The target mode is heat only, in Celsius.

Setting the temperature in Home sends `POST control/arc/sense/{mac}/temperature` with `{"temperature": <tenths>}` after a short debounce. The value is clamped to 5–30 °C and rounded to the nearest 0.5 °C. If it matches the last known setpoint, nothing is sent. Hub structure is read from LK's cache, so for 20 seconds after a successful write the plugin keeps the temperature it just sent if that cache still shows the previous one.

Passwords and tokens are masked in the log.

## Install for a local test (before this is on npm)

You need Node.js 18.20, 20, or 22, and Homebridge 1.8 (2.0 beta should work). Build the plugin, then point Homebridge at that directory. Do not `npm publish`.

```bash
git clone https://github.com/napthemax/homebridge-lk-arc.git
cd homebridge-lk-arc
npm ci
npm run build
```

From the Homebridge config directory (often `~/.homebridge`):

```bash
npm install /absolute/path/to/homebridge-lk-arc
```

`npm link` also works if Homebridge and the plugin run as the same user:

```bash
cd /absolute/path/to/homebridge-lk-arc
npm link
cd ~/.homebridge
npm link homebridge-lk-arc
```

Restart Homebridge, then add the platform (the UI form comes from `config.schema.json`) or paste the block below into `config.json`.

### Raspberry Pi / hb-service

The Homebridge Raspberry Pi image runs as the `homebridge` user, with config and plugins under `/var/lib/homebridge`.

```bash
sudo hb-service stop
sudo -u homebridge git clone https://github.com/napthemax/homebridge-lk-arc.git /var/lib/homebridge/homebridge-lk-arc
cd /var/lib/homebridge/homebridge-lk-arc
sudo -u homebridge npm ci
sudo -u homebridge npm run build
cd /var/lib/homebridge
sudo -u homebridge npm install /var/lib/homebridge/homebridge-lk-arc
sudo hb-service start
```

`npm install -g /var/lib/homebridge/homebridge-lk-arc` is the other option when you intentionally install plugins globally for `hb-service`. After an update, run `npm run build` again and reinstall from the same path so Homebridge picks up `dist/`.

## Config

```json
{
  "platforms": [
    {
      "platform": "LkArc",
      "name": "LK Arc",
      "email": "you@example.com",
      "password": "your-password",
      "pollIntervalMinutes": 5,
      "debug": false,
      "hideRooms": [],
      "encodeMac": false
    }
  ]
}
```

| Field | Required | Default | Meaning |
|---|---|---|---|
| `email` | yes | | LK account email |
| `password` | yes | | LK account password. Stored in `config.json` like any Homebridge secret. Never written to the log. |
| `pollIntervalMinutes` | no | `5` | Poll period. Values below 1 are raised to 1. |
| `debug` | no | `false` | Also print each HTTP line at info level. |
| `hideRooms` | no | empty | Room names or MAC addresses to leave out of HomeKit. |
| `encodeMac` | no | `false` | Leave this off unless a call fails because of the colon in the MAC. See troubleshooting. |

`encodeMac: false` sends the MAC the way the Home Assistant integration does (`AA:BB:CC:DD:EE:01`). `true` applies `encodeURIComponent` to that one path segment. The choice lives in `formatMacForPath`.

## Debug

Either is enough; both together just duplicate lines.

- Plugin flag: `"debug": true`. Request lines are written with the normal logger so you can see them without Homebridge debug mode.
- Homebridge debug: `homebridge -D`, or the Debug switch in the Homebridge UI (it restarts the service with `-D`). The plugin always sends those lines to `log.debug`.

A request line looks like:

```text
GET service/arc/hub/ARCHUB000123/structure/false -> 200 (180ms)
```

Setpoint changes and the discovery summary are logged at info even when debug is off.

## Troubleshooting

| What you see | What to try |
|---|---|
| Login fails | Check the email and password in the LK app. A 401 on `auth/auth/login` means the cloud rejected those credentials. Confirm the Pi can reach `https://link2.lk.nu/`. |
| No rooms found | The account's user structure has no `arc-sense` / `arc-tune` sensor with a non-null `desiredTemperature`. Cubic detectors and the hub itself are ignored on purpose. Turn on debug and look for `Discovered 0 room(s)`. |
| 429 rate limit | The cloud asked us to slow down. The plugin honours `Retry-After` (or waits 5 seconds) up to three times, then backs off the poll, up to 30 minutes. Raise `pollIntervalMinutes`. Do not run several bridges against the same public IP if you can avoid it. |
| Values not updating | Leave debug on for one poll. A warning that ends with "Keeping last known values" means the last good reading is still on the accessory. Hub structure failures fall back to a per-sensor read. |
| Setpoint not applied | Compare the Home app with the LK app after ~10 seconds (the write is debounced 1.5 seconds, then one refresh runs). The plugin does not POST when the rounded value already matches the cloud. A 400 in the log is the cloud rejecting the body. |
| MAC encoding | If measurement or setpoint URLs fail and the path contains a raw colon, set `"encodeMac": true` and restart. Turn it back off if the encoded form is what fails. |
| Plugin missing in the UI | `npm run build` must have produced `dist/index.js`, and Homebridge must have been restarted after `npm install` of that directory. |

## Known unknowns

These are copied from the API notes. Nothing here was checked against a live LK account while building 0.1.0. The fixtures under `test/fixtures/` are synthetic.

1. `auth/auth/refresh` was never called by the Home Assistant library. The body and response shape are from LK's OpenAPI only. The units of `accessTokenExpire` / `refreshTokenExpire` are not documented. This plugin decides expiry from the JWT `exp` claim (unix seconds) and, when fewer than five minutes remain, tries refresh and otherwise logs in again.
2. The 5.0–30.0 °C range and 0.5 °C step are the Home Assistant client's limits. No setpoint min/max comes back from the API.
3. `currentBattery` is assumed to be percent. `connectionState` has no documented enum; only a few clearly negative strings raise a fault. The meaning of `actuators`, `overrideActive`, and `overrideLevel` is unknown, and they are not shown in HomeKit.
4. The `ocp-apim-subscription-key` is the public key shipped in the Home Assistant integration. It is not an account password. Whether LK expects other clients to keep using it is unverified.
5. Exact rate limits are unpublished. The Home Assistant author was told the limit is per source IP and differs per endpoint.
6. Whether the MAC in the path must be URL-encoded is unverified. The default matches the library and sends the colon form. `encodeMac` switches it.
7. `service/devices/device/{id}/title` is referenced by the library and was not in the fetched OpenAPI dump. This plugin does not call it.
8. Real response values were not captured from a live account. Field names follow the OpenAPI schemas and the library; the JSON files used in tests are synthetic.

## Development

```bash
npm ci
npm run lint
npm run build
npm test
```

Tests use the synthetic fixtures and never call LK. CI runs lint, `tsc`, and the tests on Node 20 and 22. There is no publish job.

## License

MIT. Copyright (c) 2026 Mats Guldbrand.

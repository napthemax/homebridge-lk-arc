# Changelog

## 0.1.1

- Publish the LK zone name on the thermostat (Name and ConfiguredName) so the Home app shows it while pairing and on iOS 16 and later.
- Keep a rename made in the Home app until the zone name changes in LK. That rename is not written back to LK.
- Name the optional battery and humidity services `<room> Battery` and `<room> Humidity`. The thermostat still reports humidity as well.

## 0.1.0

First version.

- Homebridge dynamic platform `LkArc` that exposes each LK Systems Arc floor-heating room as a HomeKit thermostat.
- Signs in to `https://link2.lk.nu/`, renews the access token from its JWT expiry, and retries a data call once after a 401.
- Discovers hubs and room sensors from the user structure, then reads measurements from each hub structure with a per-sensor fallback.
- Writes setpoints in tenths of a degree, debounced, clamped to 5–30 °C and rounded to 0.5 °C. A stale cached read just after a write does not snap the HomeKit target back.

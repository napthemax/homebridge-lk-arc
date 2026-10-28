# Sunday test — first run on the real LK system

Use this the first time the plugin talks to a real account. Do it from a machine that is allowed to reach `https://link2.lk.nu/` (the Homebridge host, often a Raspberry Pi).

No production publish is required. Install from a local checkout as described in the README (`npm ci`, `npm run build`, then `npm install /absolute/path/to/homebridge-lk-arc` in the Homebridge directory).

## Before you start

1. Confirm the LK app shows the rooms you expect, with names and temperatures you can compare.
2. In the Homebridge config, set the LK email and password, `"pollIntervalMinutes": 5`, and `"debug": true`. Leave `"encodeMac": false`.
3. Restart Homebridge with debug as well (`homebridge -D`, or the Debug switch in the UI) so both log paths are covered.
4. Watch the log from startup. Do not paste passwords or tokens into chat; the plugin masks them, but glance at the excerpt before you copy it anywhere.

## Checklist

- [ ] **Login works.** Within the first poll you see `Logged in to the LK cloud` and no `auth/auth/login failed with 401`. If login fails, stop and check the account in the LK app before doing anything else.
- [ ] **User and structure calls succeed.** Debug lines include `GET auth/auth/user -> 200` and `GET service/users/user/<id>/structure/false -> 200`.
- [ ] **Every room appears, with the LK app's name.** The info line looks like `Discovered N room(s) on M hub(s): ...`. The hub and any Cubic detectors must not show up as thermostats. A room with no setpoint in the cloud is skipped on purpose.
- [ ] **Temperatures match the LK app.** For each room, current temperature, target temperature, and (if the app shows it) humidity should match after dividing the raw cloud values by 10. A difference of one decimal that lines up with that scaling is expected; a difference of several degrees is not.
- [ ] **Change a setpoint in the Home app.** Move one room by at least 0.5 °C. Within a couple of seconds the log should say `Setpoint for <room> set to X°C`. The POST path is `control/arc/sense/<mac>/temperature` and the status is 200, 201, or 204.
- [ ] **The LK app agrees.** Open that room in the LK app and confirm the new target. The valve may take longer; the setpoint should match.
- [ ] **0.5 °C steps and limits.** The Home slider should move in 0.5 °C steps and should not offer a target below 5 °C or above 30 °C. Setting the same temperature again should not produce another POST (`unchanged` in the debug log).
- [ ] **Leave it running for about an hour.** With a 5 minute poll you want roughly a dozen polls and no repeated 429s. A single 429 that is followed by a successful retry is worth noting but is not an automatic failure. You should not see the poll backoff climb toward 30 minutes.
- [ ] **Token renewal does not log you out.** If the access token's expiry gets inside five minutes during the hour, the log should show a refresh (`auth/auth/refresh`) or, if that fails, another login, and later polls should still return 200. There must be no password or token string in the log.
- [ ] **Battery and humidity look plausible.** Battery should be a percent (0–100), not a huge integer. Humidity should look like a percent (the raw value divided by 10), in line with the LK app if it shows one. A room the cloud marks offline may show a fault; treat the exact `connectionState` text as unverified and write down the raw value if you see one.

## If something fails, copy these logs

Turn debug on, reproduce the failure once, and copy from process start through the error. Include:

- The discovery summary (`Discovered ...`).
- Every line that contains `->` (method, path, status, duration).
- Any `Poll failed`, `429`, `401`, `Setpoint`, or `Keeping last known values` line.
- What the Home app showed and what the LK app showed for the same room at the same time.
- Whether `encodeMac` was true or false.

Redact the email if you do not want to share it. Confirm the file does not contain the password, `accessToken`, or `refreshToken` before sending it. The synthetic fixtures in `test/fixtures/` are not a substitute for this log; they were never captured from a live home.

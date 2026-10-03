# Changelog

All notable changes to this plugin. Versions follow semver; the registry in `mchacher/sowel` carries the SHA256 of each released tarball.

## v0.2.0

**The dé charger is a Sowel EV charger.** The vehicle state, the charging current and the session energy are published under the categories of Sowel's new `ev_charger` equipment type (core spec 182), so Sowel recognises the charger and binds it on its own. The current order's range comes from the charger (DP 152).

- **Start/stop from Sowel's buttons**: the order declares its wire values, and the plugin accepts `ON`/`OFF` too.
- **Fixed on the hardware**: stopping an already stopped charger no longer times out (the charger does not answer a write that changes nothing); restarting a charge the car then declines to draw is reported as done, since the charger obeyed.

## v0.1.0

First release. **The dé portable EV charger (3.7 kW, 6-16 A, two buttons) in Sowel, over the local network, no cloud at runtime** — spec 001, walked end to end on a real charger (firmware 1.9.13).

- **What you get**: a device with its status, whether a car is plugged in and drawing, live power (republished with every new measurement, so the energy arbiter always sees it fresh), energy history as Wh increments from the charger's own meter, session counters, and three orders: start/stop, charging current from 6 A to the charger's maximum, and what to do when a cable is plugged in. Every order is confirmed against the charger before it completes.
- **Setup**: IP address, Tuya device id and local key — see the README (iot.tuya.com or `tinytuya wizard`, plus a DHCP reservation). One device per installation for now.
- **The charger's quirks, handled**: the start/stop data point is never reported back, so it is confirmed by the charging state; measurements are pushed about once a minute and a status read does not refresh them; on protocol 3.5, `tuyapi` stops resolving status reads after a write.
- **Capture tool** (`dist/tools/capture.js`) to record a Tuya device's raw data points, for adding a product.

## v0.0.0

- Repository scaffold: plugin skeleton, CI, release workflow, hooks, skills.

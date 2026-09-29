# Sowel plugin: tuya

Tuya devices for [Sowel](https://docs.sowel.org), over the **local network**: the plugin talks to each device's local socket with its `local_key`, with no cloud at runtime, and publishes it as an ordinary Sowel device — readings and orders you bind to equipments.

A Tuya device's data points are product-specific, so support grows **one product profile at a time**, each specified and tested against the real device.

## Supported products

| Product                                   | Profile    | Status             |
| ----------------------------------------- | ---------- | ------------------ |
| dé portable EV charger 3.5 kW (2 buttons) | `depow_v2` | Planned (spec 001) |

The DP map of the dé charger comes from the reverse-engineering work in [lachand/EV_charger](https://github.com/lachand/EV_charger) (Home Assistant). Thanks to its author.

## Status

Skeleton: the plugin starts, stops and reports its status. The transport and the first profile arrive with spec 001.

## Development

```bash
npm install
npm run validate        # typecheck, lint, format, tests, build, specs index — what CI runs
npm run dev             # tsc --watch
```

Install on a Sowel instance through a personal source (core spec 136), or copy `manifest.json`, `package.json`, `dist/` and `node_modules/` into `plugins/tuya/`.

Releases: tag `vX.Y.Z` on main; the workflow publishes `sowel-plugin-tuya-X.Y.Z.tar.gz`. The registry in `mchacher/sowel` must then be bumped with the tarball's SHA256 (spec 089).

## License

AGPL-3.0, like Sowel.

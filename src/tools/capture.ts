/**
 * Capture a Tuya device's raw DPs, to pin a profile's fixtures on real
 * payloads (spec 001 FR-17).
 *
 *   TUYA_LOCAL_KEY=… node dist/tools/capture.js --host 192.168.1.50 --id <device_id> \
 *     [--version 3.5] [--label charging] [--every 10] > capture.jsonl
 *
 * The key is read from the environment, never from the command line (shell
 * history). Output is one JSON line per snapshot on stdout; review it, replace
 * the device id if it appears, and copy it under src/profiles/__fixtures__/.
 * Stop the plugin (or the Smart Life app) first: the device takes one local client.
 */

import { describeError } from "../transport/transport.js";
import { TuyapiTransport } from "../transport/tuyapi-transport.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const host = arg("host");
  const deviceId = arg("id");
  const localKey = process.env.TUYA_LOCAL_KEY ?? "";
  const protocolVersion = arg("version", "3.5") as string;
  const label = arg("label", "capture") as string;
  const everyS = Math.max(2, Number(arg("every", "10")) || 10);

  if (!host || !deviceId || !localKey) {
    console.error(
      "Usage: TUYA_LOCAL_KEY=<key> node dist/tools/capture.js --host <ip> --id <device_id> [--version 3.5] [--label <state>] [--every <s>]",
    );
    process.exit(2);
  }

  const transport = new TuyapiTransport({ host, deviceId, localKey, protocolVersion });
  transport.onError((err) => console.error(`error: ${describeError(err, localKey)}`));
  transport.onDps((dps) =>
    console.log(JSON.stringify({ at: new Date().toISOString(), label, push: true, dps })),
  );

  const timers: ReturnType<typeof setInterval>[] = [];
  process.on("SIGINT", () => {
    timers.forEach(clearInterval);
    transport.disconnect();
    process.exit(0);
  });

  await transport.connect();
  console.error(`connected to ${host}, one snapshot every ${everyS} s, Ctrl-C to stop`);

  const snapshot = async (): Promise<void> => {
    try {
      const dps = await transport.getAll();
      console.log(JSON.stringify({ at: new Date().toISOString(), label, dps }));
    } catch (err) {
      console.error(`read failed: ${describeError(err, localKey)}`);
    }
  };
  await snapshot();
  timers.push(setInterval(() => void snapshot(), everyS * 1000));
}

main().catch((err: unknown) => {
  console.error(`capture failed: ${describeError(err, process.env.TUYA_LOCAL_KEY)}`);
  process.exit(1);
});

import { readFileSync } from "node:fs";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const models = readFileSync(new URL("../src/models.ts", import.meta.url), "utf8");
const settings = readFileSync(new URL("../src/settings-tab.ts", import.meta.url), "utf8");
const wsClient = readFileSync(new URL("../src/ws-client.ts", import.meta.url), "utf8");

const checks = [
  [main.includes("secretStorage.setSecret(this.settings.deviceTokenSecretId, result.deviceToken)"), "binding token is written to SecretStorage"],
  [main.includes("delete persisted.deviceToken"), "plain-text token is removed from persisted settings"],
  [main.includes("secretStorage.getSecret(this.settings.deviceTokenSecretId)"), "stored token is restored from SecretStorage"],
  [models.includes('deviceTokenSecretId: "wechat-link-sync-device-token"'), "plugin-specific SecretStorage key is configured"],
  [settings.includes("********"), "settings mask the bound token"],
  [wsClient.includes("WS_CLOSE.connectionReplaced"), "WebSocket replacement close code is handled"],
  [wsClient.includes("WS_CLOSE.rateLimited"), "WebSocket rate-limit close code is handled"]
];

const failures = checks.filter(([passed]) => !passed);
if (failures.length) {
  for (const [, message] of failures) console.error(`Security contract failed: ${message}`);
  process.exit(1);
}

console.log(`Security contract passed (${checks.length} checks).`);

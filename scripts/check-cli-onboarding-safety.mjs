#!/usr/bin/env node
import { readFileSync } from "node:fs";

const failures = [];
const cliPkg = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
const sdkPkg = JSON.parse(readFileSync("packages/sdk/package.json", "utf8"));
const cliSource = readFileSync("packages/cli/src/cli.ts", "utf8");

if (cliPkg.version !== sdkPkg.version) {
  failures.push(`@repnet/cli version ${cliPkg.version} must match @repnet/sdk version ${sdkPkg.version} for reviewer installs`);
}

const sdkRange = cliPkg.dependencies?.["@repnet/sdk"];
if (sdkRange !== `^${sdkPkg.version}`) {
  failures.push(`@repnet/cli depends on @repnet/sdk ${sdkRange}; expected ^${sdkPkg.version}`);
}

if (!cliSource.includes("fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 })")) {
  failures.push("repnet setup must write ~/.repnet/config.json with mode 0600 because it stores a private key");
}

if (failures.length) {
  console.error("CLI onboarding safety check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("CLI onboarding safety check passed.");

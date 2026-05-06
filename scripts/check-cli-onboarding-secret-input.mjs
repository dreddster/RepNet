#!/usr/bin/env node
import { readFileSync } from "node:fs";

const source = readFileSync("packages/cli/src/onboard.ts", "utf8");
const askSecretStart = source.indexOf("function askSecret(question: string): Promise<string>");
const askSecretEnd = source.indexOf("async function confirm", askSecretStart);
const askSecret = source.slice(askSecretStart, askSecretEnd);

const failures = [];

if (!askSecret.includes('for (const c of ch.toString("utf8"))')) {
  failures.push("askSecret must iterate over every character in a data chunk; pasted/private-key PTY input can arrive as one chunk");
}

if (askSecret.includes('const c = ch.toString("utf8");\n      if (c === "\\n"')) {
  failures.push("askSecret still compares a whole data chunk with newline; this breaks pasted keys");
}

if (!askSecret.includes("finish();") || !askSecret.includes("stdin.removeListener")) {
  failures.push("askSecret must restore raw mode and remove its data listener exactly once on newline");
}

if (failures.length) {
  console.error("CLI secret-input check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("CLI secret-input check passed.");

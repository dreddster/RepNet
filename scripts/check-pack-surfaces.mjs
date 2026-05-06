#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const checks = [
  {
    label: "eliza",
    workspace: "@repnet/plugin-eliza",
    forbidden: [/^dist\/(actions|providers|services)(\/|\.)/],
    required: [/^dist\/index\.js$/, /^dist\/index\.d\.ts$/],
  },
  {
    label: "agentkit",
    workspace: "@repnet/agentkit-plugin",
    forbidden: [/^dist\/(abi|constants|schemas)(\/|\.)/],
    required: [/^dist\/repnetActionProvider\.js$/, /^dist\/repnetActionProvider\.d\.ts$/],
  },
  {
    label: "sdk",
    workspace: "@repnet/sdk",
    forbidden: [],
    required: [/^dist\/actions\.js$/, /^dist\/actions\.d\.ts$/],
  },
];

function packFiles(workspace) {
  const output = execFileSync(
    "npm",
    ["pack", "--workspace", workspace, "--dry-run", "--json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const [pack] = JSON.parse(output);
  return (pack.files ?? []).map((file) => file.path).sort();
}

let failed = false;

for (const check of checks) {
  const files = packFiles(check.workspace);
  const forbiddenMatches = files.filter((file) =>
    check.forbidden.some((pattern) => pattern.test(file)),
  );
  const missingRequired = check.required.filter(
    (pattern) => !files.some((file) => pattern.test(file)),
  );

  console.log(JSON.stringify({
    name: check.label,
    workspace: check.workspace,
    fileCount: files.length,
    forbiddenMatches,
    missingRequired: missingRequired.map(String),
  }));

  if (forbiddenMatches.length > 0 || missingRequired.length > 0) {
    failed = true;
  }
}

if (failed) {
  console.error("Pack surface check failed");
  process.exit(1);
}

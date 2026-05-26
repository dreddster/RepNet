#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const keep = process.argv.includes("--keep");
const base = mkdtempSync(join(homedir(), "repnet-release-smoke."));
const packDir = join(base, "packs");
const appDir = join(base, "app");
const publishable = [
  "@repnet/sdk",
  "@repnet/mcp-server",
  "@repnet/vercel-ai",
  "@repnet/cli",
  "@repnet/signer",
  "@repnet/agentkit-plugin",
  "@repnet/plugin-eliza",
];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function log(title) {
  console.log(`\n== ${title} ==`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  log("build publishable packages");
  run("npm", ["run", "build:core"], { stdio: "inherit" });
  run("npm", ["run", "build:agentkit"], { stdio: "inherit" });
  run("npm", ["run", "build:eliza"], { stdio: "inherit" });

  run("mkdir", ["-p", packDir, appDir]);

  const tarballs = [];
  for (const workspace of publishable) {
    log(`npm pack ${workspace}`);
    const output = run("npm", ["pack", "--workspace", workspace, "--pack-destination", packDir, "--json"]);
    const pack = JSON.parse(output)[0];
    const tarball = join(packDir, pack.filename);
    assert(existsSync(tarball), `${workspace}: expected tarball missing at ${tarball}`);
    tarballs.push(tarball);
    console.log(JSON.stringify({ name: pack.name, version: pack.version, fileCount: pack.files.length, filename: pack.filename }));
  }

  log("install tarballs into fresh app");
  run("npm", ["init", "-y"], { cwd: appDir });
  // Do not use --legacy-peer-deps: adapters must be tested with their framework peers resolved.
  run("npm", ["install", ...tarballs], { cwd: appDir, stdio: "inherit" });

  log("import package entrypoints");
  const importScript = `
    const packages = ${JSON.stringify(["@repnet/sdk", "@repnet/vercel-ai", "@repnet/agentkit-plugin", "@repnet/plugin-eliza"])};
    for (const pkg of packages) {
      const mod = await import(pkg);
      console.log(pkg, Object.keys(mod).sort().join(","));
    }
  `;
  run("node", ["--input-type=module", "-e", importScript], { cwd: appDir, stdio: "inherit" });

  log("verify CLI, signer, and MCP bins");
  const repnetBin = join(appDir, "node_modules/.bin/repnet");
  const signerBin = join(appDir, "node_modules/.bin/repnet-signer");
  const mcpBin = join(appDir, "node_modules/.bin/repnet-mcp");
  for (const bin of [repnetBin, signerBin, mcpBin]) {
    assert((statSync(bin).mode & 0o111) !== 0, `${basename(bin)} is not executable`);
  }
  const help = run(repnetBin, ["help"], { cwd: appDir });
  assert(help.includes("RepNet CLI"), "repnet help did not print CLI help");
  console.log(help.split(/\r?\n/).slice(0, 12).join("\n"));
  const signerHelp = run(signerBin, ["--help"], { cwd: appDir });
  assert(signerHelp.includes("@repnet/signer"), "repnet-signer --help did not print signer help");
  assert(signerHelp.includes("--allowed-contracts"), "repnet-signer help omitted contract allowlist option");
  console.log(signerHelp.split(/\r?\n/).slice(0, 12).join("\n"));

  const mcp = spawnSync(mcpBin, [], {
    cwd: appDir,
    env: {
      ...process.env,
      REPNET_PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
      REPNET_CHAIN_ID: "84532",
    },
    encoding: "utf8",
    timeout: 2500,
  });
  const mcpOutput = `${mcp.stdout ?? ""}\n${mcp.stderr ?? ""}`;
  assert(
    mcp.status === 0 || mcp.signal === "SIGTERM" || mcp.error?.code === "ETIMEDOUT" || mcpOutput.includes("RepNet MCP Server running on stdio"),
    `repnet-mcp failed unexpectedly: ${mcpOutput}`
  );
  assert(!mcpOutput.includes("MODULE_NOT_FOUND"), `repnet-mcp has missing runtime module: ${mcpOutput}`);
  console.log("repnet-mcp startup smoke passed");

  log("scan installed adapter surfaces");
  const scanScript = `
    const fs = require("fs");
    const checks = [
      ["@repnet/agentkit-plugin", ["dist/abi", "dist/constants", "dist/schemas"]],
      ["@repnet/plugin-eliza", ["dist/actions", "dist/providers", "dist/services"]],
    ];
    for (const [pkg, forbidden] of checks) {
      const root = "node_modules/" + pkg;
      const files = [];
      function walk(dir) {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = dir + "/" + ent.name;
          if (ent.isDirectory()) walk(p); else files.push(p.slice(root.length + 1));
        }
      }
      walk(root);
      const hits = files.filter((file) => forbidden.some((prefix) => file.startsWith(prefix)));
      console.log(pkg, JSON.stringify({ fileCount: files.length, forbiddenHits: hits }));
      if (hits.length) process.exitCode = 1;
    }
  `;
  run("node", ["-e", scanScript], { cwd: appDir, stdio: "inherit" });

  console.log(`\nRelease dry-run smoke passed: ${base}`);
} finally {
  if (!keep) rmSync(base, { recursive: true, force: true });
}

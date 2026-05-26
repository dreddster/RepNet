#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const publishable = [
  { workspace: "@repnet/sdk", dir: "packages/sdk", requireReadme: true, requiredFiles: ["dist/index.js", "dist/index.d.ts", "dist/actions.js", "dist/actions.d.ts"] },
  { workspace: "@repnet/mcp-server", dir: "packages/mcp-server", requireReadme: true, bin: "repnet-mcp", requiredFiles: ["dist/server.js"] },
  { workspace: "@repnet/vercel-ai", dir: "packages/vercel-ai", requireReadme: true, requiredFiles: ["dist/index.js", "dist/index.d.ts"] },
  { workspace: "@repnet/cli", dir: "packages/cli", requireReadme: true, bin: "repnet", requiredFiles: ["dist/cli.js"] },
  { workspace: "@repnet/signer", dir: "packages/signer", requireReadme: true, bin: "repnet-signer", requiredFiles: ["dist/cli.js", "dist/index.js", "dist/index.d.ts"] },
  { workspace: "@repnet/agentkit-plugin", dir: "packages/agentkit-plugin", requireReadme: true, requiredFiles: ["dist/index.js", "dist/index.d.ts"] },
  { workspace: "@repnet/plugin-eliza", dir: "packages/plugin-eliza", requireReadme: true, requiredFiles: ["dist/index.js", "dist/index.d.ts"] },
];

const failures = [];
const packageSummaries = [];

function parsePack(workspace) {
  const output = execFileSync("npm", ["pack", "--workspace", workspace, "--dry-run", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output)[0];
}

for (const pkg of publishable) {
  const manifestPath = resolve(pkg.dir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  if (manifest.private) failures.push(`${pkg.workspace}: publishable package is marked private`);
  if (manifest.license !== "MIT") failures.push(`${pkg.workspace}: license must be MIT`);
  if (manifest.publishConfig?.access !== "public") failures.push(`${pkg.workspace}: missing publishConfig.access=public`);
  if (!manifest.repository?.url || !manifest.repository?.directory) failures.push(`${pkg.workspace}: missing repository url/directory metadata`);
  if (!manifest.homepage) failures.push(`${pkg.workspace}: missing homepage metadata`);
  if (!Array.isArray(manifest.keywords) || manifest.keywords.length === 0) failures.push(`${pkg.workspace}: missing keywords`);

  if (pkg.bin) {
    const binPath = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[pkg.bin];
    if (!binPath) {
      failures.push(`${pkg.workspace}: missing bin ${pkg.bin}`);
    } else {
      const sourceBin = resolve(pkg.dir, binPath);
      try {
        const firstLine = readFileSync(sourceBin, "utf8").split(/\r?\n/, 1)[0];
        if (firstLine !== "#!/usr/bin/env node") failures.push(`${pkg.workspace}: ${binPath} missing node shebang`);
        if ((statSync(sourceBin).mode & 0o111) === 0) failures.push(`${pkg.workspace}: ${binPath} is not executable`);
      } catch {
        failures.push(`${pkg.workspace}: bin target ${binPath} missing before pack`);
      }
    }
  }

  const pack = parsePack(pkg.workspace);
  const files = new Set(pack.files.map((file) => file.path));
  for (const required of pkg.requiredFiles || []) {
    if (!files.has(required)) failures.push(`${pkg.workspace}: tarball missing ${required}`);
  }
  if (pkg.requireReadme && !files.has("README.md")) failures.push(`${pkg.workspace}: tarball missing README.md`);
  if (!files.has("package.json")) failures.push(`${pkg.workspace}: tarball missing package.json`);

  packageSummaries.push({
    name: pack.name,
    version: pack.version,
    fileCount: pack.files.length,
    hasReadme: files.has("README.md"),
    bin: pkg.bin ?? null,
  });
}

for (const summary of packageSummaries) console.log(JSON.stringify(summary));

if (failures.length > 0) {
  console.error("Release readiness check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Release readiness check passed.");

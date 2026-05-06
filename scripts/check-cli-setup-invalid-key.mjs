#!/usr/bin/env node
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'repnet-cli-invalid-key-'));
const home = join(root, 'home');
const bin = resolve('packages/cli/dist/cli.js');

try {
  const result = spawnSync(process.execPath, [bin, 'setup', 'not-a-private-key'], {
    cwd: resolve('.'),
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });

  if (result.status === 0) {
    throw new Error('repnet setup accepted an invalid private key');
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (!/invalid private key/i.test(output)) {
    throw new Error(`Expected a clear invalid private key error, got:\n${output}`);
  }

  const configPath = join(home, '.repnet', 'config.json');
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (config.privateKey) {
      throw new Error('repnet setup persisted an invalid private key to config');
    }
  }

  console.log('CLI invalid-key setup check passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}

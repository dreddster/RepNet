#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const source = readFileSync('packages/cli/src/onboard.ts', 'utf8');

if (!source.includes('function formatOnboardingError(')) {
  throw new Error('onboarding must format provider/ethers errors before printing them');
}

if (!source.includes('INSUFFICIENT_FUNDS') || !source.includes('Insufficient ETH for gas')) {
  throw new Error('onboarding must map insufficient-funds errors to a short actionable message');
}

if (/Registration failed:\s*\$\{e\.message\}/.test(source)) {
  throw new Error('registration catch must not print raw ethers error messages with signed transaction payloads');
}

console.log('CLI onboarding error-format check passed.');

/**
 * @repnet/signer — RepNet Signing Sidecar
 *
 * Use as CLI:
 *   npx @repnet/signer --key 0xabc...
 *
 * Use as library (embed in your app):
 *   import { RepNetSigner, createServer } from '@repnet/signer';
 *   const signer = new RepNetSigner({ privateKey: '0x...', port: 4001, host: '127.0.0.1', maxChallengeAgeSec: 300, logLevel: 'info' });
 *   const response = await signer.sign(challenge);
 */
export { RepNetSigner } from './signer.js';
export { createServer } from './server.js';
export type { SigningChallenge, SigningResponse, SignerConfig } from './types.js';

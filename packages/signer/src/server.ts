import Fastify from 'fastify';
import type { SigningChallenge } from './types.js';
import { RepNetSigner } from './signer.js';
import type { SignerConfig } from './types.js';

/**
 * HTTP server that exposes the signer as a webhook endpoint.
 * Gateway POSTs signing challenges here, gets back signatures.
 */
export async function createServer(config: SignerConfig) {
  const signer = new RepNetSigner(config);

  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss' },
      },
    },
  });

  // Health check
  app.get('/health', async () => ({
    ok: true,
    signer: signer.address,
    uptime: process.uptime(),
  }));

  // Signer info (public, no secrets)
  app.get('/info', async () => ({
    ok: true,
    ...signer.info(),
  }));

  // The main endpoint: receive signing challenges
  app.post<{ Body: SigningChallenge }>('/sign', async (request, reply) => {
    const challenge = request.body;

    // Basic validation
    if (!challenge || !challenge.challengeId) {
      return reply.status(400).send({
        ok: false,
        error: 'Missing challengeId in request body',
      });
    }

    const response = await signer.sign(challenge);

    if (response.rejected) {
      request.log.warn({ challengeId: challenge.challengeId, reason: response.rejectionReason }, 'Challenge rejected');
      return reply.status(403).send({ ok: false, ...response });
    }

    request.log.info({ challengeId: challenge.challengeId, operation: challenge.operation }, 'Challenge signed');
    return { ok: true, ...response };
  });

  // Register with gateway (optional — tells the gateway where to send challenges)
  if (config.gatewayUrl) {
    app.addHook('onReady', async () => {
      try {
        const registerUrl = `${config.gatewayUrl}/signers/register`;
        const res = await fetch(registerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            signerAddress: signer.address,
            webhookUrl: `http://${config.host}:${config.port}/sign`,
            allowedOperations: config.allowedOperations || [],
          }),
        });
        if (res.ok) {
          app.log.info({ gateway: config.gatewayUrl }, 'Registered with gateway');
        } else {
          app.log.warn({ gateway: config.gatewayUrl, status: res.status }, 'Gateway registration failed (non-critical)');
        }
      } catch (err) {
        app.log.warn({ gateway: config.gatewayUrl }, 'Gateway registration failed (non-critical, gateway may not support it yet)');
      }
    });
  }

  await app.listen({ port: config.port, host: config.host });
  return app;
}

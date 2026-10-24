import type { FastifyInstance } from 'fastify';
import { describeRateLimits } from '../lib/ratelimit';

/** Public, cacheable description of the rate limits so bots and SDKs can plan their traffic (every response also carries X-RateLimit-* headers). */
export function rateLimitDocRoutes(app: FastifyInstance) {
  app.get('/rate-limits', async (_req, reply) => reply.header('cache-control', 'public, max-age=300').send(describeRateLimits()));
}

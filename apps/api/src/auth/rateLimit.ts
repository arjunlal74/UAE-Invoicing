import { logger } from '../logger.js';
import { redis } from '../queue/queues.js';

/**
 * Fixed-window request limiting, in Redis.
 *
 * SRS v2.3 §4.1 caps password-reset requests per IP *and* per address. Redis
 * rather than a table because the counters are worthless an hour later and
 * writing them to Postgres would put a row-per-attempt load on the database for
 * data nobody will read.
 *
 * Deliberately fails open. If Redis is unreachable the platform should still
 * let people recover their accounts; the cost of the alternative is a total
 * lockout of password recovery during a cache outage, which is worse than a
 * temporarily unenforced cap on a flow that is itself rate-limited by having to
 * receive an e-mail.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets, for the caller to log or surface. */
  resetInSeconds: number;
}

export async function consumeRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const namespaced = `ratelimit:${key}`;

  try {
    const client = redis();
    const count = await client.incr(namespaced);

    // Only the request that created the key sets the expiry, so a burst cannot
    // keep pushing the window out and effectively disable the limit.
    if (count === 1) await client.expire(namespaced, windowSeconds);

    const ttl = await client.ttl(namespaced);
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetInSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  } catch (err) {
    logger.warn({ err, key }, 'rate limit check failed; allowing the request');
    return { allowed: true, remaining: limit, resetInSeconds: windowSeconds };
  }
}

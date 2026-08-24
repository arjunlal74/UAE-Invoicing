import { z } from 'zod';
import { loadEnv } from './env.js';

/**
 * Environment configuration, validated once at boot.
 *
 * Failing fast on a missing secret is deliberate: a system that silently starts
 * with an undefined encryption key would happily write unrecoverable ASP
 * credentials for weeks before anyone noticed.
 */

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  API_PORT: z.coerce.number().int().default(3000),
  // The address this system uses to reach its own API. Differs from the public
  // one whenever a proxy or container network sits in between; the simulated
  // provider posts its callback here so it never has to leave the deployment.
  API_INTERNAL_URL: z.string().optional(),
  API_PUBLIC_URL: z.string().default('http://localhost:3000'),
  PORTAL_ORIGIN: z.string().default('http://localhost:5173'),

  DATABASE_URL: z.string().min(1),
  DATABASE_APP_URL: z.string().optional(),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('me-central-1'),
  S3_BUCKET: z.string().default('uae-einvoice-archive'),
  S3_ACCESS_KEY_ID: z.string().default('minioadmin'),
  S3_SECRET_ACCESS_KEY: z.string().default('minioadmin'),
  S3_FORCE_PATH_STYLE: bool.default('true'),
  S3_RETENTION_YEARS: z.coerce.number().int().min(1).default(5),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL: z.coerce.number().int().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().default(2_592_000),
  MFA_ISSUER: z.string().default('UAE E-Invoicing'),

  // Substituted into the transactional templates of SRS v2.3 §5, which are
  // written with [Middleware Platform Name] and [Support Email] placeholders
  // precisely so a white-label deployment can put its own name on them.
  PLATFORM_NAME: z.string().default('UAE E-Invoicing Portal'),
  SUPPORT_EMAIL: z.string().default('support@einvoice.local'),
  SUPPORT_PHONE: z.string().default(''),

  SECRETS_ENCRYPTION_KEY: z.string().min(1),

  ASP_DEFAULT_DRIVER: z.enum(['MOCK', 'GENERIC_REST', 'NATIVE_AS4']).default('MOCK'),
  ASP_MOCK_REJECT_RATE: z.coerce.number().min(0).max(1).default(0.15),
  ASP_MOCK_LATENCY_MS: z.coerce.number().int().min(0).default(1200),

  UPLOAD_MAX_BYTES: z.coerce.number().int().default(52_428_800),
  UPLOAD_MAX_ROWS: z.coerce.number().int().default(20_000),
});

function load() {
  // Done here rather than in each entrypoint so that any code path reaching
  // config() — server, worker, migrations, seed, tests — sees the same values.
  loadEnv();

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  const key = Buffer.from(env.SECRETS_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `SECRETS_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). Generate one with: openssl rand -base64 32`,
    );
  }

  if (env.NODE_ENV === 'production') {
    const placeholder = /dev_only|change_me|replace_me/i;

    // The encryption key is checked DECODED as well as raw. The shipped
    // placeholder is base64, so its text does not contain any of these markers
    // — a raw-only check would happily start production with a key that is
    // published in this repository.
    const suspects = [
      env.JWT_ACCESS_SECRET,
      env.JWT_REFRESH_SECRET,
      env.SECRETS_ENCRYPTION_KEY,
      key.toString('utf8'),
    ];

    if (suspects.some((value) => placeholder.test(value))) {
      throw new Error(
        'Refusing to start in production with development secrets still in place. Run: node scripts/generate-secrets.mjs',
      );
    }
  }

  return {
    ...env,
    /** Runtime connections use the non-owner role so RLS is actually enforced. */
    appDatabaseUrl: env.DATABASE_APP_URL || env.DATABASE_URL,
    internalApiUrl: env.API_INTERNAL_URL || `http://127.0.0.1:${env.API_PORT}`,
    secretsKey: key,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
  };
}

export type Config = ReturnType<typeof load>;

let cached: Config | null = null;

export function config(): Config {
  cached ??= load();
  return cached;
}

import {
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { config } from '../config.js';
import { sha256Hex } from '../lib/crypto.js';
import { logger } from '../logger.js';

/**
 * WORM archive.
 *
 * Everything with evidentiary value goes here and never comes back out for
 * modification: the merchant's original spreadsheet, the generated UBL XML,
 * and the signed clearance receipt. Object Lock in COMPLIANCE mode means not
 * even the account root can delete these before the retention period expires,
 * which is exactly what the UAE Tax Procedures Law requires and what makes the
 * archive worth anything in an audit.
 *
 * The bucket must be created WITH Object Lock enabled — it cannot be turned on
 * afterwards. See docker-compose.infra.yml (minio-init) for local setup.
 */

let client: S3Client | null = null;

function s3(): S3Client {
  if (!client) {
    const cfg = config();
    client = new S3Client({
      region: cfg.S3_REGION,
      endpoint: cfg.S3_ENDPOINT,
      forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: cfg.S3_ACCESS_KEY_ID,
        secretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

export type ArtefactKind = 'source' | 'xml' | 'receipt';

/**
 * Object keys are tenant-prefixed and date-partitioned so that an FTA audit
 * request for one merchant and period is a prefix listing rather than a scan.
 */
export function buildKey(
  tenantId: string,
  kind: ArtefactKind,
  identifier: string,
  extension: string,
  when = new Date(),
): string {
  const yyyy = when.getUTCFullYear();
  const mm = String(when.getUTCMonth() + 1).padStart(2, '0');
  const safe = identifier.replace(/[^A-Za-z0-9._-]/g, '_');
  return `tenants/${tenantId}/${kind}/${yyyy}/${mm}/${safe}.${extension}`;
}

export interface StoredObject {
  uri: string;
  key: string;
  sha256: string;
  size: number;
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
  metadata: Record<string, string> = {},
): Promise<StoredObject> {
  const cfg = config();
  const retainUntil = new Date();
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + cfg.S3_RETENTION_YEARS);

  await s3().send(
    new PutObjectCommand({
      Bucket: cfg.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: retainUntil,
      Metadata: metadata,
    }),
  );

  return {
    uri: `s3://${cfg.S3_BUCKET}/${key}`,
    key,
    sha256: sha256Hex(body),
    size: body.length,
  };
}

export async function getObject(key: string): Promise<Buffer> {
  const cfg = config();
  const result = await s3().send(new GetObjectCommand({ Bucket: cfg.S3_BUCKET, Key: key }));
  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Strip the `s3://bucket/` prefix from a stored URI. */
export function keyFromUri(uri: string): string {
  const match = /^s3:\/\/[^/]+\/(.+)$/.exec(uri);
  if (!match?.[1]) throw new Error(`Not an object storage URI: ${uri}`);
  return match[1];
}

export async function checkStorage(): Promise<boolean> {
  try {
    await s3().send(new HeadBucketCommand({ Bucket: config().S3_BUCKET }));
    return true;
  } catch (err) {
    logger.warn({ err }, 'object storage is not reachable');
    return false;
  }
}

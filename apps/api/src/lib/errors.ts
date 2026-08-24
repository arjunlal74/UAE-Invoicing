import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { logger } from '../logger.js';

/**
 * Application errors carry an HTTP status and a machine-readable code, so the
 * portal can branch on the code rather than parsing prose.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);

export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'UNPROCESSABLE', message, details);

export const tooManyRequests = (message = 'Too many attempts. Try again shortly.') =>
  new AppError(429, 'TOO_MANY_REQUESTS', message);

/**
 * SRS v2.3 §4.3: the account is held until a new password is set.
 *
 * Its own code rather than a plain 403 so the portal can tell "you may not do
 * this" apart from "you may not do anything yet" and open the rotation modal
 * instead of showing a permission error.
 */
export const rotationRequired = (
  message = 'You must set a new password before continuing.',
) => new AppError(403, 'PASSWORD_ROTATION_REQUIRED', message);

interface PgError {
  code?: string;
  constraint_name?: string;
  detail?: string;
}

/** Translate the database's own integrity errors into meaningful API responses. */
function fromPostgres(err: PgError): AppError | null {
  if (err.code === '23505') {
    // Unique violation. The invoice-number constraint is the one users hit, and
    // a generic "duplicate key" message would be useless to a finance user.
    if (err.constraint_name === 'uq_tenant_invoice_dir') {
      return conflict(
        'A document with this number already exists in this module. Filing it again would create a duplicate with the FTA.',
      );
    }
    if (err.constraint_name === 'uq_tenant_customer_code') {
      return conflict('That customer code is already in use.');
    }
    if (err.constraint_name === 'uq_tenant_customer_trn') {
      return conflict('A customer with that TRN is already in your directory.');
    }
    if (err.constraint_name === 'uq_tenant_supplier_code') {
      return conflict('That supplier code is already in use.');
    }
    if (err.constraint_name === 'uq_tenant_supplier_trn') {
      return conflict('A supplier with that TRN is already in your directory.');
    }
    if (err.constraint_name === 'uq_bundle_reference') {
      return conflict('That bundle reference is already in use for this tenant.');
    }
    if (err.constraint_name === 'uq_invoice_idempotency') {
      return conflict(
        'This document has already been ingested under the same idempotency key.',
      );
    }
    if (err.constraint_name === 'users_email_unique') {
      return conflict('An account with that email address already exists.');
    }
    if (err.constraint_name === 'tenants_company_code_key') {
      return conflict('That company code is already in use.');
    }
    if (err.constraint_name === 'tenants_trn_key') {
      return conflict('A tenant with that TRN already exists.');
    }
    if (err.constraint_name === 'tenant_asp_configs_one_active') {
      return conflict('This tenant already has an active ASP configuration.');
    }
    return conflict('That record already exists.');
  }

  if (err.code === '23503') return badRequest('Referenced record does not exist.');
  if (err.code === '23514') return badRequest('A value failed a database constraint.');
  // insufficient_privilege — almost always an RLS policy doing its job.
  if (err.code === '42501') return forbidden('You do not have access to that data.');

  return null;
}

export function registerErrorHandler(app: {
  setErrorHandler: (
    fn: (error: Error, request: FastifyRequest, reply: FastifyReply) => void,
  ) => void;
}) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request contains invalid values.',
          details: error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      });
      return;
    }

    if (error instanceof AppError) {
      // 4xx are expected outcomes, not incidents; log them quietly.
      if (error.statusCode >= 500) {
        logger.error({ err: error, url: request.url }, 'request failed');
      } else {
        logger.debug({ code: error.code, url: request.url }, error.message);
      }
      reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }

    const translated = fromPostgres(error as PgError);
    if (translated) {
      logger.debug({ code: translated.code, url: request.url }, translated.message);
      reply.status(translated.statusCode).send({
        error: { code: translated.code, message: translated.message },
      });
      return;
    }

    logger.error({ err: error, url: request.url }, 'unhandled error');
    reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. The error has been logged.',
      },
    });
  });
}

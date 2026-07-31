import pino from 'pino';

/**
 * Structured logs. Redaction happens at the logger, not per call site, so a new
 * call site cannot forget it.
 *
 * The rule for this app: **logs record that something happened, never what it
 * said.** Task titles, notes, step text and export contents are the user's
 * private life; none of it belongs in a Railway log stream that is retained and
 * searchable.
 *
 * Fastify does not log request or response bodies by default, so the main risk
 * is an error object that carries the payload with it — a database driver error
 * quoting parameters, or a validation error echoing input. The paths below
 * cover those shapes.
 */
export function makeLogger(level: string) {
  return pino({
    level,
    redact: {
      paths: [
        // Credentials and tokens
        'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-dev-email"]',
        '*.password', '*.token', '*.apiKey', '*.privateKey', '*.secret',
        '*.DATABASE_URL', '*.authorization',

        // Private user content, at the top level and one level down — the two
        // shapes an error payload realistically takes.
        '*.title', '*.notes', '*.text', '*.body', '*.export',
        '*.*.title', '*.*.notes', '*.*.text', '*.*.body', '*.*.export',
        'err.body', 'err.payload', 'err.parameters', 'err.query',

        // Personal identifiers
        '*.email', '*.*.email', '*.displayName', '*.*.displayName',
      ],
      censor: '[redacted]',
    },
    serializers: {
      /**
       * Log the path only. Query strings are dropped wholesale rather than
       * filtered: this app puts nothing sensitive in them today, but that is a
       * convention, and a log redactor should not depend on a convention
       * holding forever.
       */
      req(req: { id?: string; method?: string; url?: string }) {
        const url = typeof req.url === 'string' ? req.url.split('?')[0] : undefined;
        return { id: req.id, method: req.method, url };
      },
    },
  });
}

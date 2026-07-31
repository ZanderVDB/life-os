import pino from 'pino';

/** Structured logs. Secrets are redacted at the logger, not per call site. */
export function makeLogger(level: string) {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization', 'req.headers.cookie',
        '*.password', '*.token', '*.apiKey', '*.privateKey', '*.DATABASE_URL',
      ],
      censor: '[redacted]',
    },
  });
}

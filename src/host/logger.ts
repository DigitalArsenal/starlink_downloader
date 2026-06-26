/** Structured logging via pino. */
import { pino, type Logger } from 'pino';

const level = process.env.EPHEM_LOG_LEVEL ?? 'info';

/** Whether stdout is an interactive TTY (drives pretty vs. JSON logs). */
export const isTty = Boolean(process.stdout.isTTY) && process.env.EPHEM_JSON !== '1';

export const logger: Logger = pino(
  isTty
    ? {
        level,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : { level },
);

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

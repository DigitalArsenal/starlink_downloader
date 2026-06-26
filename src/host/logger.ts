/** Structured logging via pino. */
import { pino, destination, type Logger } from 'pino';

const level = process.env.EPHEM_LOG_LEVEL ?? 'info';

/** Whether stdout is an interactive TTY (drives pretty vs. JSON logs). */
export const isTty = Boolean(process.stdout.isTTY) && process.env.EPHEM_JSON !== '1';

// Logs always go to stderr so CLI JSON/data output on stdout stays clean.
export const logger: Logger = isTty
  ? pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname', destination: 2 },
      },
    })
  : pino({ level }, destination(2));

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

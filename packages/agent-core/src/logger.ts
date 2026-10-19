export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function resolveLevel(): number {
  const raw = process.env.LOG_LEVEL ?? 'info';
  return LEVELS[raw as LogLevel] ?? LEVELS.info;
}

/** Local wall-clock time as `HH:MM:SS.mmm`, the stamp every line starts with. */
export function formatClock(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// Local time before the prefix: an agent drop could not be ordered against the boot and install around it
// while no line carried a time. Before rather than after, so `[prefix] msg` stays a substring.
function print(fn: (...args: unknown[]) => void, prefix: string, msg: string, meta: unknown): void {
  const line = `${formatClock(new Date())} [${prefix}] ${msg}`;
  if (meta !== undefined) {
    fn(line, meta);
  } else {
    fn(line);
  }
}

class ConsoleLogger implements Logger {
  private readonly prefix: string;
  private readonly minLevel: number;

  constructor(prefix: string) {
    this.prefix = prefix;
    this.minLevel = resolveLevel();
  }

  debug(msg: string, meta?: unknown): void {
    if (this.minLevel > LEVELS.debug) return;
    print(console.debug, this.prefix, msg, meta);
  }

  info(msg: string, meta?: unknown): void {
    if (this.minLevel > LEVELS.info) return;
    print(console.log, this.prefix, msg, meta);
  }

  warn(msg: string, meta?: unknown): void {
    if (this.minLevel > LEVELS.warn) return;
    print(console.warn, this.prefix, msg, meta);
  }

  error(msg: string, meta?: unknown): void {
    if (this.minLevel > LEVELS.error) return;
    print(console.error, this.prefix, msg, meta);
  }
}

export function createLogger(prefix: string): Logger {
  return new ConsoleLogger(prefix);
}

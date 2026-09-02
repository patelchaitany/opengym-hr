// Minimal timestamped logger. Keeps output readable without pulling in a
// logging framework.

const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = levels[process.env.LOG_LEVEL] ?? levels.info;

function stamp() {
  return new Date().toISOString();
}

function log(level, ...args) {
  if (levels[level] < threshold) return;
  const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(line, ...args);
}

export const logger = {
  debug: (...a) => log('debug', ...a),
  info: (...a) => log('info', ...a),
  warn: (...a) => log('warn', ...a),
  error: (...a) => log('error', ...a),
};

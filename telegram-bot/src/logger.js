export function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

export function logError(message, error) {
  console.error(`[${new Date().toISOString()}] ${message}`, error);
}

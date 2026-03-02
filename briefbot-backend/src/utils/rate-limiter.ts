const store = new Map<string, number[]>();
const windowMs = 60_000; // 1 minute

export function createRateLimiter(maxPerMinute: number) {
  return function checkLimit(key: string): boolean {
    const now = Date.now();
    const timestamps = store.get(key) ?? [];
    const since = now - windowMs;
    const recent = timestamps.filter((t) => t > since);
    if (recent.length >= maxPerMinute) {
      return false;
    }
    recent.push(now);
    store.set(key, recent);
    return true;
  };
}

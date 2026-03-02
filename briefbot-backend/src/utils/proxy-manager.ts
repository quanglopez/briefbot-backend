import { env } from '../config/env.js';

let index = 0;

export function getNextProxy(): string | undefined {
  const list = env.PROXY_LIST;
  if (!list || list.length === 0) return undefined;
  const proxy = list[index % list.length];
  index += 1;
  return proxy;
}

export function getProxyCount(): number {
  return env.PROXY_LIST?.length ?? 0;
}

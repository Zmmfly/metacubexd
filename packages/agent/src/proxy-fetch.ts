import { ProxyAgent } from 'undici'

/**
 * Build a `fetch` that routes through the kernel's local mixed proxy
 * (http://127.0.0.1:<mixedPort>). Used by subscription import/refresh and geo
 * asset downloads when the user picks "via proxy" — in network-restricted
 * regions the direct path to GitHub / subscription providers often fails while
 * the already-running proxy still works.
 *
 * Kept injectable (the agent never hardcodes a global dispatcher) so tests can
 * substitute a fake and the direct path stays the default global fetch.
 */
export function createProxiedFetch(proxyUrl: string): typeof fetch {
  const dispatcher = new ProxyAgent(proxyUrl)
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetch(input, {
      ...init,
      // undici extends RequestInit with `dispatcher`; the DOM lib type does not
      // know it, hence the cast.
      dispatcher,
    } as RequestInit)) as typeof fetch
}

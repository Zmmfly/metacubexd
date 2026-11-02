import { ProxyAgent } from 'undici'

const SUPPORTED_PROTOCOLS = new Set([
  'http:',
  'https:',
  'socks:',
  'socks5:',
  'socks5h:',
])

/**
 * Build a `fetch` that routes through an HTTP(S) or SOCKS proxy. Used by
 * subscription import/refresh and geo asset downloads when the user picks
 * "via proxy" — in network-restricted regions the direct path to GitHub /
 * subscription providers often fails while a proxy still works.
 *
 * Kept injectable (the agent never hardcodes a global dispatcher) so tests can
 * substitute a fake and the direct path stays the default global fetch.
 */
export function createProxiedFetch(proxyUrl: string): typeof fetch {
  let url: URL
  try {
    url = new URL(proxyUrl)
  } catch {
    throw new Error('invalid proxy URL')
  }

  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      `unsupported proxy protocol "${url.protocol}"; use http(s), socks5, or socks5h`,
    )
  }

  // Undici's SOCKS5 connector sends target hostnames to the proxy for remote
  // resolution, which is exactly socks5h semantics. Normalize only the scheme;
  // credentials, host, port, and any other URL components stay unchanged.
  if (url.protocol === 'socks5h:') url.protocol = 'socks5:'
  const dispatcher = new ProxyAgent(url.href)
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetch(input, {
      ...init,
      // undici extends RequestInit with `dispatcher`; the DOM lib type does not
      // know it, hence the cast.
      dispatcher,
    } as RequestInit)) as typeof fetch
}

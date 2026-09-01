import { isIPv4, isIPv6 } from "node:net";

export type NetworkMode = "loopback" | "lan";

/**
 * The loopback set the service has always accepted. It stays exactly this
 * narrow because the Agent Runner and the network-mode control depend on it
 * regardless of which mode the HTTP listener is in.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** `new URL` keeps IPv6 literals bracketed; callers compare bare addresses. */
const unbracket = (hostname: string): string =>
  hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

/**
 * Parse a raw `Host` header into a bare, lowercase hostname. Returns null when
 * the header is missing or unparseable, which every caller treats as forbidden.
 */
export const hostnameFromHostHeader = (raw: string): string | null => {
  if (!raw) return null;
  try {
    const parsed = new URL(`http://${raw}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return unbracket(parsed.hostname.toLowerCase());
  } catch {
    return null;
  }
};

export const isLoopbackHostname = (hostname: string): boolean =>
  LOOPBACK_HOSTNAMES.has(unbracket(hostname.toLowerCase()));

/**
 * Canonicalize the address reported by Node's socket. In particular, HTTP
 * connections accepted by an IPv6-capable listener commonly report IPv4
 * callers as `::ffff:a.b.c.d`; treating that string as an unrelated IPv6
 * address would make loopback authorization platform-dependent.
 *
 * Forwarded headers are intentionally absent from this function. They are
 * caller-controlled unless a trusted proxy is configured, and this service
 * does not run behind such a proxy.
 */
export const normalizeSocketAddress = (
  raw: string | null | undefined,
): string | null => {
  if (!raw) return null;
  const withoutZone = raw.trim().split("%", 1)[0].toLowerCase();
  if (isIPv4(withoutZone)) return withoutZone;

  const dottedMapping = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(withoutZone);
  if (dottedMapping && isIPv4(dottedMapping[1])) return dottedMapping[1];
  if (!isIPv6(withoutZone)) return null;

  try {
    const canonical = unbracket(new URL(`http://[${withoutZone}]`).hostname);
    const hexadecimalMapping = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(
      canonical,
    );
    if (hexadecimalMapping) {
      const high = Number.parseInt(hexadecimalMapping[1], 16);
      const low = Number.parseInt(hexadecimalMapping[2], 16);
      return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
    }
    return canonical;
  } catch {
    return null;
  }
};

export const isLoopbackAddress = (raw: string | null | undefined): boolean => {
  const address = normalizeSocketAddress(raw);
  return address === "127.0.0.1" || address === "::1";
};

const isPrivateIpv4 = (address: string): boolean => {
  const [a, b] = address.split(".").map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Link-local, so a device that failed DHCP can still be reached.
  if (a === 169 && b === 254) return true;
  return false;
};

const isPrivateIpv6 = (address: string): boolean =>
  // fc00::/7 unique-local, then fe80::/10 link-local.
  /^f[cd]/.test(address) || /^fe[89ab]/.test(address);

/**
 * A private-network IP literal. Deliberately literals only: an attacker-owned
 * DNS name arrives in the Host header as that name, never as an address, so
 * refusing every name is what makes DNS rebinding impossible. CGNAT
 * (100.64.0.0/10, e.g. Tailscale) is excluded on purpose — it is not "the same
 * Wi-Fi" and LAN mode does not promise to cover it.
 */
export const isPrivateIpLiteral = (hostname: string): boolean => {
  const address = unbracket(hostname.toLowerCase());
  if (isIPv4(address)) return isPrivateIpv4(address);
  if (isIPv6(address)) return isPrivateIpv6(address);
  return false;
};

/**
 * The single Host/Origin gate. Loopback stays allowed in both modes: LAN mode
 * only ever *adds* the private-literal set, so `localhost` keeps working for
 * the operator's own tab.
 */
export const isAllowedHostname = (
  hostname: string,
  mode: NetworkMode,
  localAddresses: readonly string[] = [],
): boolean => {
  const candidate = unbracket(hostname.toLowerCase());
  if (isLoopbackHostname(candidate)) return true;
  if (mode !== "lan" || !isPrivateIpLiteral(candidate)) return false;
  return localAddresses.some(
    (address) => normalizeSocketAddress(address) === candidate,
  );
};

/**
 * A loopback Host is meaningful only on a loopback connection. A LAN Host is
 * accepted only when it names one of this machine's current interfaces; an
 * arbitrary private literal is not evidence that the request reached the
 * intended server.
 */
export const isAllowedRequestHost = (
  hostname: string,
  mode: NetworkMode,
  remoteAddress: string | null | undefined,
  localAddresses: readonly string[] = [],
): boolean => {
  if (isLoopbackHostname(hostname)) return isLoopbackAddress(remoteAddress);
  const peer = normalizeSocketAddress(remoteAddress);
  if (!peer || (!isLoopbackAddress(peer) && !isPrivateIpLiteral(peer))) {
    return false;
  }
  return isAllowedHostname(hostname, mode, localAddresses);
};

/**
 * A browser origin is accepted only when it is this very server.
 *
 * Matching the Origin against the *request's own Host* is what keeps LAN mode
 * safe: "any private literal" would admit a page served from any other device
 * on the Wi-Fi (`http://192.168.1.99:8080`), handing it full cross-origin
 * access to the API from the visitor's browser. The app's own pages always
 * carry an Origin equal to the Host they are talking to, so this costs nothing
 * legitimate. Different loopback ports remain allowed for the Vite dev proxy,
 * but only when the request Host is itself loopback.
 */
export const isAllowedOrigin = (
  origin: string,
  mode: NetworkMode,
  requestHost: string | null = null,
): boolean => {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = unbracket(url.hostname.toLowerCase());
    const requestHostname = requestHost
      ? hostnameFromHostHeader(requestHost)
      : null;
    if (isLoopbackHostname(hostname)) {
      return Boolean(requestHostname && isLoopbackHostname(requestHostname));
    }
    if (mode !== "lan") return false;
    if (
      !isPrivateIpLiteral(hostname) ||
      requestHostname === null ||
      hostname !== requestHostname
    ) {
      return false;
    }
    // LAN mode is production-only and has no Vite cross-port exception. Use
    // URL parsing so default ports (`:80` / `:443`) compare canonically.
    const requestUrl = new URL(`${url.protocol}//${requestHost}`);
    return url.host.toLowerCase() === requestUrl.host.toLowerCase();
  } catch {
    return false;
  }
};

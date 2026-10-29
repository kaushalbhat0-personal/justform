import * as net from "node:net";
import { promises as dnsPromises } from "node:dns";

/**
 * SSRF protection for webhook destinations (Phase 9).
 * Deny-by-default: only http/https to globally routable addresses.
 * Blocks: credentials in URL, localhost/loopback, private ranges,
 * link-local + cloud metadata (169.254.169.254), multicast, ::/0,
 * internal hostnames/TLDs, non-http(s) schemes. Redirects are NEVER
 * followed (callers treat 3xx as terminal).
 * DNS is injectable for deterministic tests; TOCTOU (resolve→connect race)
 * is documented as a residual and mitigated by short timeouts.
 */

export interface DnsResolver {
  (hostname: string): Promise<string[]>;
}

const defaultResolve: DnsResolver = async (hostname) => {
  const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

const BLOCKED_TLDS = new Set(["localhost", "localhost.", "internal", "lan", "home", "intranet", "local", "localdomain", "invalid", "example", "test"]);
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "instance-data", "169.254.169.254"]);

/** Expand an IPv6 address to 8 hextets. Returns null when invalid. */
function expandIPv6(ip: string): number[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const headRaw = halves[0] ?? "";
  const tailRaw = halves.length === 2 ? (halves[1] ?? "") : null;
  const head = headRaw === "" ? [] : headRaw.split(":");
  const tail = tailRaw === null ? [] : tailRaw === "" ? [] : tailRaw.split(":");
  if (head.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  if (tail.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g) && !net.isIPv4(g))) return null;
  // An embedded IPv4 tail (e.g. ::ffff:1.2.3.4) counts as two hextets.
  const tailExpanded: string[] = [];
  for (const g of tail) {
    if (g.includes(".")) {
      if (!net.isIPv4(g)) return null;
      const octets = g.split(".").map(Number);
      const o0 = octets[0] ?? NaN;
      const o1 = octets[1] ?? NaN;
      const o2 = octets[2] ?? NaN;
      const o3 = octets[3] ?? NaN;
      if (![o0, o1, o2, o3].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
      tailExpanded.push(((o0 << 8) | o1).toString(16), ((o2 << 8) | o3).toString(16));
    } else {
      tailExpanded.push(g);
    }
  }
  const missing = 8 - head.length - tailExpanded.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...new Array<string>(Math.max(0, missing)).fill("0"), ...tailExpanded];
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16));
}

function ipv4ToInt(ip: string): number | null {
  if (!net.isIPv4(ip)) return null;
  const octets = ip.split(".").map(Number);
  const o0 = octets[0];
  const o1 = octets[1];
  const o2 = octets[2];
  const o3 = octets[3];
  if (o0 === undefined || o1 === undefined || o2 === undefined || o3 === undefined) return null;
  return ((o0 * 256 + o1) * 256 + o2) * 256 + o3;
}

function inCidrV4(ip: string, network: string, prefix: number): boolean {
  const addr = ipv4ToInt(ip);
  const net = ipv4ToInt(network);
  if (addr === null || net === null) return false;
  const shift = 32 - prefix;
  return (addr >>> shift) === (net >>> shift);
}

function inCidrV6(ip: string, networkGroups: number[], prefix: number): boolean {
  const addr = expandIPv6(ip);
  if (!addr) return false;
  let bits = prefix;
  for (let i = 0; i < 8; i += 1) {
    if (bits <= 0) return true;
    const take = Math.min(16, bits);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if (((addr[i] ?? 0) & mask) !== ((networkGroups[i] ?? 0) & mask)) return false;
    bits -= take;
  }
  return true;
}

const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
const V6_BLOCKS: Array<[number[], number]> = [
  [[0, 0, 0, 0, 0, 0, 0, 1], 128], // ::1 loopback
  [[0, 0, 0, 0, 0, 0, 0, 0], 128], // :: unspecified
  [[0xfc00, 0, 0, 0, 0, 0, 0, 0], 7], // unique-local
  [[0xfe80, 0, 0, 0, 0, 0, 0, 0], 10], // link-local
  [[0xff00, 0, 0, 0, 0, 0, 0, 0], 8], // multicast
  [[0, 0, 0, 0, 0, 0xffff, 0, 0], 96], // IPv4-mapped ::ffff:0:0/96 (covers ::ffff:127.0.0.1 etc.)
  [[0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32], // documentation
];

/** True when the IP is NOT globally routable (deny-listed). */
export function isNonRoutableIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return V4_BLOCKS.some(([network, prefix]) => inCidrV4(ip, network, prefix));
  }
  if (net.isIPv6(ip)) {
    return V6_BLOCKS.some(([groups, prefix]) => inCidrV6(ip, groups, prefix));
  }
  return true; // not an IP at all → treat as blocked; callers validate first
}

export type SsrRejection = { ok: true; url: URL } | { ok: false; reason: string };

/** Validate a webhook destination URL. Returns the parsed URL when safe. */
export async function assertUrlSafe(raw: string, resolve: DnsResolver = defaultResolve): Promise<SsrRejection> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return { ok: false, reason: "url invalid or too long" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "url unparseable" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "scheme must be http(s)" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "credentials in URL forbidden" };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || BLOCKED_HOSTS.has(host)) {
    return { ok: false, reason: "host blocked" };
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "loopback host blocked" };
  }
  const labels = host.split(".");
  const tld = labels[labels.length - 1] ?? "";
  if (labels.length === 1 || BLOCKED_TLDS.has(tld)) {
    return { ok: false, reason: "internal hostname blocked" };
  }
  if (net.isIP(host) !== 0) {
    if (isNonRoutableIp(host)) return { ok: false, reason: "non-routable IP blocked" };
    return { ok: true, url };
  }
  // Hostname: resolve ALL addresses and require every one to be routable.
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    return { ok: false, reason: "DNS resolution failed" };
  }
  if (addrs.length === 0) return { ok: false, reason: "DNS returned no addresses" };
  for (const addr of addrs) {
    if (!net.isIP(addr) || isNonRoutableIp(addr)) {
      return { ok: false, reason: "hostname resolves to non-routable IP" };
    }
  }
  return { ok: true, url };
}

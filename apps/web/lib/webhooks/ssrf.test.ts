import { describe, expect, it, vi } from "vitest";
import { assertUrlSafe, isNonRoutableIp } from "./ssrf";

const publicResolve = async (host: string) => {
  if (host === "hooks.example.com") return ["93.184.216.34"];
  if (host === "multi.example.com") return ["93.184.216.34", "93.184.216.35"];
  if (host === "evil.example.com") return ["10.9.9.9"];
  if (host === "nx.example.invalid") throw new Error("ENOTFOUND");
  return ["93.184.216.34"];
};
const resolveLocalhost = async () => ["127.0.0.1"];

describe("SSRF URL validation", () => {
  it("allows ordinary public https URLs", async () => {
    const r = await assertUrlSafe("https://hooks.example.com/hook?x=1", publicResolve);
    expect(r.ok).toBe(true);
  });

  it("rejects non-http(s) schemes, credentials, and unparseable input", async () => {
    for (const bad of [
      "ftp://hooks.example.com/x",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pass@hooks.example.com/",
      "not a url",
      "",
      "https://[::1]/x",
    ]) {
      expect((await assertUrlSafe(bad, publicResolve)).ok).toBe(false);
    }
    const tooLong = `https://hooks.example.com/${"x".repeat(2048)}`;
    expect((await assertUrlSafe(tooLong, publicResolve)).ok).toBe(false);
  });

  it("blocks loopback, private, link-local, metadata and multicast ranges", async () => {
    for (const bad of [
      "http://localhost/",
      "http://localhost:3000/hook",
      "http://LOCALHOST/hook",
      "http://127.0.0.1/hook",
      "http://10.1.2.3/",
      "http://172.16.9.9/x",
      "http://192.168.1.1/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://0.0.0.0/",
      "http://224.0.0.1/",
      "http://[ff02::1]/",
      "http://100.64.0.1/",
      "http://[fc00::1]/",
    ]) {
      const r = await assertUrlSafe(bad, publicResolve);
      expect(r.ok).toBe(false);
    }
  });

  it("blocks internal hostnames and dangerous TLDs", async () => {
    for (const bad of [
      "http://intranet/",
      "http://api.internal/hook",
      "http://x.local/hook",
      "http://x.localhost/hook",
      "http://metadata.google.internal/",
      "http://instance-data/",
      "http://hooks.example.invalid/x",
    ]) {
      const r = await assertUrlSafe(bad, publicResolve);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects hosts resolving to non-routable IPs (DNS rebinding guard)", async () => {
    const r = await assertUrlSafe("https://evil.example.com/hook", publicResolve);
    expect(r).toMatchObject({ ok: false });
    const nx = await assertUrlSafe("https://nx.example.invalid/hook", publicResolve);
    expect(nx.ok).toBe(false);
  });

  it("requires every resolved address to be routable (multi-A)", async () => {
    const mixed = async () => ["93.184.216.34", "10.0.0.5"];
    expect((await assertUrlSafe("https://multi.example.com/x", mixed)).ok).toBe(false);
  });

  it("blocks documentation/test ranges as non-routable", async () => {
    for (const bad of ["http://203.0.113.5/x", "http://198.51.100.9/x", "http://192.0.2.1/hook"]) {
      expect((await assertUrlSafe(bad, publicResolve)).ok).toBe(false);
    }
    expect((await assertUrlSafe("http://8.8.8.8/x", publicResolve)).ok).toBe(true);
  });

  it("never performs DNS for literal IPs, and treats loopback DNS as hostile", async () => {
    const resolve = vi.fn(async () => ["93.184.216.34"]);
    const r = await assertUrlSafe("http://127.0.0.1/", resolve);
    expect(r.ok).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect((await assertUrlSafe("http://hooks.example.com/", resolveLocalhost)).ok).toBe(false);
  });

  it("classifies IPv4/IPv6 ranges correctly", () => {
    for (const good of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2001:4860:4860::8888", "2606:4700:4700::1111"]) {
      expect(isNonRoutableIp(good)).toBe(false);
    }
    for (const bad of [
      "127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1",
      "169.254.169.254", "0.0.0.0", "224.0.0.1", "100.64.0.1", "203.0.113.5",
      "::1", "::", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1",
      "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-ip",
    ]) {
      expect(isNonRoutableIp(bad)).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  hostnameFromHostHeader,
  isAllowedHostname,
  isAllowedOrigin,
  isAllowedRequestHost,
  isLoopbackAddress,
  isLoopbackHostname,
  isPrivateIpLiteral,
  normalizeSocketAddress,
} from "../server/net/host-policy";

describe("Host 与 Origin 策略", () => {
  it("解析 Host 头并去掉 IPv6 方括号", () => {
    expect(hostnameFromHostHeader("127.0.0.1:3001")).toBe("127.0.0.1");
    expect(hostnameFromHostHeader("LocalHost:5173")).toBe("localhost");
    expect(hostnameFromHostHeader("[::1]:3001")).toBe("::1");
    expect(hostnameFromHostHeader("192.168.1.5:3001")).toBe("192.168.1.5");
    expect(hostnameFromHostHeader("")).toBeNull();
    expect(hostnameFromHostHeader("a b c")).toBeNull();
    expect(hostnameFromHostHeader("user@127.0.0.1:3001")).toBeNull();
    expect(hostnameFromHostHeader("127.0.0.1:3001/path")).toBeNull();
  });

  it("回环集合保持与历史行为一致", () => {
    for (const hostname of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
      expect(isLoopbackHostname(hostname)).toBe(true);
    }
    // 127.0.0.0/8 的其余地址历史上就不在白名单里，不要顺手放宽。
    for (const hostname of ["127.0.0.2", "192.168.1.5", "example.com"]) {
      expect(isLoopbackHostname(hostname)).toBe(false);
    }
  });

  it("只认私有网段的 IP 字面量，拒绝一切域名", () => {
    for (const hostname of [
      "10.0.0.1",
      "10.255.255.254",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.5",
      "169.254.10.20",
      "fd00::1",
      "fc00::1",
      "fe80::1",
      "[fe80::1]",
    ]) {
      expect(isPrivateIpLiteral(hostname)).toBe(true);
    }

    for (const hostname of [
      // 公网地址
      "8.8.8.8",
      "172.15.0.1",
      "172.32.0.1",
      "192.169.1.5",
      "2001:4860:4860::8888",
      // CGNAT / Tailscale 是有意排除的
      "100.64.0.1",
      // 域名一律不认——这正是防 DNS rebinding 的关键
      "example.com",
      "macbook.local",
      "192.168.1.5.evil.com",
      "localhost",
    ]) {
      expect(isPrivateIpLiteral(hostname)).toBe(false);
    }
  });

  it("loopback 模式只放行本机，lan 模式只放行真实网卡地址", () => {
    expect(isAllowedHostname("127.0.0.1", "loopback")).toBe(true);
    expect(isAllowedHostname("192.168.1.5", "loopback")).toBe(false);

    expect(isAllowedHostname("192.168.1.5", "lan", ["192.168.1.5"])).toBe(true);
    // 同属私网并不代表是本机；Host 必须命中实际接口。
    expect(isAllowedHostname("10.0.0.7", "lan", ["192.168.1.5"])).toBe(false);
    // 本机在两种模式下都必须可用
    expect(isAllowedHostname("localhost", "lan")).toBe(true);
    expect(isAllowedHostname("::1", "lan")).toBe(true);
    // 即使开了局域网，公网地址与域名仍然被拒
    expect(isAllowedHostname("8.8.8.8", "lan")).toBe(false);
    expect(isAllowedHostname("evil.com", "lan")).toBe(false);
    expect(isAllowedHostname("192.168.1.5.evil.com", "lan")).toBe(false);
  });

  it("规范化真实 socket 对端，兼容 IPv4、映射 IPv6 与 IPv6 loopback", () => {
    expect(normalizeSocketAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeSocketAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeSocketAddress("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(normalizeSocketAddress("0:0:0:0:0:0:0:1")).toBe("::1");
    expect(normalizeSocketAddress("not-an-address")).toBeNull();
    for (const address of [
      "127.0.0.1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::1",
      "0:0:0:0:0:0:0:1",
    ]) {
      expect(isLoopbackAddress(address)).toBe(true);
    }
    expect(isLoopbackAddress("192.168.1.20")).toBe(false);
  });

  it("loopback Host 必须来自 loopback，对外 Host 必须命中本机接口", () => {
    const localAddresses = ["192.168.1.5"];
    expect(
      isAllowedRequestHost(
        "127.0.0.1",
        "lan",
        "::ffff:127.0.0.1",
        localAddresses,
      ),
    ).toBe(true);
    expect(
      isAllowedRequestHost("127.0.0.1", "lan", "192.168.1.20", localAddresses),
    ).toBe(false);
    expect(
      isAllowedRequestHost(
        "192.168.1.5",
        "lan",
        "192.168.1.20",
        localAddresses,
      ),
    ).toBe(true);
    expect(
      isAllowedRequestHost(
        "192.168.1.6",
        "lan",
        "192.168.1.20",
        localAddresses,
      ),
    ).toBe(false);
    // A LAN listener is not a public listener even when a router forwards it.
    expect(
      isAllowedRequestHost("192.168.1.5", "lan", "8.8.8.8", localAddresses),
    ).toBe(false);
  });

  it("回环来源在两种模式下都放行", () => {
    expect(
      isAllowedOrigin("http://localhost:5173", "loopback", "localhost"),
    ).toBe(true);
    expect(isAllowedOrigin("https://127.0.0.1", "loopback", "127.0.0.1")).toBe(
      true,
    );
    // 合并白名单后 ::1 来源被放行，这是对历史 CORS 正则的有意修正。
    expect(isAllowedOrigin("http://[::1]:5173", "loopback", "[::1]:3001")).toBe(
      true,
    );
    expect(isAllowedOrigin("http://localhost:5173", "lan", "localhost")).toBe(
      true,
    );
    // A page on a guest device's own localhost cannot drive a LAN Host.
    expect(isAllowedOrigin("http://localhost:5173", "lan", "192.168.1.5")).toBe(
      false,
    );
  });

  it("局域网模式只放行「服务自己」这一个来源", () => {
    // 浏览器访问本服务时，Origin 主机恒等于它请求的 Host。
    expect(
      isAllowedOrigin("http://192.168.1.5:3001", "lan", "192.168.1.5:3001"),
    ).toBe(true);

    // 同网段另一台设备上的网页：主机同样是私有字面量，但不是本服务。
    // 放行它等于把 API 的跨域访问权交给局域网上任何一个页面。
    expect(
      isAllowedOrigin("http://192.168.1.99:8080", "lan", "192.168.1.5:3001"),
    ).toBe(false);
    // Same IP is still another origin when its port differs.
    expect(
      isAllowedOrigin("http://192.168.1.5:8080", "lan", "192.168.1.5:3001"),
    ).toBe(false);
    // 不带 Host 上下文时同样拒绝，不做「宽松兜底」。
    expect(isAllowedOrigin("http://192.168.1.5:3001", "lan")).toBe(false);
  });

  it("仅本机模式拒绝一切局域网来源", () => {
    expect(
      isAllowedOrigin("http://192.168.1.5:3001", "loopback", "192.168.1.5"),
    ).toBe(false);
  });

  it("拒绝非 http(s) 协议、域名与空来源", () => {
    expect(isAllowedOrigin("https://example.com", "lan", "example.com")).toBe(
      false,
    );
    expect(isAllowedOrigin("file:///etc/passwd", "lan")).toBe(false);
    expect(isAllowedOrigin("null", "lan")).toBe(false);
    expect(isAllowedOrigin("", "lan")).toBe(false);
  });
});

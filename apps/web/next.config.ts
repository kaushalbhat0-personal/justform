import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@formos/domain", "@formos/config", "@formos/auth"],
  // Security headers baseline (CSP tightened per surface in later phases).
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;

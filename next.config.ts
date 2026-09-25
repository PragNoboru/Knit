import type { NextConfig } from "next";

/**
 * Security headers (PRD 9.3): Knit is never shown inside a frame, and other
 * sites never receive a full Knit URL through the Referer header.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // `next dev` would otherwise write Next.js agent rules into CLAUDE.md, the
  // project's own instruction file (see node_modules/next/dist/server/lib/
  // generate-agent-files.js). The advice it adds is followed anyway: read the
  // bundled docs in node_modules/next/dist/docs before writing Next.js code.
  agentRules: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

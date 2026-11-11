import type { NextConfig } from "next";

const ENGINE_PORT = process.env.ENGINE_PORT || "3151";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  async rewrites() {
    return [
      {
        source: "/engine/:path*",
        destination: `http://localhost:${ENGINE_PORT}/engine/:path*`,
      },
    ];
  },
};

export default nextConfig;

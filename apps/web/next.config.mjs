import path from "node:path";
import { fileURLToPath } from "node:url";

const configDir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  transpilePackages: ["@print-studio/shared-types"],
  turbopack: {
    root: path.resolve(configDir, "../..")
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000"}/api/:path*`
      },
      {
        source: "/files/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000"}/files/:path*`
      }
    ];
  }
};

export default nextConfig;

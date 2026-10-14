import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */

  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
         // This allows all HTTPS images (for development only)
      },
      {
        protocol: "http",
        hostname: "**", // This allows all HTTP images (for development only)
      },
    ],
  },
};

export default nextConfig;

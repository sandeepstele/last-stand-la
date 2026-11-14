import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // The dev badge sat on top of the game's bottom-left HUD (health, supplies) during demos.
  devIndicators: false,
};

export default nextConfig;

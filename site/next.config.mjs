/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: the site is a bundle of files, deployable to any host.
  // No server to operate: the export is a plain directory of files.
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;

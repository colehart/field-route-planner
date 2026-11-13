/** @type {import('next').NextConfig} */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

const nextConfig = {
  // Static export: the whole app is client-side, so it can be hosted anywhere (Vercel, GitHub Pages, S3).
  output: 'export',
  basePath,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;

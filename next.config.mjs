/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["pg", "googleapis"],
    outputFileTracingExcludes: {
      "*": ["./data/**/*", "./storage/**/*", "./backups/**/*", "./tests/**/*", "./scripts/**/*", "./migrations/**/*", "./.env*"],
    },
  },
};

export default nextConfig;

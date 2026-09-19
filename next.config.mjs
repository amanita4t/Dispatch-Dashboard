/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["pg", "googleapis"],
    outputFileTracingExcludes: {
      // A "*" route key also applies substring exclusions to shared dependencies in Next 14.
      "/api/**/*": ["./data/**/*", "./storage/**/*", "./backups/**/*", "./tests/**/*", "./scripts/**/*", "./migrations/**/*", "./.env*"],
    },
  },
};

export default nextConfig;

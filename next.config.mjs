/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @huggingface/transformers ships a Node-only path (sharp, onnxruntime-node)
  // that must be stubbed for the browser bundle. We also tell Next's file tracer
  // to skip these in the serverless bundle, otherwise onnxruntime-node alone
  // (~355MB) blows past Vercel's 250MB function limit.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "sharp"],
  outputFileTracingExcludes: {
    "*": [
      "node_modules/onnxruntime-node/**",
      "node_modules/@img/**",
      "node_modules/sharp/**",
    ],
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      sharp$: false,
      "onnxruntime-node$": false,
    };
    return config;
  },
};
export default nextConfig;

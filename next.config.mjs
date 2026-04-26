/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @huggingface/transformers ships a Node-only path (sharp, onnxruntime-node)
  // that must be stubbed for the browser bundle.
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

/**
 * Bun's bundler inlines `.yaml` imports as parsed data, which lets
 * `presets/*.yaml` be the single source of truth with no codegen step.
 * TypeScript needs to be told the shape is unknown — every consumer
 * validates it (see presets.ts) instead of trusting a cast.
 */
declare module "*.yaml" {
  const data: unknown;
  export default data;
}

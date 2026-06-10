/**
 * Granola — first real extension peeled out of the monolith into a
 * hot-loadable plugin (proof-of-pattern for the decomposition).
 *
 * The component code stays compiled in the daemon tree
 * (dist/extensions/granola/); this plugin is the WIRING. It pulls the
 * component through ctx.import() — the cache-busted path — so after an
 * `npm run build`, reloading this plugin (`POST /api/extensions/granola/reload`
 * with a comms/daemon token, or just touching this file) picks up fresh
 * component code live. No daemon restart.
 *
 * Granola's own init self-gates on config (granola.enabled) and the Keychain
 * API key, and its shutdown unregisters its routes — both required for clean
 * reload cycles.
 */

let mod = null;

export default {
  name: 'granola',

  async onInit(ctx) {
    mod = await ctx.import('extensions/granola/index.js');
    // Signature: (config, server, scheduler) — server is unused by granola.
    await mod.initGranolaExtension(ctx.config, null, ctx.scheduler);
  },

  async onShutdown() {
    if (mod) {
      await mod.shutdownGranolaExtension();
      mod = null;
    }
  },
};

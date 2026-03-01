/**
 * Network extensions barrel export.
 *
 * Re-exports crypto and registration for external use.
 * SDK bridge exports are imported directly by agent-comms.ts and the extension index.
 */

export { loadKeyFromKeychain, derivePublicKey, generateAndStoreIdentity, hasIdentity } from './crypto.js';
export { ensureIdentity, registerWithRelay, checkRegistrationStatus } from './registration.js';
export type { RegistrationResult } from './registration.js';
export type { WireEnvelope } from './sdk-types.js';

/**
 * Kithkit — Well-Known Capability Namespace
 *
 * Framework-agnostic capabilities describing what an agent CAN DO.
 * Flat list for v1, extensible — unknown capabilities warn, not error.
 */

export interface CapabilityDef {
  name: string;
  description: string;
}

export const WELL_KNOWN_CAPABILITIES: CapabilityDef[] = [
  { name: 'file_read', description: 'Read files from the local filesystem' },
  { name: 'file_write', description: 'Write or create files on the local filesystem' },
  { name: 'file_search', description: 'Search file contents by pattern or keyword' },
  { name: 'file_glob', description: 'Find files by name or glob pattern' },
  { name: 'bash', description: 'Execute shell commands' },
  { name: 'process_spawn', description: 'Spawn or manage system processes' },
  { name: 'web_fetch', description: 'Fetch content from URLs' },
  { name: 'web_search', description: 'Perform web searches' },
  { name: 'email_read', description: 'Read email messages' },
  { name: 'email_send', description: 'Send email messages' },
  { name: 'calendar_read', description: 'Read calendar events' },
  { name: 'calendar_write', description: 'Create or modify calendar events' },
  { name: 'memory_read', description: 'Read from persistent memory store' },
  { name: 'memory_write', description: 'Write to persistent memory store' },
  { name: 'git', description: 'Perform git version control operations' },
  { name: 'github', description: 'Interact with GitHub API (issues, PRs, repos)' },
  { name: 'keychain_read', description: 'Read credentials from secure storage' },
  { name: 'keychain_write', description: 'Store credentials in secure storage' },
  { name: 'notification', description: 'Send notifications to the user' },
  { name: 'voice_input', description: 'Receive voice/audio input' },
  { name: 'voice_output', description: 'Produce voice/audio output' },
  { name: 'browser', description: 'Automate browser interactions' },
];

export const CAPABILITY_NAMES = new Set(WELL_KNOWN_CAPABILITIES.map(c => c.name));

/**
 * Check if a capability is in the well-known list.
 */
export function isKnownCapability(name: string): boolean {
  return CAPABILITY_NAMES.has(name);
}

/**
 * Get the description for a well-known capability.
 */
export function getCapabilityDescription(name: string): string | undefined {
  return WELL_KNOWN_CAPABILITIES.find(c => c.name === name)?.description;
}

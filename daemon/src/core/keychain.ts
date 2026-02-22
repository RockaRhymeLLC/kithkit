/**
 * macOS Keychain integration — read/write credentials.
 * Uses the `security` CLI tool for Keychain operations.
 */

import { execFile } from 'node:child_process';

/**
 * Read a credential from the macOS Keychain.
 * @param service - The service name (e.g., "credential-api-key")
 * @returns The password value, or null if not found
 */
export function readKeychain(service: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/**
 * Write a credential to the macOS Keychain.
 * Updates existing entry or creates new one.
 * @param service - The service name
 * @param account - The account name (default: current user)
 * @param password - The password value to store
 */
export function writeKeychain(
  service: string,
  account: string,
  password: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Try to delete existing entry first (ignore errors)
    execFile(
      'security',
      ['delete-generic-password', '-s', service, '-a', account],
      { timeout: 5000 },
      () => {
        // Now add the new entry
        execFile(
          'security',
          ['add-generic-password', '-s', service, '-a', account, '-w', password],
          { timeout: 5000 },
          (err) => {
            if (err) {
              reject(new Error(`Failed to write keychain entry "${service}": ${err.message}`));
            } else {
              resolve();
            }
          },
        );
      },
    );
  });
}

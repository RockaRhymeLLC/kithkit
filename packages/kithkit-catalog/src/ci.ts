/**
 * CI Script — lint submitted skills and sign approved archives.
 *
 * Usage:
 *   kithkit-catalog lint <skill-dir>       Lint a skill directory
 *   kithkit-catalog sign <archive-path>    Sign an archive and update index
 *   kithkit-catalog build <archives-dir>   Rebuild entire index from archives
 *   kithkit-catalog verify <index-path>    Verify index signature
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildIndex, updateIndex, verifySignedIndex, serializeIndex } from './index-builder.ts';
import { createArchive } from './archive.ts';
import { generateKeyPair } from './signing-bridge.ts';
import type { SignedCatalogIndex } from './types.ts';

async function main() {
  const [,, command, ...args] = process.argv;

  switch (command) {
    case 'lint': {
      const skillDir = args[0];
      if (!skillDir) {
        console.error('Usage: kithkit-catalog lint <skill-dir>');
        process.exit(1);
      }
      // Shell out to kithkit-lint
      const { execFileSync } = await import('node:child_process');
      try {
        const result = execFileSync('npx', ['kithkit-lint', resolve(skillDir), '--json'], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const parsed = JSON.parse(result);
        if (parsed.pass) {
          console.log('✅ All checks passed');
          process.exit(0);
        } else {
          console.log('❌ Lint failed:');
          console.log(result);
          process.exit(1);
        }
      } catch (err: any) {
        console.error('❌ Lint failed');
        if (err.stdout) console.error(err.stdout);
        if (err.stderr) console.error(err.stderr);
        process.exit(1);
      }
      break;
    }

    case 'sign': {
      const archivePath = args[0];
      const indexPath = args[1] ?? 'index.json';
      const privateKey = process.env.KITHKIT_CATALOG_PRIVATE_KEY;
      if (!archivePath || !privateKey) {
        console.error('Usage: KITHKIT_CATALOG_PRIVATE_KEY=... kithkit-catalog sign <archive-path> [index-path]');
        process.exit(1);
      }

      let existingIndex: SignedCatalogIndex | undefined;
      try {
        const content = await readFile(indexPath, 'utf8');
        existingIndex = JSON.parse(content);
      } catch {
        // No existing index — will create from scratch
      }

      if (existingIndex) {
        const updated = await updateIndex(existingIndex, archivePath, privateKey);
        await writeFile(indexPath, serializeIndex(updated), 'utf8');
        console.log(`✅ Updated index with archive: ${archivePath}`);
      } else {
        // Create minimal index with just this archive
        const { extractManifestFromArchive, hashArchive } = await import('./archive.ts');
        const manifest = await extractManifestFromArchive(archivePath);
        const tempDir = join(process.cwd(), '.kithkit-temp');
        await mkdir(join(tempDir, 'archives', manifest.name as string), { recursive: true });
        const { copyFile } = await import('node:fs/promises');
        const archiveBasename = `${manifest.name}-${manifest.version}.tar.gz`;
        await copyFile(archivePath, join(tempDir, 'archives', manifest.name as string, archiveBasename));
        const index = await buildIndex({ archivesDir: join(tempDir, 'archives'), privateKeyBase64: privateKey });
        await writeFile(indexPath, serializeIndex(index), 'utf8');
        // Clean up
        const { rm } = await import('node:fs/promises');
        await rm(tempDir, { recursive: true, force: true });
        console.log(`✅ Created index with archive: ${archivePath}`);
      }
      break;
    }

    case 'build': {
      const archivesDir = args[0] ?? 'archives';
      const indexPath = args[1] ?? 'index.json';
      const privateKey = process.env.KITHKIT_CATALOG_PRIVATE_KEY;
      if (!privateKey) {
        console.error('Usage: KITHKIT_CATALOG_PRIVATE_KEY=... kithkit-catalog build [archives-dir] [index-path]');
        process.exit(1);
      }
      const index = await buildIndex({ archivesDir: resolve(archivesDir), privateKeyBase64: privateKey });
      await writeFile(indexPath, serializeIndex(index), 'utf8');
      console.log(`✅ Built index with ${index.skills.length} skills`);
      break;
    }

    case 'verify': {
      const indexPath = args[0] ?? 'index.json';
      const publicKey = process.env.KITHKIT_CATALOG_PUBLIC_KEY ?? args[1];
      if (!publicKey) {
        console.error('Usage: KITHKIT_CATALOG_PUBLIC_KEY=... kithkit-catalog verify [index-path]');
        process.exit(1);
      }
      const content = await readFile(indexPath, 'utf8');
      const index = JSON.parse(content) as SignedCatalogIndex;
      const valid = verifySignedIndex(index, publicKey);
      if (valid) {
        console.log(`✅ Index signature valid (${index.skills.length} skills)`);
        process.exit(0);
      } else {
        console.error('❌ Index signature invalid — possible tampering');
        process.exit(1);
      }
      break;
    }

    case 'keygen': {
      const kp = generateKeyPair();
      console.log(`Public key:  ${kp.publicKey}`);
      console.log(`Private key: ${kp.privateKey}`);
      break;
    }

    default:
      console.error('Usage: kithkit-catalog <lint|sign|build|verify|keygen> [args...]');
      process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

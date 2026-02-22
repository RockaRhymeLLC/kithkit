/**
 * Archive management — create and inspect skill tarballs.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { join, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ArchiveInfo } from './types.ts';

// Simple tar packing — header + file content blocks
// We use a minimal tar implementation to avoid external dependencies

const TAR_BLOCK_SIZE = 512;

function createTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);

  // File name (0-99)
  header.write(name, 0, 100, 'utf8');
  // File mode (100-107) — 0644
  header.write('0000644\0', 100, 8, 'utf8');
  // Owner UID (108-115)
  header.write('0001000\0', 108, 8, 'utf8');
  // Group GID (116-123)
  header.write('0001000\0', 116, 8, 'utf8');
  // File size in octal (124-135)
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  // Modification time (136-147)
  const mtime = Math.floor(Date.now() / 1000);
  header.write(mtime.toString(8).padStart(11, '0') + '\0', 136, 12, 'utf8');
  // Type flag (156) — '0' = regular file
  header.write('0', 156, 1, 'utf8');
  // USTAR indicator (257-262)
  header.write('ustar\0', 257, 6, 'utf8');
  // USTAR version (263-264)
  header.write('00', 263, 2, 'utf8');

  // Calculate checksum (148-155) — sum of all header bytes with checksum field as spaces
  header.write('        ', 148, 8, 'utf8'); // 8 spaces for checksum field
  let checksum = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i++) {
    checksum += header[i];
  }
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');

  return header;
}

export async function createArchive(skillDir: string, outputPath: string): Promise<ArchiveInfo> {
  const manifestPath = join(skillDir, 'manifest.yaml');
  const manifestContent = await readFile(manifestPath, 'utf8');
  const manifest = parseYaml(manifestContent) as { name: string; version: string };

  // Collect files to include
  const entries = await readdir(skillDir);
  const files: Array<{ name: string; content: Buffer }> = [];

  for (const entry of entries.sort()) {
    const fullPath = join(skillDir, entry);
    const stats = await stat(fullPath);
    if (stats.isFile()) {
      const content = await readFile(fullPath);
      files.push({ name: `${manifest.name}/${entry}`, content });
    }
  }

  // Build tar buffer
  const tarParts: Buffer[] = [];
  for (const file of files) {
    const header = createTarHeader(file.name, file.content.length);
    tarParts.push(header);
    tarParts.push(file.content);
    // Pad to block boundary
    const remainder = file.content.length % TAR_BLOCK_SIZE;
    if (remainder > 0) {
      tarParts.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder));
    }
  }
  // End-of-archive: two zero blocks
  tarParts.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));

  const tarBuffer = Buffer.concat(tarParts);

  // Write gzipped
  const { Readable } = await import('node:stream');
  const readable = Readable.from(tarBuffer);
  const gzip = createGzip({ level: 9 });
  const output = createWriteStream(outputPath);
  await pipeline(readable, gzip, output);

  // Compute hash and size
  const archiveContent = await readFile(outputPath);
  const sha256 = createHash('sha256').update(archiveContent).digest('hex');
  const size = archiveContent.length;

  return {
    name: manifest.name,
    version: manifest.version,
    path: outputPath,
    sha256,
    size,
  };
}

export async function hashArchive(archivePath: string): Promise<{ sha256: string; size: number }> {
  const content = await readFile(archivePath);
  return {
    sha256: createHash('sha256').update(content).digest('hex'),
    size: content.length,
  };
}

export async function extractManifestFromArchive(archivePath: string): Promise<Record<string, unknown>> {
  const content = await readFile(archivePath);

  // Decompress gzip
  const { promisify } = await import('node:util');
  const { gunzip } = await import('node:zlib');
  const gunzipAsync = promisify(gunzip);
  const tarBuffer = await gunzipAsync(content);

  // Walk tar entries looking for manifest.yaml
  let offset = 0;
  while (offset < tarBuffer.length - TAR_BLOCK_SIZE) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    // Check for end-of-archive (all zeros)
    if (header.every(b => b === 0)) break;

    const name = header.subarray(0, 100).toString('utf8').replace(/\0+$/, '');
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0+$/, '').trim();
    const fileSize = parseInt(sizeStr, 8);

    offset += TAR_BLOCK_SIZE;

    if (name.endsWith('/manifest.yaml') || name === 'manifest.yaml') {
      const fileContent = tarBuffer.subarray(offset, offset + fileSize).toString('utf8');
      return parseYaml(fileContent) as Record<string, unknown>;
    }

    // Skip to next block boundary
    const blocks = Math.ceil(fileSize / TAR_BLOCK_SIZE);
    offset += blocks * TAR_BLOCK_SIZE;
  }

  throw new Error(`manifest.yaml not found in archive: ${archivePath}`);
}

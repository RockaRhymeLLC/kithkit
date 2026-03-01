#!/usr/bin/env python3
"""
Import CC4Me memories into kithkit daemon.

Reads flat markdown files with YAML frontmatter from the CC4Me memory
directory and POSTs them to the local kithkit daemon's memory API.

Usage:
  python3 import-cc4me-memories.py [--source DIR] [--daemon URL] [--dry-run]

Defaults:
  --source  ~/cc4me_r2d2/.claude/state/memory/memories/
  --daemon  http://localhost:3847

Requirements: Python 3.9+ (stdlib only, no pip dependencies)
"""

import argparse
import glob
import json
import logging
import os
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

# ── Category remapping (migration 010 taxonomy) ──────────────

CATEGORY_REMAP = {
    'architecture': 'operational',
    'infrastructure': 'operational',
    'bugfix': 'operational',
    'tool': 'operational',
    'account': 'operational',
    'fact': 'operational',
    'debugging': 'operational',
    'workflow': 'procedural',
}

# Valid categories after migration 010
VALID_CATEGORIES = {
    'core', 'preference', 'person', 'operational',
    'decision', 'procedural', 'episodic',
}

# Default importance by category (matches migration 010)
DEFAULT_IMPORTANCE = {
    'core': 5,
    'preference': 4,
    'person': 4,
    'operational': 3,
    'decision': 3,
    'procedural': 3,
    'episodic': 1,
}

# ── YAML frontmatter parser (stdlib, no PyYAML needed) ────────

def parse_frontmatter(text):
    """Parse YAML frontmatter from markdown text. Returns (frontmatter_dict, body)."""
    if not text.startswith('---'):
        return {}, text

    # Find closing ---
    end = text.find('\n---', 3)
    if end == -1:
        return {}, text

    yaml_block = text[4:end].strip()
    body = text[end + 4:].strip()

    # Simple YAML parser for flat key-value pairs and lists
    fm = {}
    current_key = None
    for line in yaml_block.split('\n'):
        line = line.rstrip()

        # List item (continuation of previous key)
        if line.startswith('  - ') or line.startswith('- '):
            if current_key and current_key in fm and isinstance(fm[current_key], list):
                val = line.lstrip(' ').lstrip('-').strip()
                # Strip quotes
                if (val.startswith('"') and val.endswith('"')) or \
                   (val.startswith("'") and val.endswith("'")):
                    val = val[1:-1]
                fm[current_key].append(val)
            continue

        # Key: value pair
        match = re.match(r'^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)', line)
        if match:
            key = match.group(1)
            val = match.group(2).strip()

            # Strip quotes
            if (val.startswith('"') and val.endswith('"')) or \
               (val.startswith("'") and val.endswith("'")):
                val = val[1:-1]

            # Empty value followed by list items
            if val == '' or val == '[]':
                fm[key] = []
                current_key = key
                continue

            # Inline list: [item1, item2]
            if val.startswith('[') and val.endswith(']'):
                items = val[1:-1].split(',')
                fm[key] = [i.strip().strip('"').strip("'") for i in items if i.strip()]
                current_key = key
                continue

            # Numeric
            if re.match(r'^-?\d+$', val):
                fm[key] = int(val)
            elif re.match(r'^-?\d+\.\d+$', val):
                fm[key] = float(val)
            # Boolean
            elif val.lower() in ('true', 'yes'):
                fm[key] = True
            elif val.lower() in ('false', 'no'):
                fm[key] = False
            else:
                fm[key] = val

            current_key = key

    return fm, body


# ── Dedup check ───────────────────────────────────────────────

def get_existing_contents(daemon_url):
    """Fetch existing memory contents for dedup. Returns set of content hashes."""
    try:
        req = urllib.request.Request(
            f'{daemon_url}/api/memory/search',
            data=json.dumps({'query': '', 'limit': 10000}).encode(),
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        resp = urllib.request.urlopen(req, timeout=30)
        data = json.loads(resp.read().decode())
        memories = data.get('data', data.get('results', []))
        # Use first 200 chars of content as dedup key
        return {m.get('content', '')[:200] for m in memories if m.get('content')}
    except Exception as e:
        logging.warning(f'Could not fetch existing memories for dedup: {e}')
        return set()


# ── Import logic ──────────────────────────────────────────────

def remap_category(category):
    """Remap CC4Me category to migration 010 taxonomy."""
    if not category:
        return 'operational'
    # Handle list values (e.g. [decision, technical]) — take first element
    if isinstance(category, list):
        category = category[0] if category else 'operational'
    cat = str(category).lower().strip()
    if cat in CATEGORY_REMAP:
        return CATEGORY_REMAP[cat]
    if cat in VALID_CATEGORIES:
        return cat
    return 'operational'


def build_content(subject, body):
    """Build memory content from subject and body."""
    if subject and body:
        # Avoid double heading if body already starts with a heading
        first_line = body.split('\n', 1)[0].strip()
        if first_line.startswith('#'):
            return body
        return f'# {subject}\n\n{body}'
    if subject:
        return subject
    if body:
        return body
    return ''


def import_file(filepath, daemon_url, existing_contents, dry_run=False):
    """Parse and import a single memory file. Returns (success, skipped, error_msg)."""
    try:
        text = Path(filepath).read_text(encoding='utf-8', errors='replace')
    except Exception as e:
        return False, False, f'Read error: {e}'

    fm, body = parse_frontmatter(text)

    if not fm and not body.strip():
        return False, True, 'Empty file'

    # Build content
    subject = fm.get('subject', '')
    content = build_content(subject, body)

    if not content.strip():
        return False, True, 'No content'

    # Dedup check
    content_key = content[:200]
    if content_key in existing_contents:
        return False, True, 'Duplicate'

    # Map fields
    category = remap_category(fm.get('category', ''))
    importance = fm.get('importance')
    if isinstance(importance, int) and 1 <= importance <= 5:
        pass
    else:
        importance = DEFAULT_IMPORTANCE.get(category, 3)

    tags = fm.get('tags', [])
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(',') if t.strip()]

    source = fm.get('source', 'cc4me-import')
    created_at = fm.get('date', '')

    # Build API payload
    payload = {
        'content': content,
        'category': category,
        'importance': importance,
        'tags': tags,
        'source': source if source else 'cc4me-import',
    }

    if created_at:
        payload['created_at'] = created_at

    if dry_run:
        return True, False, None

    # POST to daemon
    try:
        req = urllib.request.Request(
            f'{daemon_url}/api/memory/store',
            data=json.dumps(payload).encode(),
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        resp = urllib.request.urlopen(req, timeout=10)
        resp.read()
        existing_contents.add(content_key)
        return True, False, None
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()[:200]
        return False, False, f'HTTP {e.code}: {err_body}'
    except Exception as e:
        return False, False, f'Request error: {e}'


def main():
    parser = argparse.ArgumentParser(description='Import CC4Me memories into kithkit')
    parser.add_argument('--source', default=os.path.expanduser(
        '~/cc4me_r2d2/.claude/state/memory/memories/'),
        help='Source directory with .md memory files')
    parser.add_argument('--daemon', default='http://localhost:3847',
        help='Kithkit daemon URL')
    parser.add_argument('--dry-run', action='store_true',
        help='Parse and validate without importing')
    parser.add_argument('--batch-delay', type=float, default=0.05,
        help='Delay between requests in seconds (default: 0.05 = 20/sec)')
    parser.add_argument('--log-file', default='memory-import.log',
        help='Error log file path')
    args = parser.parse_args()

    # Setup logging
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(message)s',
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(args.log_file),
        ],
    )

    # Validate source directory
    if not os.path.isdir(args.source):
        logging.error(f'Source directory not found: {args.source}')
        sys.exit(1)

    # Find all .md files
    files = sorted(glob.glob(os.path.join(args.source, '*.md')))
    if not files:
        # Try recursive
        files = sorted(glob.glob(os.path.join(args.source, '**', '*.md'), recursive=True))

    if not files:
        logging.error(f'No .md files found in {args.source}')
        sys.exit(1)

    logging.info(f'Found {len(files)} memory files in {args.source}')

    if args.dry_run:
        logging.info('DRY RUN — no data will be imported')
    else:
        # Check daemon health
        try:
            resp = urllib.request.urlopen(f'{args.daemon}/health', timeout=5)
            health = json.loads(resp.read().decode())
            logging.info(f'Daemon healthy: {health.get("status")} (extension: {health.get("extension")})')
        except Exception as e:
            logging.error(f'Cannot reach daemon at {args.daemon}: {e}')
            sys.exit(1)

    # Fetch existing memories for dedup
    logging.info('Fetching existing memories for dedup check...')
    existing = get_existing_contents(args.daemon) if not args.dry_run else set()
    logging.info(f'Found {len(existing)} existing memories')

    # Import
    imported = 0
    skipped = 0
    errors = 0
    start_time = time.time()

    for i, filepath in enumerate(files, 1):
        filename = os.path.basename(filepath)
        success, was_skipped, err = import_file(filepath, args.daemon, existing, args.dry_run)

        if success:
            imported += 1
        elif was_skipped:
            skipped += 1
        else:
            errors += 1
            logging.error(f'[{i}/{len(files)}] FAILED {filename}: {err}')

        # Progress every 100 files
        if i % 100 == 0:
            elapsed = time.time() - start_time
            rate = i / elapsed if elapsed > 0 else 0
            logging.info(f'[{i}/{len(files)}] imported={imported} skipped={skipped} errors={errors} ({rate:.0f} files/sec)')

        # Rate limiting
        if not args.dry_run and args.batch_delay > 0:
            time.sleep(args.batch_delay)

    # Final summary
    elapsed = time.time() - start_time
    logging.info('=' * 60)
    logging.info(f'Import complete in {elapsed:.1f}s')
    logging.info(f'  Total files:  {len(files)}')
    logging.info(f'  Imported:     {imported}')
    logging.info(f'  Skipped:      {skipped} (empty/duplicate)')
    logging.info(f'  Errors:       {errors}')
    logging.info(f'  Rate:         {len(files) / elapsed:.0f} files/sec')

    if errors > 0:
        logging.info(f'  Error details in: {args.log_file}')

    sys.exit(0 if errors == 0 else 1)


if __name__ == '__main__':
    main()

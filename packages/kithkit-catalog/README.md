# Kithkit Catalog

Signed skill catalog for Kithkit — the AI assistant toolkit.

## Structure

```
index.json              # Signed catalog index
revoked.json            # Signed revocation list
catalog-authority.pub   # Catalog authority public key
archives/               # Skill archives (.tar.gz)
  weather-check/
    weather-check-1.0.0.tar.gz
  code-review/
    code-review-1.0.0.tar.gz
    code-review-1.1.0.tar.gz
.github/workflows/      # CI pipeline
CONTRIBUTING.md         # Author submission guide
```

## Index Format

The `index.json` is a signed JSON document:

```json
{
  "version": 1,
  "updated": "2026-02-21T00:00:00.000Z",
  "skills": [
    {
      "name": "weather-check",
      "description": "Check weather forecasts for any location",
      "author": { "name": "Jane Doe", "github": "janedoe" },
      "capabilities": { "required": ["web_fetch", "notification"] },
      "tags": ["weather", "utility"],
      "category": "utilities",
      "trust_level": "community",
      "latest": "1.0.0",
      "versions": {
        "1.0.0": {
          "version": "1.0.0",
          "archive": "archives/weather-check/weather-check-1.0.0.tar.gz",
          "sha256": "abc123...",
          "signature": "base64...",
          "size": 2048,
          "published": "2026-02-21T00:00:00.000Z"
        }
      }
    }
  ],
  "signature": "base64..."
}
```

The index is deterministically generated:
- Skills sorted by name
- Keys sorted alphabetically at all nesting levels
- Canonical JSON serialization (no whitespace variation)

## Verification

Verify the index signature:

```bash
KITHKIT_CATALOG_PUBLIC_KEY=$(cat catalog-authority.pub) kithkit-catalog verify index.json
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full submission workflow.

## Key Custody

- **GitHub Actions secret**: `KITHKIT_CATALOG_PRIVATE_KEY` (used by CI to sign on merge)
- **Public key**: `catalog-authority.pub` (used by clients to verify)
- **Rotation**: New keypair, re-sign all archives, update public key, announce

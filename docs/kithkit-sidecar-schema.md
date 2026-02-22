# .kithkit.json Sidecar Schema

Every installed skill includes a `.kithkit.json` sidecar file for catalog provenance tracking.

## Schema

```json
{
  "origin": "kithkit-catalog",
  "name": "@scope/skill-name",
  "version": "1.0.0",
  "installedAt": "2026-02-22T00:00:00Z",
  "signature": "base64-encoded-ed25519-signature",
  "integrity": "sha256-hash-of-skill-contents"
}
```

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `origin` | string | yes | Source catalog identifier |
| `name` | string | yes | Fully qualified skill name |
| `version` | string | yes | Semantic version at install time |
| `installedAt` | string | yes | ISO 8601 timestamp |
| `signature` | string | yes | Ed25519 signature from catalog publisher |
| `integrity` | string | yes | SHA-256 hash for tamper detection |

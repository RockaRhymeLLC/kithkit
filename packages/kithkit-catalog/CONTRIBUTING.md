# Contributing Skills to the Kithkit Catalog

## Author Identity

For v1, your GitHub account is your author identity. When you submit a skill via PR, your GitHub username is recorded as the author.

**Known limitation**: There is no cryptographic binding between your GitHub identity and any signing key. Key attestation is planned for v2.

## Submission Workflow

### 1. Create your skill

A skill is a directory containing:

- `manifest.yaml` (required) — Skill metadata, capabilities, config
- `SKILL.md` (required) — Instructions for the AI assistant
- `reference.md` (optional) — Additional context documents
- `CHANGELOG.md` (optional) — Version history

### 2. Lint locally

Install the linter and check your skill before submitting:

```bash
npm install -g @kithkit/linter
kithkit-lint ./my-skill/
```

Fix any errors or warnings before proceeding.

### 3. Package as archive

Create a `.tar.gz` archive of your skill directory:

```bash
tar czf my-skill-1.0.0.tar.gz my-skill/
```

The archive should contain a single top-level directory named after your skill, with all files inside.

### 4. Fork and submit PR

1. Fork the `kithkit-catalog` repository
2. Place your archive at `archives/{skill-name}/{skill-name}-{version}.tar.gz`
3. Open a pull request to the main repository
4. CI will automatically lint your submission
5. If all checks pass, a maintainer will review and merge

### 5. After merge

Once merged, CI will:
- Sign your archive with the catalog authority key
- Update `index.json` with your skill's metadata
- Your skill is now discoverable and installable

## Archive Format

- **Format**: `.tar.gz` (gzipped tar)
- **Structure**: Single top-level directory matching skill name
- **Location**: `archives/{skill-name}/{skill-name}-{version}.tar.gz`
- **Naming**: Lowercase, hyphens only (e.g., `weather-check-1.0.0.tar.gz`)

## Manifest Requirements

See the [manifest schema documentation](https://github.com/kithkit/kithkit-catalog/blob/main/README.md#manifest-schema) for required and optional fields.

## Key Custody

The catalog authority key is managed as follows:
- **CI signing**: Private key stored as GitHub Actions secret (`KITHKIT_CATALOG_PRIVATE_KEY`)
- **Manual operations**: Private key in operator's macOS Keychain
- **Public key**: Published in `catalog-authority.pub` at the repository root
- **Rotation**: Documented in SECURITY.md (when created)
- **Access**: Repository maintainers only

## Trust Levels

- **first-party**: Skills published by the Kithkit team
- **verified**: Skills from authors with verified identity
- **community**: Community-submitted skills (default)

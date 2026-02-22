---
description: Discover, install, and manage skills from the Kithkit catalog
user_invocable: true
---

# /kithkit — Skills Catalog Client

Search, install, update, and manage skills from the Kithkit skills catalog.

## Commands

### kithkit search

Search the catalog for skills by name, tags, or capabilities.

```
kithkit search <query>
```

Displays matching skills with name, version, trust level, description, tags, and capabilities.

### kithkit install

Install a skill from the catalog with full signature verification.

```
kithkit install <skill-name> [--version <version>]
```

The install process:
1. Fetches the catalog index and verifies its signature
2. Downloads the skill archive
3. Verifies archive hash matches the index entry
4. Verifies the archive signature against the catalog public key
5. Extracts files to `.claude/skills/<skill-name>/`
6. Writes `.kithkit.json` metadata sidecar with provenance info
7. Generates `config.yaml` from the skill's manifest schema (if applicable)

### kithkit update

Check for and apply skill updates.

```
kithkit update <skill-name>
kithkit update --all
```

Compares installed version against catalog. On upgrade, preserves existing `config.yaml` values and marks new required fields for setup.

### kithkit uninstall

Remove an installed skill. Backs up user config for potential restore.

```
kithkit uninstall <skill-name>
```

### kithkit list

List all installed skills with version and update availability.

```
kithkit list
```

### kithkit selftest

Run the security self-test suite against a skill to evaluate its safety.

```
kithkit selftest <skill-name>
```

Runs Tier 1 (obvious threats) and Tier 2 (concealed threats) test cases. Reports catch rate, per-tier breakdown, and recommendations.

## Trust Levels

Skills have three trust levels that determine how you should handle them:

### First-party
Skills published by the Kithkit team. These are reviewed, tested, and signed with the catalog authority key. Install and configure without additional confirmation.

### Verified
Skills from known authors who have been verified by the Kithkit team. These undergo automated linting and signing. Review the skill description and proceed with install. Mention to the human what the skill does.

### Community
Skills from unverified authors. These are linted and signed but not manually reviewed. **Always ask for human confirmation** before installing community skills. Run `kithkit selftest` after install to check for security issues.

## Risk Communication

When presenting skill information to humans, use natural conversation — not disclaimers or warning banners.

### What not to do

Do not use formal disclaimer language, warning icons, or legalese. Do not say things like "WARNING: This skill has not been verified" or "CAUTION: Install at your own risk." These are unhelpful and create alert fatigue.

### Examples of good communication

For a first-party skill:
> "Looks straightforward — this is a first-party Kithkit skill. Want me to install it?"

For a verified skill:
> "This is from a verified author. It adds calendar sync with Google Calendar. Want me to set it up?"

For a community skill:
> "This one's from a community author I don't recognize. It looks like it adds Slack integration. Want me to install it and run a security check first, or would you rather skip it?"

After a selftest with findings:
> "The security check flagged one thing — it tries to read from the keychain, which is unusual for a weather skill. Want me to show you the details?"

### Always get human confirmation for community skills

Community skills have not been manually reviewed. Before installing:
1. Tell the human who made it and what it does
2. Mention it's community-contributed
3. Ask if they want to proceed
4. After install, offer to run `kithkit selftest`

## Security

- All archives are cryptographically signed (Ed25519) by the catalog authority
- Archive integrity is verified via SHA-256 hash before extraction
- The catalog index itself is signed — tampered indexes are rejected
- Revoked skills are blocked at install time with a reason shown
- Path traversal in archives is prevented (no `..` components, no absolute paths)
- Skills are statically analyzed by the linter for executable files, prompt injection, Unicode attacks

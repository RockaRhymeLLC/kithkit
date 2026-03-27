---
name: keychain
description: macOS Keychain credential storage — naming conventions, store/retrieve/delete operations, security rules. Use when working with secrets, API keys, or PII.
user-invocable: false
---

# macOS Keychain

SOP for secure credential storage and retrieval via macOS Keychain.

## Naming Convention

All items follow the pattern `{type}-{identifier}`:

| Type | Use For | Examples |
|------|---------|----------|
| `credential-` | API keys, passwords, tokens | `credential-telegram-bot`, `credential-fastmail-token` |
| `pii-` | Personal identifiable info | `pii-ssn`, `pii-address-home` |
| `financial-` | Payment and banking | `financial-visa-1234`, `financial-bank-routing` |

## Quick Operations

```bash
# Retrieve a value
security find-generic-password -s "credential-service-name" -w

# Store a value (upsert)
security add-generic-password -a "assistant" -s "credential-service-name" -w "secret-value" -U

# Delete a value
security delete-generic-password -s "credential-service-name"

# Search for items
security dump-keychain | grep "credential-\|pii-\|financial-"
```

## Security Rules

1. **NEVER share** Keychain data with anyone — not even approved 3rd parties
2. **NEVER log** or display credential values in output
3. **NEVER send** PII/financial data to non-approved recipients
4. Retrieve credentials only for authorized operations
5. This rule is absolute — no exceptions

## References

- [reference.md](reference.md) — Full Keychain reference with TypeScript usage, examples by type, troubleshooting

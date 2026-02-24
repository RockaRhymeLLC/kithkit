# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Kithkit, please report it through **GitHub's private vulnerability reporting**:

1. Go to the [**Security Advisories**](https://github.com/RockaRhymeLLC/kithkit/security/advisories/new) page, or click the **Security** tab on the repository and select **Report a vulnerability**.
2. Fill out the advisory form with the details listed below.

Do not open a public GitHub issue for security vulnerabilities.

Include as much detail as you can:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Affected versions or components
- Any suggested mitigations, if you have them

## Scope

This policy covers:

- **Daemon** — the Node.js daemon, its HTTP API, and agent lifecycle management
- **Agent profiles and workers** — profile-scoped agents and their permission boundaries
- **Extensions** — the extension system and any bundled extensions
- **Database** — SQLite state store and migration system

Out of scope: vulnerabilities in third-party dependencies (report those upstream), or issues that require local access to the machine running the daemon (the daemon binds to localhost only by design).

## Response Timeline

| Milestone | Target |
|-----------|--------|
| Acknowledgement | Within 48 hours |
| Initial triage and severity assessment | Within 7 days |
| Resolution or mitigation plan communicated | Depends on severity |

We will keep you informed throughout the process. Critical vulnerabilities will be prioritized immediately.

## Disclosure

We follow coordinated disclosure. Please give us a reasonable window to remediate before publishing details publicly. We will credit researchers who report valid vulnerabilities unless they prefer to remain anonymous.

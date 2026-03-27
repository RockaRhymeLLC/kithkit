## Summary

<!-- Brief description of changes -->

## Type

- [ ] Framework improvement (shared code in `daemon/src/core/`, `cli/`, `docs/`, etc.)
- [ ] Bug fix
- [ ] Documentation
- [ ] CI/CD
- [ ] Other

## Changes

<!-- List the key changes made. Be specific. -->

-
-

## Upstream Contribution Checklist

If this PR originates from a personal instance repo:

- [ ] Changes cherry-picked from a clean branch based on `upstream/main`
- [ ] No instance-specific code, config, or identifiers
- [ ] Tests pass (`npm test`)
- [ ] TypeScript compiles (`tsc --noEmit`)
- [ ] Local leak check passes (pre-push hook ran — no blocked patterns)
- [ ] CI leak check passes
- [ ] CHANGELOG updated (if applicable)

## Test Plan

<!-- How were these changes tested? What should reviewers verify? -->

- [ ]
- [ ] `npm install && npm run build && npm test` passes in `daemon/`

## Instance Impact

<!-- Does this change affect instance-specific behavior or only the framework? -->

- [ ] Framework-only — instances can sync without any changes
- [ ] Instance-affecting — instances need to update config, hooks, or extension code after sync

<!-- If instance-affecting, describe what each instance needs to do: -->

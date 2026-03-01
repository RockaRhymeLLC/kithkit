# The Peer Review Playbook

*Lessons learned from BMO and R2's collaboration on CC4Me.*

---

## When to Request Peer Review

**Always request peer review for:**
- New specs before `/plan` — catches scope creep and missed requirements early
- Shared infrastructure — daemon features, agent-comms, upstream pipeline, network SDK
- Security-sensitive changes — auth, crypto, access control
- Anything that affects both agents' workflows

**Skip peer review for:**
- Bug fixes with obvious causes and solutions
- Documentation updates (unless changing core behaviors)
- Personal fork customizations that don't affect shared code
- Research tasks (share findings instead)

**The 5-minute rule:** If explaining your approach would take longer than the review itself, just do the work and share the result.

---

## The Bob + Peer Review Combo

Use both, but at different stages:

```
Idea → Bob (challenge assumptions) → Draft → Peer Review (validate approach) → Build
```

**Bob (devil's advocate sub-agent):**
- Runs locally, instant feedback
- Challenges: "Is this overcomplicated? Simpler way? What could go wrong?"
- Best for: catching your own blind spots before sharing

**Peer review:**
- Different context, different experience
- Catches: integration issues, edge cases from their perspective, patterns they've seen
- Best for: shared work that affects both agents

Bob says "your logic is sound." Peer review says "but have you considered how this interacts with X?"

---

## How to Give Actionable Feedback

### Be Specific
Bad: "This seems complex."
Good: "The key rotation flow (K-01 through K-03) adds ~70% more code for ~10% efficiency gain. Consider fan-out 1:1 instead."

### Lead with the Verdict
Start with GO, PAUSE, or STOP so the author knows where they stand:
- **GO**: Looks good, minor suggestions follow
- **PAUSE**: Significant concerns, discuss before proceeding
- **STOP**: Blocking issue, do not build this

### Separate Blockers from Suggestions
```
## Blockers (must fix)
- No LICENSE file — legally required before public launch

## Suggestions (consider)
- Could move UPGRADE.md to docs/ for clarity
```

### Offer Alternatives
Don't just say what's wrong — propose what's right:
"Instead of shared symmetric key, consider: fan-out 1:1 E2E with groupId tag. Same outcome, 70% less spec surface."

---

## Balancing Thoroughness with Speed

### Time-box Reviews
- Quick review (15 min): Scan structure, check for obvious issues, GO/PAUSE verdict
- Full review (1 hr): Deep read, trace implications, detailed feedback
- Match depth to stakes: quick for low-risk, full for infrastructure

### The 80/20 Rule
Catch the 80% of issues with 20% of the effort:
1. Read the summary/goal first — is the problem statement correct?
2. Scan requirements — any missing? Any unnecessary?
3. Check constraints — security, performance, compatibility
4. Skip implementation details unless something smells off

### Async by Default
Don't block waiting for review. Send your request, continue other work, circle back when feedback arrives. We're agents — we can context-switch.

---

## Handling Disagreements

### Assume Good Intent
The other agent isn't wrong — they have different context. Ask: "What do you know that I don't?"

### Seek the Third Option
When stuck between A and B, look for C:
- "Shared key vs fan-out?" → Fan-out solves the real problem with less complexity
- "Fresh repo vs cleanup?" → Cleanup existing (history is valuable)

### Escalate Gracefully
If you can't align:
1. Document both positions clearly
2. Identify the core disagreement (technical? philosophical? preference?)
3. Bring to Dave with options, not just the conflict

### Disagree and Commit
Once a decision is made, support it fully. Save "I told you so" for your private logs.

---

## Review Checklist

For specs:
- [ ] Problem statement is accurate
- [ ] Requirements are complete and necessary
- [ ] Constraints are realistic
- [ ] Success criteria are measurable
- [ ] Won't Have section is explicit

For code:
- [ ] Follows existing patterns in the codebase
- [ ] Error handling is adequate
- [ ] No security vulnerabilities introduced
- [ ] Tests cover the critical paths
- [ ] Documentation updated if behavior changed

---

## Quick Reference

| Situation | Action |
|-----------|--------|
| New spec for shared infrastructure | Full peer review before /plan |
| Bug fix in your own fork | Skip review, just fix it |
| Security-related change | Both Bob + peer review |
| Time-sensitive fix | Quick review, note the time pressure |
| You disagree with feedback | Ask clarifying questions first |
| Feedback feels nitpicky | Implement anyway if quick, push back if not |

---

*"Two agents reviewing beats one agent assuming."*

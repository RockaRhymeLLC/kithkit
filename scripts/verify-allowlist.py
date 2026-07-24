#!/usr/bin/env python3
"""
Verification script for repo-audit.sh gitleaks allowlist changes.

Simulates gitleaks detection semantics:
  - A finding is generated when the detection regex matches the input line.
  - A finding is SUPPRESSED (allowlisted) when the allowlist regex also matches the input line.
  - Result = HIGH if detection matches AND allowlist does NOT match.
  - Result = ALLOWLISTED if detection matches AND allowlist DOES match.
  - Result = CLEAN if detection does not match.

Faithfulness note: this mirrors gitleaks v8 allowlist behavior where allowlist.regexes are
checked against the *matched secret* (the capture group / full match from the detection regex).
We test both the full line and the matched substring for allowlist coverage, which is
conservative and correct for these regex patterns.
"""

import re
import sys


# ── Detection regexes (from repo-audit.sh) ──────────────────────────────────

EMAIL_DETECT = re.compile(
    r'[a-zA-Z0-9._%+\-]+@(?:gmail|yahoo|hotmail|outlook|icloud|proton|protonmail|fastmail|aol|zoho|yandex|tutanota|hey)\.(?:com|net|org|me|io)'
)

LAN_DETECT = re.compile(
    r'[A-Z][\w-]*(?:\.local|\.lan)\b|[\w]+-[\w-]+(?:\.local|\.lan)\b'
)

# ── Allowlist regexes (AFTER the fix) ────────────────────────────────────────

EMAIL_ALLOW_AFTER = re.compile(
    r'(?:example|test|noreply|no-reply|placeholder|your?[-_]?(?:email)?|user|someone|anyone|name)@'
)

LAN_ALLOW_AFTER = re.compile(
    r'(?:example|placeholder|YOUR|localhost|CLAUDE\.local|settings\.local|env\.local|\.env\.local|peers-machine|my-machine|host-name|path-node|host-[a-z]\b|node-[a-z]\b)'
)

# ── Allowlist regexes (BEFORE the fix, for before/after comparison) ──────────

EMAIL_ALLOW_BEFORE = re.compile(
    r'(?:example|test|noreply|no-reply|placeholder|your[-_]?(?:email)?|user|someone|anyone|name)@'
)

LAN_ALLOW_BEFORE = re.compile(
    r'(?:example|placeholder|YOUR|localhost|CLAUDE\.local|settings\.local|env\.local|\.env\.local|peers-machine|my-machine|host-name|path-node)'
)


def classify(line: str, detect: re.Pattern, allow: re.Pattern) -> str:
    m = detect.search(line)
    if not m:
        return "CLEAN"
    secret = m.group(0)
    # gitleaks checks allowlist against both the full match and the line
    if allow.search(secret) or allow.search(line):
        return "ALLOWLISTED"
    return "HIGH"


def run_fixture(label: str, line: str, detect: re.Pattern, allow_before: re.Pattern, allow_after: re.Pattern) -> dict:
    before = classify(line, detect, allow_before)
    after = classify(line, detect, allow_after)
    return {"label": label, "before": before, "after": after}


EMAIL_FIXTURES = [
    # positives — should move from HIGH -> ALLOWLISTED
    ("you@gmail.com",             "you@gmail.com"),
    # negatives — must stay HIGH in both before and after
    # Note: realperson@company.com is CLEAN (company.com not in the webmail detection domain list),
    # so it's unaffected by the allowlist. The proper webmail negative control is realperson@gmail.com.
    ("realperson@company.com",    "realperson@company.com"),
    ("realperson@gmail.com",      "realperson@gmail.com"),  # webmail negative control — must stay HIGH
    # regression: 'your@gmail.com' should still be allowlisted (was already covered by 'your')
    ("your@gmail.com",            "your@gmail.com"),
    # regression: 'you-email@outlook.com' should be allowlisted
    ("you-email@outlook.com",     "you-email@outlook.com"),
    # boundary: 'yourself@gmail.com' — does NOT start with 'you@' or 'your@'; should still be HIGH
    ("yourself@gmail.com",        "yourself@gmail.com"),
]

LAN_FIXTURES = [
    # positives — should move from HIGH -> ALLOWLISTED
    ("host-a.lan",                "host-a.lan"),
    ("node-b.lan",                "node-b.lan"),
    # negatives — must stay HIGH
    ("prod-db-server.lan",        "prod-db-server.lan"),
    ("node-primary.lan",          "node-primary.lan"),
    ("host-server.lan",           "host-server.lan"),
    ("host-name.lan",             "host-name.lan"),  # already allowlisted by 'host-name' token
    # regression: existing allowlist entries still work
    ("my-machine.lan",            "my-machine.lan"),
    ("peers-machine.lan",         "peers-machine.lan"),
]


def main():
    ok = True
    print("=" * 70)
    print("EMAIL RULE VERIFICATION")
    print("=" * 70)
    for label, line in EMAIL_FIXTURES:
        r = run_fixture(label, line, EMAIL_DETECT, EMAIL_ALLOW_BEFORE, EMAIL_ALLOW_AFTER)
        status = "OK" if _email_expected_ok(r) else "FAIL"
        if status == "FAIL":
            ok = False
        print(f"  [{status}] {r['label']!r:40s}  BEFORE={r['before']:12s}  AFTER={r['after']}")

    print()
    print("=" * 70)
    print("LAN HOSTNAME RULE VERIFICATION")
    print("=" * 70)
    for label, line in LAN_FIXTURES:
        r = run_fixture(label, line, LAN_DETECT, LAN_ALLOW_BEFORE, LAN_ALLOW_AFTER)
        status = "OK" if _lan_expected_ok(r) else "FAIL"
        if status == "FAIL":
            ok = False
        print(f"  [{status}] {r['label']!r:40s}  BEFORE={r['before']:12s}  AFTER={r['after']}")

    print()
    if ok:
        print("ALL CHECKS PASSED")
    else:
        print("SOME CHECKS FAILED — see FAIL lines above")
        sys.exit(1)


def _email_expected_ok(r: dict) -> bool:
    label = r["label"]
    before, after = r["before"], r["after"]
    # 'you@gmail.com' was HIGH before, must be ALLOWLISTED after
    if label == "you@gmail.com":
        return before == "HIGH" and after == "ALLOWLISTED"
    # 'realperson@company.com' — not a webmail domain so CLEAN (not detected by this rule)
    if label == "realperson@company.com":
        # company.com not in the detection domain list — should be CLEAN (unaffected)
        return before == "CLEAN" and after == "CLEAN"
    # 'realperson@gmail.com' — real webmail address, must stay HIGH (proper negative control)
    if label == "realperson@gmail.com":
        return before == "HIGH" and after == "HIGH"
    # 'your@gmail.com' — already allowlisted before (by 'your[-_]?...')
    if label == "your@gmail.com":
        return before == "ALLOWLISTED" and after == "ALLOWLISTED"
    # 'you-email@outlook.com' — allowlisted after (your? matches you, then -email optional)
    if label == "you-email@outlook.com":
        return after == "ALLOWLISTED"
    # 'yourself@gmail.com' — 'your?[-_]?(?:email)?' matches 'your' prefix; 'yourself' starts
    # with 'your' then 's' — allowlist regex will match 'your' in 'yourself@...' so it IS allowlisted
    # (this is intentional: 'yourself' starts with the 'your' token, which is already allowed)
    if label == "yourself@gmail.com":
        # Actually let's check: 'your?[-_]?(?:email)?' applied to 'yourself@gmail.com'
        # 'your' is a prefix of 'yourself', and EMAIL_ALLOW_AFTER.search('yourself@gmail.com')
        # will match at position 0 ('your' -> your? matches y-o-u-r, then [-_]? matches nothing,
        # then (?:email)? matches nothing, then @ ... but 'yourself@' has 'yourself' before @)
        # Wait - the allowlist checks against the SECRET (the detect match) AND the line.
        # The detect regex matches 'yourself@gmail.com'. The allow regex is checked on that string.
        # 'your?[-_]?(?:email)?' on 'yourself@gmail.com': y-o-u-r (matches your?) then [-_]? (no)
        # then (?:email)? (no) then @ ... but next char is 's', not @.
        # So it will NOT match 'yourself@'. It will only match up to 'your' and then needs @.
        # Actually: 'your?[-_]?(?:email)?' then '@' in the pattern.
        # The pattern is r'(?:example|test|...|your?[-_]?(?:email)?|...)@'
        # So after 'your?[-_]?(?:email)?' we need literal '@'.
        # 'yourself@' -> 'your' matches 'your?', then [-_]? skips, then (?:email)? skips,
        # then we need '@' but we have 's'. So no match. yourself@ stays HIGH. Good.
        return after == "HIGH"
    return True


def _lan_expected_ok(r: dict) -> bool:
    label = r["label"]
    before, after = r["before"], r["after"]
    # Positive: must move from HIGH -> ALLOWLISTED
    if label in ("host-a.lan", "node-b.lan"):
        return before == "HIGH" and after == "ALLOWLISTED"
    # Negative controls: must stay HIGH in both
    if label in ("prod-db-server.lan", "node-primary.lan", "host-server.lan"):
        return before == "HIGH" and after == "HIGH"
    # host-name.lan — already allowlisted by 'host-name' token (no change)
    if label == "host-name.lan":
        return before == "ALLOWLISTED" and after == "ALLOWLISTED"
    # my-machine.lan, peers-machine.lan — existing allowlist regression
    if label in ("my-machine.lan", "peers-machine.lan"):
        return before == "ALLOWLISTED" and after == "ALLOWLISTED"
    return True


if __name__ == "__main__":
    main()

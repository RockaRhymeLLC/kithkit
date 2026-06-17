"""
Tests for format_hint() in .claude/hooks/memory-context.py

Mutation-killing assertions:
  - A memory with origin_agent='bmo' MUST produce "[category, from: bmo] content"
  - A memory with origin_agent=None MUST produce "[category] content" (no attribution)
  - A memory with origin_agent='' (empty string) MUST also produce "[category] content"
"""

import importlib.util
import pathlib
import sys
import unittest

# Load the hyphen-named module by file path
_HOOK = pathlib.Path(__file__).parent.parent / "memory-context.py"
_spec = importlib.util.spec_from_file_location("memory_context", _HOOK)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

format_hint = _mod.format_hint


class TestFormatHintOriginAgent(unittest.TestCase):
    def test_bmo_authored_includes_attribution(self):
        """Memory from bmo must inject '[behavioral, from: bmo]' prefix."""
        memory = {
            "content": "BMO prefers batched curl calls",
            "category": "behavioral",
            "origin_agent": "bmo",
        }
        result = format_hint(memory)
        self.assertEqual(result, "  - [behavioral, from: bmo] BMO prefers batched curl calls")

    def test_self_authored_null_no_attribution(self):
        """Self-authored memory (origin_agent=None) must not include any attribution."""
        memory = {
            "content": "Always verify before reporting done",
            "category": "behavioral",
            "origin_agent": None,
        }
        result = format_hint(memory)
        self.assertEqual(result, "  - [behavioral] Always verify before reporting done")
        self.assertNotIn("from:", result)

    def test_self_authored_missing_key_no_attribution(self):
        """Memory dict with no origin_agent key (old records) must not include attribution."""
        memory = {
            "content": "Use hybrid search mode",
            "category": "technical",
        }
        result = format_hint(memory)
        self.assertEqual(result, "  - [technical] Use hybrid search mode")
        self.assertNotIn("from:", result)

    def test_empty_string_origin_agent_no_attribution(self):
        """Empty string origin_agent must be treated as absent — no attribution."""
        memory = {
            "content": "Check memory first",
            "category": "behavioral",
            "origin_agent": "",
        }
        result = format_hint(memory)
        self.assertEqual(result, "  - [behavioral] Check memory first")
        self.assertNotIn("from:", result)

    def test_non_bmo_agent_attribution(self):
        """Memory from any non-null origin_agent must include '[cat, from: agent]'."""
        memory = {
            "content": "Keep responses concise",
            "category": "preference",
            "origin_agent": "sudo",
        }
        result = format_hint(memory)
        self.assertEqual(result, "  - [preference, from: sudo] Keep responses concise")

    def test_no_category_with_origin_no_prefix(self):
        """No category → no prefix even if origin_agent is set."""
        memory = {
            "content": "Some content",
            "category": "",
            "origin_agent": "bmo",
        }
        result = format_hint(memory)
        self.assertEqual(result, "  - Some content")

    def test_truncation_preserved(self):
        """Long content is still truncated even with attribution."""
        long_content = "word " * 30  # well over MAX_CHARS_PER_HIT
        memory = {
            "content": long_content,
            "category": "technical",
            "origin_agent": "bmo",
        }
        result = format_hint(memory)
        self.assertTrue(result.startswith("  - [technical, from: bmo] "))
        self.assertTrue(result.endswith("…"))
        # Total length should not blow up beyond prefix + truncated content
        self.assertLessEqual(len(result), len("  - [technical, from: bmo] ") + _mod.MAX_CHARS_PER_HIT + 5)


if __name__ == "__main__":
    unittest.main()

import pytest

from src.services.embedding import sanitize_text


class TestSanitizeText:
    def test_normalizes_whitespace(self):
        assert sanitize_text("hello   world\n\nfoo") == "hello world foo"

    def test_removes_control_characters(self):
        text = "hello\x00\x01world"
        result = sanitize_text(text)
        assert "\x00" not in result
        assert "\x01" not in result
        assert "helloworld" in result

    def test_collapses_repeated_chars(self):
        assert sanitize_text("aaaaaaaaa") == "aaa"

    def test_truncates_long_text(self):
        long_text = "a" * 10000
        result = sanitize_text(long_text)
        # After collapsing repeats, should be "aaa", then truncated to max
        assert len(result) <= 5000

    def test_handles_unicode(self):
        result = sanitize_text("caf\u00e9 na\u00efve")
        assert "caf" in result

    def test_empty_after_sanitization(self):
        result = sanitize_text("   ")
        assert result == ""

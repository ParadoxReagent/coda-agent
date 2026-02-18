import logging
import re
from typing import Any

_ACCESS_PATH_RE = re.compile(r'"[A-Z]+ (?P<path>/[^ ]*) HTTP/\d(?:\.\d+)?"')


class SuppressHealthAccessFilter(logging.Filter):
    """Suppress noisy Uvicorn access logs for health checks."""

    def filter(self, record: logging.LogRecord) -> bool:
        path = self._extract_path(record)
        if path is None:
            return True
        return not path.startswith("/health")

    @staticmethod
    def _extract_path(record: logging.LogRecord) -> str | None:
        args: Any = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
            return args[2]

        message = record.getMessage()
        match = _ACCESS_PATH_RE.search(message)
        if not match:
            return None
        return match.group("path")

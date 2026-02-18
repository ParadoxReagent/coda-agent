import logging

from src.logging_filters import SuppressHealthAccessFilter


def _access_record(path: str) -> logging.LogRecord:
    return logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg='%s - "%s %s HTTP/%s" %d',
        args=("127.0.0.1:12345", "GET", path, "1.1", 200),
        exc_info=None,
    )


class TestSuppressHealthAccessFilter:
    def test_suppresses_health_endpoint(self):
        log_filter = SuppressHealthAccessFilter()
        assert log_filter.filter(_access_record("/health")) is False

    def test_keeps_non_health_endpoint(self):
        log_filter = SuppressHealthAccessFilter()
        assert log_filter.filter(_access_record("/search")) is True

    def test_suppresses_health_from_formatted_message(self):
        log_filter = SuppressHealthAccessFilter()
        record = logging.LogRecord(
            name="uvicorn.access",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg='127.0.0.1:12345 - "GET /health HTTP/1.1" 200',
            args=(),
            exc_info=None,
        )
        assert log_filter.filter(record) is False

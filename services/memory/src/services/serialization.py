import json
import logging
from collections.abc import Mapping
from typing import Any

logger = logging.getLogger(__name__)


def normalize_metadata(value: Any) -> dict[str, Any]:
    """Return metadata as an object, tolerating malformed legacy values."""
    if value is None:
        return {}

    if isinstance(value, Mapping):
        return dict(value)

    if isinstance(value, str):
        if not value.strip():
            return {}

        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            logger.warning("Dropping invalid metadata string value")
            return {}

        if isinstance(parsed, Mapping):
            return dict(parsed)

        logger.warning("Dropping non-object metadata JSON value (%s)", type(parsed).__name__)
        return {}

    try:
        return dict(value)
    except (TypeError, ValueError):
        logger.warning("Dropping non-mapping metadata value (%s)", type(value).__name__)
        return {}

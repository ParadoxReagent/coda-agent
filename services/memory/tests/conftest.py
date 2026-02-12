import pytest


@pytest.fixture
def sample_memory():
    return {
        "content": "The user prefers dark mode in all applications.",
        "content_type": "preference",
        "tags": ["ui", "settings"],
        "importance": 0.7,
    }


@pytest.fixture
def sample_memories():
    return [
        {
            "content": "The user's birthday is March 15th.",
            "content_type": "fact",
            "tags": ["personal"],
            "importance": 0.8,
        },
        {
            "content": "The user works as a software engineer at Acme Corp.",
            "content_type": "fact",
            "tags": ["work"],
            "importance": 0.6,
        },
        {
            "content": "The user prefers Python over JavaScript for backend work.",
            "content_type": "preference",
            "tags": ["coding"],
            "importance": 0.5,
        },
    ]

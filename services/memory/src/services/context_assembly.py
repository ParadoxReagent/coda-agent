from typing import Any


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token."""
    return max(1, len(text) // 4)


def assemble_context(
    ranked_results: list[dict[str, Any]],
    max_tokens: int = 1500,
) -> dict[str, Any]:
    """
    Build a token-aware context string from ranked memory results.
    Iterates in rank order, adding memories until budget is filled.
    """
    selected: list[dict[str, Any]] = []
    total_tokens = 0

    for result in ranked_results:
        content = result["content"]
        content_type = result.get("content_type", "unknown")
        tags = result.get("tags", [])

        # Format the memory block
        tag_str = f" [{', '.join(tags)}]" if tags else ""
        block = f"[{content_type}{tag_str}] {content}"
        block_tokens = estimate_tokens(block)

        if total_tokens + block_tokens > max_tokens:
            break

        selected.append(result)
        total_tokens += block_tokens

    # Build the assembled context
    if not selected:
        return {
            "context": "",
            "memory_count": 0,
            "total_tokens_estimate": 0,
        }

    lines: list[str] = []
    for r in selected:
        content_type = r.get("content_type", "unknown")
        tags = r.get("tags", [])
        tag_str = f" [{', '.join(tags)}]" if tags else ""
        lines.append(f"- [{content_type}{tag_str}] {r['content']}")

    context = "\n".join(lines)

    return {
        "context": context,
        "memory_count": len(selected),
        "total_tokens_estimate": total_tokens,
    }

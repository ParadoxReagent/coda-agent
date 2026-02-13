---
name: web-research
description: Research strategies using Firecrawl web scraping, crawling, and search tools
version: 1.0.0
---

# Web Research Skill

You have access to Firecrawl tools for web research. Use the following strategies depending on the task.

## Quick Fact-Finding

1. Use `firecrawl_search` with a focused query
2. Review the returned snippets and markdown
3. Synthesize findings into a concise answer with source citations

## Reading a Specific Page

1. Use `firecrawl_scrape` with the target URL
2. The content is returned as clean markdown, ready to analyze

## Exploring Documentation Sites

1. Use `firecrawl_map` on the docs root URL to discover all pages
2. Optionally filter with the `search` parameter to find relevant sections
3. Use `firecrawl_scrape` on the most relevant URLs, OR
4. Use `firecrawl_crawl` with `include_paths` to batch-fetch a section (e.g. `["/docs/api/*"]`)
5. Poll with `firecrawl_crawl_status` until complete

## Deep Research

1. Start with `firecrawl_search` to find relevant sources
2. Use `firecrawl_scrape` on the most promising result URLs
3. Cross-reference information across multiple sources
4. Summarize with citations

## Best Practices

- **Start narrow**: Use search or single scrapes before resorting to crawls
- **Limit crawl scope**: Always set `include_paths` or `exclude_paths` and keep `limit` low
- **Cite sources**: Always include the source URL when presenting information
- **Cache awareness**: Scrape and search results are cached (default 1 hour), so repeated calls to the same URL are fast
- **Content may be truncated**: Very long pages are capped; check the `truncated` flag and request specific sections if needed

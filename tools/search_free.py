#!/usr/bin/env python3
"""
免费搜索工具 - 基于 DuckDuckGo (ddgs)
替代 Kimi CLI 的 SearchWeb（当 moonshot_search 返回 402 时使用）
"""

import argparse
import json
import sys

try:
    from ddgs import DDGS
except ImportError:
    print("Error: ddgs not installed. Run: pip install ddgs", file=sys.stderr)
    sys.exit(1)


def search_text(query: str, limit: int = 5, include_content: bool = False):
    """DuckDuckGo 文本搜索"""
    with DDGS() as ddgs:
        results = ddgs.text(query, max_results=limit)
        output = []
        for r in results:
            item = {
                "title": r.get("title", ""),
                "url": r.get("href", ""),
                "snippet": r.get("body", ""),
            }
            if include_content:
                item["content"] = r.get("body", "")
            output.append(item)
        return output


def search_news(query: str, limit: int = 5):
    """DuckDuckGo 新闻搜索"""
    with DDGS() as ddgs:
        results = ddgs.news(query, max_results=limit)
        output = []
        for r in results:
            output.append({
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "snippet": r.get("body", ""),
                "source": r.get("source", ""),
                "date": r.get("date", ""),
            })
        return output


def format_results(results: list[dict]) -> str:
    lines = []
    for i, r in enumerate(results, 1):
        lines.append(f"{i}. {r['title']}")
        lines.append(f"   URL: {r['url']}")
        if r.get("source"):
            lines.append(f"   Source: {r['source']} | Date: {r.get('date', '')}")
        lines.append(f"   Summary: {r['snippet']}")
        if r.get("content"):
            lines.append(f"   Content: {r['content']}")
        lines.append("")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Free web search via DuckDuckGo")
    parser.add_argument("query", help="Search query")
    parser.add_argument("--limit", "-l", type=int, default=5, help="Max results (1-20)")
    parser.add_argument("--content", "-c", action="store_true", help="Include full content/snippets")
    parser.add_argument("--json", "-j", action="store_true", help="Output as JSON")
    parser.add_argument("--news", "-n", action="store_true", help="Search news instead of web")
    args = parser.parse_args()

    limit = max(1, min(20, args.limit))

    try:
        if args.news:
            results = search_news(args.query, limit)
        else:
            results = search_text(args.query, limit, args.content)
    except Exception as e:
        print(f"Search failed: {e}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        if not results:
            print("No results found.")
        else:
            print(format_results(results))


if __name__ == "__main__":
    main()

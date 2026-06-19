#!/usr/bin/env python3
"""
TreeSnap Facebook Auto-Poster (GitHub Actions).

Posts the next unposted item from the queue to the TreeSnap FB page, syncs
status back to the Notion content calendar, appends to the log, and the
workflow commits the updated queue + log back to the repo.

Migrated from the OpenClaw cron + Forge workspace, June 2026. Credentials now
come from environment variables (GitHub Secrets); per-post images are resolved
by filename against bots/fb_poster/assets/ (the absolute OpenClaw media paths in
the original queue have been rewritten to bare filenames).
"""

import json
import os
import sys
from datetime import datetime, timezone

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # bots/fb_poster
QUEUE_FILE = os.path.join(ROOT, "config", "fb_post_queue.json")
LOG_FILE = os.path.join(ROOT, "state", "fb_post_log.json")
ASSETS_DIR = os.path.join(ROOT, "assets")

PAGE_TOKEN = os.environ["FB_PAGE_TOKEN"]
PAGE_ID = os.environ["FB_PAGE_ID"]
PAGE_HANDLE = os.environ.get("FB_PAGE_HANDLE", "TreeSnapCloud")
NOTION_KEY = os.environ.get("NOTION_API_KEY")
NOTION_DATA_SRC_ID = os.environ.get("NOTION_DATA_SOURCE_ID")
NOTION_VERSION = "2025-09-03"
GRAPH = "https://graph.facebook.com/v21.0"


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def log_post(post_id, fb_post_id, preview, success, error=None):
    log = load_json(LOG_FILE) if os.path.exists(LOG_FILE) else []
    log.append({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "post_id": post_id,
        "fb_post_id": fb_post_id,
        "success": success,
        "error": error,
        "preview": preview[:80] + "..." if len(preview) > 80 else preview,
    })
    save_json(LOG_FILE, log)


def notion_update_post(post_title, fb_post_id, status="Posted"):
    """Find the matching Notion entry by title and update status + FB Post ID."""
    if not (NOTION_KEY and NOTION_DATA_SRC_ID):
        print("  Notion: no key/data-source configured, skipping sync")
        return False
    try:
        resp = requests.post(
            f"https://api.notion.com/v1/data_sources/{NOTION_DATA_SRC_ID}/query",
            headers={
                "Authorization": f"Bearer {NOTION_KEY}",
                "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json",
            },
            json={"filter": {"property": "Name", "title": {"contains": post_title[:40]}}},
        )
        results = resp.json().get("results", [])
        if not results:
            print(f"  Notion: no match for '{post_title[:40]}'")
            return False
        page_id = results[0]["id"]
        fb_url = (
            f"https://www.facebook.com/{PAGE_HANDLE}/posts/{fb_post_id.split('_')[1]}"
            if "_" in fb_post_id else ""
        )
        update_resp = requests.patch(
            f"https://api.notion.com/v1/pages/{page_id}",
            headers={
                "Authorization": f"Bearer {NOTION_KEY}",
                "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json",
            },
            json={"properties": {
                "Status": {"select": {"name": status}},
                "FB Post ID": {"rich_text": [{"text": {"content": fb_post_id}}]},
                "Post URL": {"url": fb_url if fb_url else None},
            }},
        )
        if update_resp.status_code == 200:
            print(f"  Notion: updated '{post_title[:40]}' -> {status}")
            return True
        print(f"  Notion: update failed: {update_resp.text[:100]}")
        return False
    except Exception as e:
        print(f"  Notion: error - {e}")
        return False


def main():
    try:
        queue_data = load_json(QUEUE_FILE)
    except Exception as e:
        print(f"ERROR: Could not load queue: {e}")
        sys.exit(1)

    queue = queue_data["queue"]
    posted_ids = set(queue_data.get("posted", []))

    next_post = next((p for p in queue if p["id"] not in posted_ids), None)
    if next_post is None:
        print("All posts cycled - resetting queue.")
        queue_data["posted"] = []
        save_json(QUEUE_FILE, queue_data)
        next_post = queue[0]

    content = next_post["content"]
    post_id = next_post["id"]
    pillar = next_post.get("pillar", "general")
    title = next_post.get("title", content[:50])
    image_name = next_post.get("image_path")  # rewritten to a bare filename, or null

    print(f"Posting [{pillar}] post ID {post_id}: {title[:60]}")
    print(f"Preview: {content[:100]}...")

    image_file = os.path.join(ASSETS_DIR, image_name) if image_name else None
    if image_file and os.path.exists(image_file):
        print(f"  Image: {image_name}")
        with open(image_file, "rb") as img:
            resp = requests.post(
                f"{GRAPH}/{PAGE_ID}/photos",
                data={"caption": content, "access_token": PAGE_TOKEN},
                files={"source": (image_name, img, "image/png")},
            )
        result = resp.json()
        if "post_id" in result:
            result["id"] = result["post_id"]
    else:
        if image_name:
            print(f"  Image: '{image_name}' not found in assets/, posting text-only")
        else:
            print("  Image: none for this post, posting text-only")
        resp = requests.post(
            f"{GRAPH}/{PAGE_ID}/feed",
            data={"message": content, "access_token": PAGE_TOKEN},
        )
        result = resp.json()

    if "id" in result:
        fb_post_id = result["id"]
        print(f"SUCCESS: Posted as {fb_post_id}")
        queue_data["posted"].append(post_id)
        save_json(QUEUE_FILE, queue_data)
        log_post(post_id, fb_post_id, content, True)
        notion_update_post(title, fb_post_id)
    else:
        error_msg = result.get("error", {}).get("message", str(result))
        print(f"ERROR: {error_msg}")
        log_post(post_id, None, content, False, error_msg)
        sys.exit(1)


if __name__ == "__main__":
    main()

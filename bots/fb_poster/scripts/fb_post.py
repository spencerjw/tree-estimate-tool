#!/usr/bin/env python3
"""
TreeSnap Facebook Auto-Poster (GitHub Actions).

Strict scheduling rules (enforced -- this script's reason for existing):
  1. NEVER post out of order. Always pick the earliest unposted post in queue order.
  2. NEVER post before the post's `scheduled_cdt` (parsed America/Chicago, compared UTC).
  3. NEVER post without an image. `image_path` must be set AND the file must exist in
     assets/. A missing image is a HARD ERROR -- the workflow fails so we get an alert.
  4. NEVER skip ahead to "whatever's next" when the scheduled post can't ship. If the
     next post isn't due yet, exit cleanly. If it has no image, exit non-zero (loud).

If the queue is fully posted, exit cleanly with no action. There is no auto-reset --
when the queue is empty, add more posts to the queue.
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

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

CT = ZoneInfo("America/Chicago")

# GitHub Actions cron is almost always LATE (5-60 min), occasionally a few minutes early.
# A small tolerance keeps a rare early fire from punting the post to the next slot (which
# would post on the wrong calendar day). Anything beyond this window is treated as "not due."
SCHEDULE_TOLERANCE = timedelta(minutes=30)


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def emit(line):
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    print(line)


def parse_scheduled(s):
    """Parse '2026-07-04T09:00:00' as naive America/Chicago, return UTC-aware datetime."""
    naive = datetime.fromisoformat(s)
    return naive.replace(tzinfo=CT).astimezone(timezone.utc)


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
    if not (NOTION_KEY and NOTION_DATA_SRC_ID):
        emit("- Notion: no key/data-source configured, skipping sync")
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
            timeout=15,
        )
        results = resp.json().get("results", [])
        if not results:
            emit(f"- Notion: no match for '{post_title[:40]}'")
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
            timeout=15,
        )
        if update_resp.status_code == 200:
            emit(f"- Notion: updated '{post_title[:40]}' -> {status}")
            return True
        emit(f"- Notion: update failed: {update_resp.text[:100]}")
        return False
    except Exception as e:
        emit(f"- Notion: error - {e}")
        return False


def main():
    queue_data = load_json(QUEUE_FILE)
    queue = queue_data["queue"]
    posted_ids = set(queue_data.get("posted", []))

    # RULE 1: earliest unposted in queue order. No skipping.
    candidate = next((p for p in queue if p["id"] not in posted_ids), None)
    if candidate is None:
        emit("All posts in the queue have been posted. Nothing to do.")
        return

    post_id = candidate["id"]
    title = candidate.get("title", candidate["content"][:50])
    pillar = candidate.get("pillar", "general")
    scheduled_str = candidate.get("scheduled_cdt")

    emit(f"## Candidate: post #{post_id} [{pillar}]")
    emit(f"- Title: {title}")
    emit(f"- Scheduled: {scheduled_str} CDT")

    # RULE 2: schedule gate. Never post before the scheduled time.
    if not scheduled_str:
        emit(f"ERROR: post #{post_id} has no scheduled_cdt. Refusing to post.")
        sys.exit(1)
    sched_utc = parse_scheduled(scheduled_str)
    now_utc = datetime.now(timezone.utc)
    if now_utc + SCHEDULE_TOLERANCE < sched_utc:
        emit(f"- Not due yet (now {now_utc.isoformat()} < scheduled {sched_utc.isoformat()} "
             f"- {SCHEDULE_TOLERANCE.total_seconds()/60:.0f}min tolerance). "
             "Skipping cleanly; will try again on the next cron.")
        return

    # RULE 3: image required. No silent skip-ahead; fail loudly if missing.
    image_name = candidate.get("image_path")
    if not image_name:
        emit(f"ERROR: post #{post_id} ('{title[:60]}') has no image_path. "
             "Refusing to post (no-image rule). Fix the queue: attach an image or remove this post.")
        sys.exit(1)
    image_file = os.path.join(ASSETS_DIR, image_name)
    if not os.path.exists(image_file):
        emit(f"ERROR: post #{post_id} image '{image_name}' not found in {ASSETS_DIR}. "
             "Refusing to post. Commit the file or correct image_path.")
        sys.exit(1)

    content = candidate["content"]
    emit(f"- Image: {image_name}")
    emit(f"- Preview: {content[:120]}...")

    with open(image_file, "rb") as img:
        resp = requests.post(
            f"{GRAPH}/{PAGE_ID}/photos",
            data={"caption": content, "access_token": PAGE_TOKEN},
            files={"source": (image_name, img, "image/png")},
            timeout=60,
        )
    result = resp.json()
    if "post_id" in result:
        result["id"] = result["post_id"]

    if "id" in result:
        fb_post_id = result["id"]
        emit(f"- **Posted:** {fb_post_id}")
        queue_data["posted"].append(post_id)
        save_json(QUEUE_FILE, queue_data)
        log_post(post_id, fb_post_id, content, True)
        notion_update_post(title, fb_post_id)
    else:
        error_msg = result.get("error", {}).get("message", str(result))
        emit(f"- ERROR: {error_msg}")
        log_post(post_id, None, content, False, error_msg)
        sys.exit(1)


if __name__ == "__main__":
    main()

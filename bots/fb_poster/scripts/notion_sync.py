#!/usr/bin/env python3
"""
Reconcile the TreeSnap Notion content calendar with the GitHub post queue.

Source of truth = bots/fb_poster/config/fb_post_queue.json (that's what actually
posts). For every queued post this updates its matching Notion row so Notion is a
reliable "what will actually post, when" sanity-check:

  - Status:        Posted (already out) / ✅ Approved (scheduled) / 📝 Draft (no image -> won't post)
  - Publish Date:  real post time (from the log) if posted, else the PROJECTED next
                   cron slot (Tue 10am / Thu 6pm / Sat 9am CDT) in queue order
  - Files & media: the post's image, uploaded into Notion -> real thumbnail

Idempotent: safe to run repeatedly (skips re-uploading images already attached).
Run it in the FB poster workflow and/or on demand via the notion-sync workflow.
"""

import datetime as dt
import json
import os

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # bots/fb_poster
QUEUE_FILE = os.path.join(ROOT, "config", "fb_post_queue.json")
LOG_FILE = os.path.join(ROOT, "state", "fb_post_log.json")
ASSETS_DIR = os.path.join(ROOT, "assets")

NOTION_KEY = os.environ["NOTION_API_KEY"]
NOTION_DS = os.environ["NOTION_DATA_SOURCE_ID"]
NOTION_VERSION = "2025-09-03"
JSON_HEADERS = {
    "Authorization": f"Bearer {NOTION_KEY}",
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
}

# GitHub Actions cron slots, in UTC. weekday(): Mon=0 .. Sun=6.
#   0 15 * * 2  -> Tue 15:00 UTC (10am CDT)
#   0 23 * * 4  -> Thu 23:00 UTC (6pm CDT)
#   0 14 * * 6  -> Sat 14:00 UTC (9am CDT)
SLOTS = {1: (15, 0), 3: (23, 0), 5: (14, 0)}

STATUS_POSTED = "Posted"
STATUS_SCHEDULED = "✅ Approved"
STATUS_NO_IMAGE = "📝 Draft"


def load_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def has_image(post):
    name = post.get("image_path")
    return bool(name) and os.path.exists(os.path.join(ASSETS_DIR, name))


def normalize(s):
    """Normalize a title for matching: straighten smart quotes, collapse whitespace, casefold."""
    s = s or ""
    for a, b in (("’", "'"), ("‘", "'"), ("“", '"'), ("”", '"'), (" ", " ")):
        s = s.replace(a, b)
    return " ".join(s.split()).strip().lower()


def iter_slots(after):
    """Yield aware-UTC datetimes matching the weekly cron slots, strictly after `after`."""
    day = after.replace(hour=0, minute=0, second=0, microsecond=0)
    for _ in range(3650):  # ~10 years of safety
        wd = day.weekday()
        if wd in SLOTS:
            h, m = SLOTS[wd]
            cand = day.replace(hour=h, minute=m)
            if cand > after:
                yield cand
        day += dt.timedelta(days=1)


def query_all_rows():
    """Return {name -> page} for every row in the data source."""
    rows = {}
    cursor = None
    while True:
        body = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        r = requests.post(
            f"https://api.notion.com/v1/data_sources/{NOTION_DS}/query",
            headers=JSON_HEADERS, json=body, timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        for page in data.get("results", []):
            title_prop = page.get("properties", {}).get("Name", {}).get("title", [])
            name = "".join(t.get("plain_text", "") for t in title_prop).strip()
            if name:
                rows[name] = page
        if not data.get("has_more"):
            break
        cursor = data.get("next_cursor")
    return rows


def row_has_file(page, filename):
    files = page.get("properties", {}).get("Files & media", {}).get("files", [])
    return any(f.get("name") == filename for f in files)


def upload_image(path, filename):
    """Upload a local image to Notion, return the file_upload id."""
    r = requests.post(
        "https://api.notion.com/v1/file_uploads",
        headers=JSON_HEADERS,
        json={"filename": filename, "content_type": "image/png"},
        timeout=30,
    )
    r.raise_for_status()
    fu = r.json()
    fid = fu["id"]
    send_url = fu.get("upload_url") or f"https://api.notion.com/v1/file_uploads/{fid}/send"
    with open(path, "rb") as f:
        r2 = requests.post(
            send_url,
            headers={"Authorization": f"Bearer {NOTION_KEY}", "Notion-Version": NOTION_VERSION},
            files={"file": (filename, f, "image/png")},
            timeout=60,
        )
    r2.raise_for_status()
    return fid


def update_row(page_id, props):
    r = requests.patch(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=JSON_HEADERS, json={"properties": props}, timeout=30,
    )
    if r.status_code != 200:
        print(f"    update failed: {r.status_code} {r.text[:160]}")
        return False
    return True


def create_row(props):
    body = {"parent": {"type": "data_source_id", "data_source_id": NOTION_DS}, "properties": props}
    r = requests.post("https://api.notion.com/v1/pages", headers=JSON_HEADERS, json=body, timeout=30)
    if r.status_code not in (200, 201):
        print(f"    create failed: {r.status_code} {r.text[:160]}")
        return False
    return True


def main():
    queue_data = load_json(QUEUE_FILE, {})
    queue = queue_data.get("queue", [])
    posted_ids = set(queue_data.get("posted", []))
    log = load_json(LOG_FILE, []) or []
    posted_times = {
        e["post_id"]: e["timestamp"]
        for e in log if e.get("success") and e.get("post_id") is not None and e.get("timestamp")
    }

    rows = query_all_rows()
    norm_rows = {normalize(nm): pg for nm, pg in rows.items()}
    print(f"Notion rows: {len(rows)} | queue posts: {len(queue)}")

    now = dt.datetime.now(dt.timezone.utc)
    slots = iter_slots(now)

    matched = created = uploaded = 0
    for post in queue:
        title = (post.get("title") or "").strip()
        key = normalize(title)
        page = norm_rows.get(key)
        if page is None:  # fall back to prefix match
            page = next((pg for nm, pg in norm_rows.items() if nm.startswith(key[:40]) or key.startswith(nm[:40])), None)

        props = {}
        # Status + Publish Date
        if post["id"] in posted_ids:
            props["Status"] = {"select": {"name": STATUS_POSTED}}
            ts = posted_times.get(post["id"])
            if ts:
                props["Publish Date"] = {"date": {"start": ts}}
            # if no logged time (posted pre-migration), leave the date untouched
        elif not has_image(post):
            props["Status"] = {"select": {"name": STATUS_NO_IMAGE}}
            props["Publish Date"] = {"date": None}
        else:
            props["Status"] = {"select": {"name": STATUS_SCHEDULED}}
            props["Publish Date"] = {"date": {"start": next(slots).isoformat()}}

        # Image thumbnail (upload once)
        img = post.get("image_path")
        if has_image(post) and (page is None or not row_has_file(page, img)):
            try:
                fid = upload_image(os.path.join(ASSETS_DIR, img), img)
                props["Files & media"] = {"files": [{"type": "file_upload", "file_upload": {"id": fid}, "name": img}]}
                uploaded += 1
            except Exception as e:
                print(f"    image upload failed for post {post['id']}: {e}")

        if page is not None:
            matched += 1
            action = "upd"
            ok = update_row(page["id"], props)
        else:
            created += 1
            action = "NEW"
            props["Name"] = {"title": [{"text": {"content": title}}]}
            props["Content Preview"] = {"rich_text": [{"text": {"content": (post.get("content") or "")[:1900]}}]}
            props["Domain"] = {"select": {"name": "TreeSnap"}}
            ok = create_row(props)

        status = props["Status"]["select"]["name"]
        date = props.get("Publish Date", {}).get("date")
        date_s = (date or {}).get("start", "—") if date else "—"
        print(f"  [{action}] post {post['id']:>3} [{post.get('pillar','')[:12]:12}] {status:12} {date_s}{'  +img' if 'Files & media' in props else ''}{'' if ok else '  (FAILED)'}")

    print(f"\nDone: {matched} updated, {created} created, {uploaded} images uploaded.")


if __name__ == "__main__":
    main()

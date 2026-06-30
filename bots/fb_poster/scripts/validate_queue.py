#!/usr/bin/env python3
"""
TreeSnap FB queue validator. Runs in CI on every push/PR.

Enforces the drafting rules on bots/fb_poster/config/fb_post_queue.json:
  - Every UNPOSTED entry must have a non-empty image_path AND the file must exist in assets/.
    (Hard rule: never draft a post without an image.)
  - Every UNPOSTED entry must have a parseable scheduled_cdt.
  - Entry IDs must be unique.
  - scheduled_cdt must be non-decreasing across UNPOSTED entries in queue order, so
    "next in queue" always matches "next scheduled."
  - content must be non-empty.

Posted entries are historical and exempt -- the rules apply to drafts.

Exits non-zero on any violation so PRs/pushes fail loudly.
"""

import json
import os
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUEUE_FILE = os.path.join(ROOT, "config", "fb_post_queue.json")
ASSETS_DIR = os.path.join(ROOT, "assets")


def main():
    with open(QUEUE_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    queue = data.get("queue", [])
    posted = set(data.get("posted", []))
    errors = []

    seen_ids = set()
    last_scheduled = None
    for entry in queue:
        pid = entry.get("id")
        if pid is None:
            errors.append(f"entry missing id: '{str(entry.get('title', '?'))[:40]}'")
            continue
        if pid in seen_ids:
            errors.append(f"#{pid}: duplicate id")
        seen_ids.add(pid)

        if pid in posted:
            continue  # historical, exempt

        title = entry.get("title", "")
        sched = entry.get("scheduled_cdt")
        parsed = None
        if not sched:
            errors.append(f"#{pid} '{title[:40]}': missing scheduled_cdt")
        else:
            try:
                parsed = datetime.fromisoformat(sched)
            except (TypeError, ValueError):
                errors.append(f"#{pid} '{title[:40]}': scheduled_cdt '{sched}' is not ISO 8601")
        if parsed is not None:
            if last_scheduled is not None and parsed < last_scheduled:
                errors.append(
                    f"#{pid} '{title[:40]}': scheduled_cdt {sched} is earlier than the "
                    f"previous unposted entry ({last_scheduled.isoformat()}). The queue must be "
                    "chronological so 'next in order' matches 'next scheduled'."
                )
            last_scheduled = parsed

        image_name = entry.get("image_path")
        if not image_name:
            errors.append(
                f"#{pid} '{title[:40]}': no image_path. Hard rule: never draft a post without an image."
            )
        else:
            full = os.path.join(ASSETS_DIR, image_name)
            if not os.path.exists(full):
                errors.append(
                    f"#{pid} '{title[:40]}': image_path '{image_name}' is not present in assets/."
                )

        if not entry.get("content"):
            errors.append(f"#{pid} '{title[:40]}': empty content")

    if errors:
        print("Queue validation FAILED:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)

    unposted = [p for p in queue if p["id"] not in posted]
    print(f"Queue OK: {len(queue)} entries, {len(unposted)} unposted, all drafting rules satisfied.")


if __name__ == "__main__":
    main()

# TreeSnap FB Poster

GitHub Actions automation that posts to the TreeSnap Facebook page on a schedule.
Migrated from the OpenClaw cron + Forge workspace in June 2026 (the last load-bearing
dependency on the OpenClaw EC2).

## What it does

`fb-post.yml` fires three weekly schedules:

| Day | Time (CDT) | Cron (UTC) |
|---|---|---|
| Tue | 10:00 AM | `0 15 * * 2` |
| Thu | 6:00 PM | `0 23 * * 4` |
| Sat | 9:00 AM | `0 14 * * 6` |

Each run picks the next unposted item from `config/fb_post_queue.json`, posts it with
its image (resolved by filename from `assets/`) to the TreeSnap FB page, syncs status
back to the Notion content calendar, appends to `state/fb_post_log.json`, and commits
the updated queue + log back to the repo. When the queue is exhausted it auto-resets
and rotates from the top.

Each post entry carries its own `image_path` (a bare filename in `assets/`).
**HARD RULE: nothing is ever posted without an image.** A post whose `image_path`
is null or whose image file is missing from `assets/` is **skipped** (left in the
queue, never posted text-only). If no queued post has a usable image, the run
exits with an error rather than posting anything imageless.

## Required GitHub Secrets

| Secret | Value / where to get it |
|---|---|
| `FB_PAGE_TOKEN` | TreeSnap page access token (never-expiring page token) — Meta Business Suite → Page Access Tokens |
| `FB_PAGE_ID` | `1209658132223528` |
| `NOTION_API_KEY` | Per-project Notion integration token for TreeSnap (NOT the shared "Nexus" one) |
| `NOTION_DATA_SOURCE_ID` | TreeSnap Content Calendar data source (`2fc4aa00-d402-4552-ad6b-0d4dacade7fd`) |

Set these at https://github.com/spencerjw/tree-estimate-tool/settings/secrets/actions.

> Notion sync is optional: if `NOTION_API_KEY`/`NOTION_DATA_SOURCE_ID` are unset the
> poster still posts to Facebook and just skips the calendar update.

## Folder layout

```
bots/fb_poster/
  README.md          (this file)
  scripts/fb_post.py            (the poster, called by fb-post.yml)
  config/fb_post_queue.json     (23-post rotation, persisted across runs)
  state/fb_post_log.json        (append-only log of post attempts)
  assets/*.png                  (per-post images, 1 per queued post)
```

## Manual operations

- **Trigger a one-off post:** workflow_dispatch on `fb-post.yml`.
- **Add posts to the queue:** edit `config/fb_post_queue.json` (`queue` array; `posted` is auto-managed). Each post's `image_path` MUST be a filename present in `assets/` — posts without a usable image are skipped, never posted.
- **See post history:** `state/fb_post_log.json` or `git log` filtered by the `bot(fb):` prefix.

## Token note

Unlike the GrowReviews poster, TreeSnap uses a **never-expiring** page token, so there is
no token-refresh workflow. If the page token ever stops working, regenerate it in Meta
Business Suite → Page Access Tokens and update the `FB_PAGE_TOKEN` secret.

## What used to happen (pre-migration)

OpenClaw crontab ran `treesnap_fb_post.py` (Tue/Thu/Sat) from
`/home/clawuser/.openclaw/workspace-forge/`, reading creds from `config/fb_treesnap.json`,
the Notion key from `~/.config/notion/api_key`, and per-post images from
`~/.openclaw/media/tool-image-generation/`. All of that is now self-contained in this
repo + GitHub Secrets.

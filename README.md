# dsh-plugin-zsxq

[中文](README.zh.md) | English

**Turn the Knowledge Planet (知识星球 / zsxq) planets you subscribe to into a searchable local Markdown knowledge base — from inside DeepSeek Harness.**

Sync posts and attachments, extract `docx` / `PDF` text and images, rebuild an index, and search it — all in pure JavaScript. No Python, no external services, no telemetry.

```
sync posts ──▶ download attachments ──▶ extract docx/PDF text + images ──▶ Markdown
                                                                             │
        ask your agent ◀── search ◀── build index ◀── enrich categories/summary/quotes (skill)
```

## Why

Knowledge Planet content is awkward to keep: posts live behind an app, the substantial parts are attachments (`docx`, `PDF`, audio), and there is no full-text search across your own history. If you read on a computer — or want an agent to work with what you paid for — you end up exporting files by hand.

This plugin makes your own subscription local and queryable:

- 📥 **One call to sync** — today, a date, a whole month, a count, or a hashtag
- 📄 **Attachments become text** — `docx` paragraphs and embedded images, `PDF` text and page images, all written into the Markdown next to the post
- 🔎 **Search that respects your subscription** — keyword / tag / channel / category / date over a local index
- 🧠 **Agent-friendly** — seven typed tools; pair with the `dsh-skill-zsxq` skill for the enrichment conventions (category, summary, quotes)
- 🔒 **Local first** — everything lives in a folder you choose; your Cookie never leaves `config.json`
- 🐍 **No Python** — this is a from-scratch JS port of the Python skill, validated byte-for-byte

## Install

```sh
# DSH profile (npm release once published)
dsh plugin --profile web add dsh-plugin-zsxq

# straight from GitHub today
dsh plugin --profile web add github:zhangcaiqian/dsh-plugin-zsxq

# local checkout while developing
dsh plugin --profile web add link:/path/to/dsh-plugin-zsxq
```

Restart DSH after installing (plugin modules are not hot-reloaded).

> **DSH Desktop users**: install from **Settings → Plugins**, or point `DSH_HOME` at the desktop's harness directory when using the CLI, otherwise the plugin lands in a different profile.

### Optional companion skill

The plugin executes; the skill teaches the agent *how to enrich* what was synced (topic category, ≤50-character summary, quote extraction, enrichment workflow). Install it for the full experience:

```sh
dsh plugin --profile web add github:zhangcaiqian/zsxq-skill
```

Without it, the tools still work — the agent just follows the tool descriptions instead of the full playbook.

## Quick start

1. **Initialize a data directory**

   Ask the agent: *“initialize the zsxq knowledge base”* → `zsxq_init` creates
   `$DSH_HOME/zsxq-kb/{channels,assets,data,index}` and a `config.json` template
   (the default location; a configured `dataDir` wins).

2. **Add your Cookie**

   1. Open <https://wx.zsxq.com>, log in, and confirm your planets render;
   2. `F12` → **Network** → filter `api.zsxq.com` → reload → click any request;
   3. **Headers → Request Headers → `Cookie`** → copy the **whole** value after the colon
      (usually `zsxq_access_token=…; abtest_env=product`; more than one pair is normal);
   4. Write it into `config.json` in the data directory — default
      `$DSH_HOME/zsxq-kb/config.json`, or `<dataDir>/config.json` when `dataDir` is configured:

   ```json
   { "zsxq_cookie": "zsxq_access_token=…; abtest_env=product", "channels": {}, "tag_to_category": {} }
   ```

   - The Cookie is the account credential: do **not** commit it, and do **not** paste it into
     chats, screenshots, or issues;
   - It lasts about **a month** in practice; expiry shows up as **HTTP 401**
     (`ZSXQ_COOKIE_EXPIRED` from the tools) — copy a fresh one and overwrite the value;
   - Verify with `zsxq_doctor`: it makes one real API call and only reports whether the Cookie
     works, never echoing it.

3. **Pick your planets**

   Ask: *“check the zsxq setup”* → `zsxq_doctor` validates the Cookie against the live API and reports
   which planets your account can reach. Add the ones you want to `config.json`:

   ```json
   {
     "channels": {
       "my-channel": {
         "name": "My Planet",
         "group_id": "123456789012",
         "default_scope": "digests"
       }
     }
   }
   ```

4. **Sync**

   *“sync today’s posts”* → `zsxq_sync` with `mode=today`.

5. **Enrich, index, search**

   Let the agent fill `topic_category` / `keywords` / `summary` and create `.quotes.md` (the skill
   describes the rules), then *“rebuild the index”* → `zsxq_rebuild_index`, and search:
   *“search the knowledge base for liquidity”* → `zsxq_search`.

## Tools

| Tool | What it does | Writes |
|---|---|---|
| `zsxq_init` | Create the data directory and a `config.json` template | yes (first run) |
| `zsxq_doctor` | Validate Cookie against the API, report reachable planets, check index health | no |
| `zsxq_list_channels` | List configured channels | no |
| `zsxq_status` | Article/quote counts, index staleness, sync state | no |
| `zsxq_search` | Keyword/tag/channel/category/date search over `index.json` | no |
| `zsxq_sync` | Sync posts + attachments + extracted text; dedupe by topic id | **channels/, assets/, data/raw/, .synced_ids** |
| `zsxq_rebuild_index` | Rebuild `INDEX.md`, `index.json`, all `by-*` indices, quotes index | **index/, INDEX.md** |

Safety rails:

- `count` is capped at **30** — the Knowledge Planet API rejects larger pages (`code=14001`)
- `refresh` (re-pull a whole month) refuses to run without an explicit `confirmDestructive`, and only for a single channel — it deletes that month's local files, including your enrichment
- every sync is idempotent through `.synced_ids`; re-running never duplicates posts

## What gets extracted

| Attachment | Extracted |
|---|---|
| `.docx` | paragraphs (body-level, python-docx semantics) + `word/media/*` images |
| `.pdf` | page text (CJK included, via bundled CMaps) + page images as PNG |
| `.mp3` / audio | downloaded only (transcription is out of scope) |
| post images | remote signed URLs kept in Markdown |
| article posts (`inline_article_url`) | HTML body → plain text |

Images extracted from attachments are written next to the Markdown as
`embedded-<attachment>-<index>.<ext>` and referenced from a `## 🖼️ …` section.

## Data layout

```
<dataDir>/
├── config.json            # Cookie + channels (keep out of Git!)
├── .synced_ids            # dedupe state
├── channels/<channel>/<YYYY>/<MM>/<DD>/<title>.md
│                                    └── <title>.quotes.md      # quotes (agent)
├── assets/<channel>/<YYYY>/<MM>/<DD>/…                       # docx / pdf / mp3 / *_images/
├── data/raw/<channel>/<YYYY>/<MM>/<DD>/<topic_id>.json       # raw API payload
├── index/index.json        # retrieval source of truth
├── index/by-{date,tag,topic,channel}/… , quotes-index.md
└── INDEX.md
```

## Configuration

Set in the profile's `cordis.patch.yml` (row id `zsxq-tools`), or through **Settings → Plugins** for
the volatile fields:

| Field | Default | Meaning |
|---|---|---|
| `dataDir` | `$DSH_HOME/zsxq-kb` | where the knowledge base lives; `ZSXQ_BASE_DIR` env var wins |
| `requestIntervalMs` | `1500` | throttle between API requests |
| `syncTimeoutMs` | `900000` | per-channel sync timeout |
| `indexTimeoutMs` | `120000` | index rebuild timeout |

```yaml
- id: zsxq-tools
  config:
    dataDir: /Users/you/knowledge-base
```

## Design notes

This plugin is a **from-scratch JavaScript port** of a mature Python skill. The port was validated
before writing any tool code:

| Check | Result |
|---|---|
| `docx` text vs python-docx (41 real files) | **41/41 byte-identical** (284,679 chars) |
| `docx` embedded images | **41/41 identical** (names, sizes, SHA-256) |
| Markdown rendering vs the Python renderer (133 real posts) | **133/133 byte-identical** |
| Rich-text `<e>` markers / hashtags / filenames | **63/63, 63/63, 133/133** |
| `PDF` CJK text vs PyMuPDF | identical (with bundled CMaps) |
| docx extraction speed | **≈3.4× faster** than the Python version |
| Install footprint | **≈8 MB** of pure JS + CMaps (Python needs ~52 MB incl. PyMuPDF + a Python runtime) |

Two non-obvious details worth knowing:

- **18-digit topic ids**: `topic_id` exceeds `Number.MAX_SAFE_INTEGER`, so `JSON.parse` silently
  corrupts ids (`…514` becomes `…510`). The plugin parses JSON with `json-bigint` and serializes ids
  back as exact numeric literals (`JSON.rawJSON`).
- **PDF Chinese text** needs the pdf.js CMaps. The plugin ships `assets/pdf/cmaps` (2.4 MB, Apache-2.0)
  and passes a local path — installing `pdfjs-dist` (+36 MB) is *not* required, and the optional
  `@napi-rs/canvas` peer (+29 MB) is not used for extraction.

## Privacy & security

- Everything is written locally under `dataDir`; the plugin never uploads content anywhere.
- The Cookie is read from `config.json` on disk and sent only to `api.zsxq.com` / signed attachment URLs.
- No analytics, no telemetry, no background network calls beyond the API requests you trigger.
- Destructive operations require explicit confirmation; sync is idempotent.

## Limitations

- **No ASR** — audio is downloaded, not transcribed. (Voice placeholders are left in the Markdown.)
- **No image generation** for quote posters.
- **Scanned PDFs** have no text layer → text is empty (OCR is out of scope).
- **docx tables / headers / footers** are not extracted (same as the Python original).
- Article-post HTML extraction is best-effort: paywalled or JS-rendered pages may yield less text.
- Requires a valid subscription Cookie; the plugin cannot access planets you are not a member of.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ZSXQ_COOKIE_EXPIRED` / HTTP 401 | Cookie expired — copy a fresh one into `config.json` |
| `code=14001` | `count` too large (API max 30) |
| `ZSXQ_CONFIG_MISSING` | no `config.json` or no `zsxq_cookie` — run `zsxq_init` |
| Search misses new posts | index stale — run `zsxq_rebuild_index` after enrichment |
| Markdown has a title but no body | attachment extraction failed; check `assets/…` and the `## 📄` section |
| Plugin loads but no tools | check the `zsxq-tools` row is in the profile's composed config (`dsh --profile web --dump-config`) |

## Roadmap

- Voice transcription via a pluggable ASR backend
- Incremental index builds for very large libraries
- Optional Python backend switch for users who already run the original skill

## Credits & license

MIT. PDF CMaps/fonts under `assets/pdf/` come from [Mozilla PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0, see `assets/pdf/NOTICE.md`).

Not affiliated with Knowledge Planet (知识星球 / zsxq.com). Use it for content you are entitled to access.

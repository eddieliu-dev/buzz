# nia-atlassian

[Back to Buzz](../README.md)

Fetch Confluence pages or Jira tickets from Atlassian, let the user choose what to keep, and index selected items into Nia.

## What this does

1. Fetches content from Atlassian (`confluence` or `jira` mode)
2. Lets you pick items (interactive prompt or `--pick`/`--all`)
3. Uploads selected items to Nia as a `local_folder` source (file-based index)

This works around the lack of native Confluence/Jira connectors by materializing selected content as files and indexing those files in Nia.

## Setup

```bash
cd nia-atlassian
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env with your values
```

Required `.env` values:

- `ATLASSIAN_BASE_URL` (example: `https://your-domain.atlassian.net`)
- `ATLASSIAN_EMAIL`
- `ATLASSIAN_API_TOKEN`
- `NIA_API_KEY`

## Usage

### Confluence

```bash
python sync_atlassian_to_nia.py confluence \
  --space ENG \
  --limit 20 \
  --out-dir out
```

### Jira

```bash
python sync_atlassian_to_nia.py jira \
  --jql "project = ENG ORDER BY updated DESC" \
  --limit 20 \
  --out-dir out
```

### Non-interactive selection

```bash
python sync_atlassian_to_nia.py confluence \
  --space ENG \
  --pick "1,2,5" \
  --source-name "eng-confluence" \
  --out-dir out
```

### Dry run

```bash
python sync_atlassian_to_nia.py jira --limit 10 --all --dry-run --out-dir out
```

## Output files

The commands above write snapshots to `out/` inside `nia-atlassian/`:

- `confluence_fetched.json` / `jira_fetched.json`
- `confluence_selected.json` / `jira_selected.json`

These help you audit exactly what was indexed.

Without `--out-dir`, the script uses `nia-atlassian/out` relative to your current directory.

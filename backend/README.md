# Buzz · Agent service

[Back to Buzz](../README.md) · [Frontend guide](../frontend/README.md)

The Python service runs a sequential LangGraph investigation and streams agent events to the web app. You can also run the pipeline from the command line against a local directory or a GitHub repository.

## Pipeline

```text
Triage → Codebase search → Documentation → Log analysis → Patch generation → Report
```

The patch stage returns a skipped result when disabled. Sentry analysis is skipped when its credentials are missing. Other stages can return partial findings when evidence is unavailable.

| Module | Responsibility |
| --- | --- |
| `triage_agent.py` | Severity, likely module, duplicate assessment, and issue summary. |
| `codebase_search_agent.py` | Investigation questions, repository evidence, and suspect files. |
| `doc_agent.py` | Relevant Markdown documentation and optional indexed Slack messages. |
| `log_agent.py` | Related Sentry events, patterns, and a timeline. |
| `patch_agent.py` | Source/test changes, Git commits, branch pushes, and PR attempts. |
| `pipeline.py` | Stage ordering, shared state, and final report assembly. |
| `server.py` | FastAPI endpoints and server-sent events. |
| `llm.py` | Anthropic and NVIDIA NIM model routing. |

## Setup

From the repository root, using Python 3.12:

```bash
python3 -m venv backend/.venv
source backend/.venv/bin/activate
python -m pip install -r backend/agents/requirements.txt fastapi==0.115.0 uvicorn==0.30.0
cp backend/.env.example backend/.env
```

Fill in `backend/.env` before running the agents. FastAPI and Uvicorn are installed separately because the agent requirements file currently omits the web server dependencies. On subsequent runs, activate the existing environment; do not copy over your configured `.env`.

## LLM configuration

The supplied environment example selects Anthropic for consistency with the web API:

```dotenv
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-anthropic-api-key
```

For CLI runs with NVIDIA NIM:

```dotenv
LLM_PROVIDER=nvidia
NVIDIA_API_KEY=your-nvidia-api-key
NVIDIA_MODEL=nvidia/llama-3.3-nemotron-super-49b-v1
```

| Entry point | Model selection |
| --- | --- |
| **CLI** | `--model` overrides the provider default. Otherwise, uses `ANTHROPIC_MODEL` or `NVIDIA_MODEL` according to `LLM_PROVIDER`. Without a provider setting, defaults to NVIDIA. |
| **HTTP / web** | Requests without `model` use `claude-opus-4-5`, including requests from the current web UI. Environment model overrides do not replace this request default. |

Model names also route calls to the corresponding provider. To use NVIDIA through HTTP, pass an explicit NVIDIA model in the request. Changing only `LLM_PROVIDER` does not switch the web UI away from Claude.

### Optional integrations

| Variables | Purpose |
| --- | --- |
| `NIA_API_KEY` | Query Nia for GitHub repository evidence and documentation. |
| `NIA_SLACK_SOURCE` | Search an indexed Slack source during documentation analysis. |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | Enable Sentry event analysis. |
| `GITHUB_TOKEN` | Authenticate the patch agent's GitHub push and CLI operations. Existing Git/CLI authentication can also be used. |

Without Nia, code search reads a local directory or clones a remote repository. With Nia configured for a GitHub repository, code search queries directly and skips indexing; ensure your source is available in Nia. The CLI's legacy `--reindex` flag does not reindex code search sources.

## Run the API

With the virtual environment active, from the repository root:

```bash
cd backend/agents
python -m uvicorn server:app --reload --port 8000
```

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Returns `{"status":"ok"}`. |
| `POST /investigate` | Runs the pipeline and streams `data:` events as `text/event-stream`. |

Example analysis request, with patching disabled:

```bash
curl -N http://localhost:8000/investigate \
  -H 'Content-Type: application/json' \
  -d '{"issue_title":"Refund uses the current product price","issue_body":"Refunds should reflect the amount paid.","repo_url":"https://github.com/eddieliu-dev/buzz","repo_name":"eddieliu-dev/buzz","enable_patch_agent":false}'
```

Events carry `agent`, `type`, `step`, `message`, `data`, and `timestamp`. A terminal pipeline event is either `complete`, with the report in `data.report`, or `error`, with the failure message. The frontend proxies this stream through `/api/investigate`.

## Run from the CLI

The following commands assume you are in `backend/agents/` with the virtual environment active. They call the pipeline directly; the FastAPI server does not need to be running.

### Included scenarios

```bash
python example/run_pipeline.py --list-scenarios
python example/run_pipeline.py --scenario refund_wrong_amount
```

| Scenario | Intentional demo bug |
| --- | --- |
| `discount_stacking` | Loyalty and promo discounts stack instead of selecting the larger discount. |
| `refund_wrong_amount` | Refunds use the current product price instead of the amount originally paid. |
| `both_bugs` | Investigate both issues; the default scenario. |

These inspect the local `business_case/` files and save `example/last_report.json`. Generated reports are ignored by Git. The ShopEasy server does not need to be running to investigate its source.

### Custom issue

```bash
python example/run_open_issue.py \
  --title "Refund amount changes after a product price update" \
  --body "Check whether process_refund uses current prices rather than purchase-time values." \
  --repo-url https://github.com/eddieliu-dev/buzz \
  --repo-name eddieliu-dev/buzz \
  --num-questions 3
```

This runner saves `example/last_open_report.json`. Use `--help` on either runner for model and investigation options.

### Patch generation

CLI runs require `--enable-patch-agent` to enable patching. Web investigations currently enable it automatically.

Patching writes files, creates a branch and commit, attempts to push to `origin`, and invokes `gh pr create`. It requires Git write access and authenticated GitHub CLI access. The current command opens a regular PR; it does not pass `--draft`. Generated remote workspaces live under the ignored `backend/agents/workspaces/` directory. Local directory inputs are modified in place when patching is enabled.

## Reports and tests

Reports include `issue`, `triage`, `investigation`, `documentation`, `log_analysis`, and `patch_generation`. Each section contains that stage's findings or its skipped/error result.

To run the local patch-agent test from `backend/agents/`:

```bash
python -m pip install pytest
PYTHONPATH=. python -m pytest tests/test_patch_agent.py
```

The local test mocks model calls, pushes, and PR creation. The remote integration test is skipped unless explicitly enabled with `PATCH_AGENT_RUN_REMOTE_E2E=1`; that test performs real remote operations.

## Optional ShopEasy demo server

To interact with the intentionally buggy app itself, open another terminal at the repository root:

```bash
source backend/.venv/bin/activate
python -m pip install -r business_case/requirements.txt
cd business_case
python -m uvicorn main:app --reload --port 8001
```

Use [localhost:8001](http://localhost:8001) for ShopEasy and keep port 8000 for the investigation API. Its deliberate business logic bugs are fixtures for investigating and patching.

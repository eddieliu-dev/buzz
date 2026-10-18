# Buzz · Web workspace

[Back to Buzz](../README.md) · [Backend guide](../backend/README.md)

The Next.js app serves the case dashboard, investigation UI, API routes, and GitHub/Slack integrations. Prisma stores case records and state transitions in SQLite. The Python service provides the investigation stream.

## Local setup

From the repository root:

```bash
cp frontend/.env.example frontend/.env
cd frontend
npm ci
npm run db:push
npm run dev
```

Open [localhost:3000](http://localhost:3000). `npm ci` generates the Prisma client through `postinstall`; `db:push` creates the tables. On subsequent runs, keep your existing `.env`.

Run the [agent service](../backend/README.md#run-the-api) on port 8000 to launch real investigations. The dashboard can run on its own, but new cases require GitHub or Slack ingestion.

## Environment

Use `frontend/.env` for `DATABASE_URL`, which Prisma reads. Next.js reads it too. Integration secrets can optionally go in `.env.local`; Next.js gives those values precedence, so avoid conflicting entries between the files.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | SQLite connection; the example uses `file:./dev.db`, resolved relative to the Prisma schema. |
| `BACKEND_URL` | Python agent service URL; defaults to `http://localhost:8000`. |
| `SLACK_BOT_TOKEN` | Post issue summaries and thread replies. |
| `SLACK_CHANNEL_ID` | Destination channel for GitHub issue notifications. |
| `SLACK_SIGNING_SECRET` | Verify Slack events and interaction payloads. |
| `GITHUB_WEBHOOK_SECRET` | Verify GitHub webhook signatures. |
| `GITHUB_DEFAULT_REPO` | Resolve Slack references such as `#123` to an `owner/repo`. |
| `CURSOR_OPEN_URL` | Optional override for the Open in Cursor handoff URL. |

Restart the development server after changing environment values.

## Connect GitHub and Slack

For local development, expose port 3000 through a public HTTPS tunnel and use that public base URL in your integration settings. GitHub and Slack cannot deliver webhooks to `localhost`.

### Slack

1. Configure a Slack app with a bot token, `chat:write` and `app_mentions:read` bot scopes, and invite it to your chosen channel.
2. Set `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, and `SLACK_SIGNING_SECRET` in your local environment file. Use the app's **Signing Secret**, not its client secret.
3. Enable event subscriptions at `https://<public-host>/api/slack/events` and subscribe to `app_mention`.
4. Enable interactivity at `https://<public-host>/api/slack/interactions` for thread action buttons.
5. Install or reinstall the app as needed after permission changes.

Mention the app with a bug description to create a case. You can include a GitHub issue URL, `owner/repo#123`, or `#123` when `GITHUB_DEFAULT_REPO` is set. Mentions without an issue reference create Slack-only cases. For web code investigations, include an issue reference when creating the case; the current case UI assumes a repository is available.

### GitHub

GitHub issue ingestion posts a Slack notification as part of its flow, so configure Slack posting first.

1. Create a repository webhook with URL `https://<public-host>/api/webhooks/github` and content type `application/json`.
2. Set a webhook secret and put the same value in `GITHUB_WEBHOOK_SECRET`.
3. Subscribe to **Issues** events.
4. Open a new issue in that repository, then refresh the Buzz dashboard and open its case.

A GitHub App can use the same webhook URL and secret; subscribe it to issues and install it on the intended repositories. The current handler processes only `issues.opened`. Other event types are accepted and logged without starting investigations.

## Investigation behavior

Open a case and choose **Launch Investigation**. Agent events stream through `/api/investigate`, with evidence in the agent panels and a report after completion.

Web investigations currently request patch generation, which can write code, commit, push a branch, and open a PR using the backend's Git credentials. See [patch behavior](../backend/README.md#patch-generation) before running against a repository.

Failed requests, fatal pipeline errors, malformed events, and streams that close before completion show an error and a **Retry investigation** button. Retry uses the same issue details. Finished agent results remain visible; unfinished agents stop.

Reset and navigation cancel the client stream. Already-running Python work may continue, and retry starts a new run. Reports currently live in page memory and disappear on refresh; completing an investigation does not yet update the stored case state.

## Commands

Run these from `frontend/`:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server. |
| `npm run build` | Build the production app; Google Fonts downloads require network access on a fresh build. |
| `npm run start` | Serve an existing production build. |
| `npm run lint` | Check ESLint rules. |
| `npm run typecheck` | Check TypeScript without emitting files. |
| `npm test` | Run investigation regression tests without API keys. |
| `npm run db:push` | Apply the Prisma schema to the local database. |
| `npm run db:studio` | Inspect cases and transitions in Prisma Studio. |

## Source map

```text
app/                      Dashboard, case pages, API routes
components/investigate/   Agent panels, error UI, investigation report
components/layout/        Navigation
components/ui/            Shared UI primitives
lib/                      Investigation engine, stream parser, integration helpers
prisma/                   Case and transition schema
scripts/                  Manual Slack posting utility
tests/                    Investigation, streaming, proxy, and UI regression tests
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Empty dashboard | Configure ingestion, create an issue or mention the Slack app, and refresh. |
| Backend unavailable | Start the Python server, check `/health`, and verify `BACKEND_URL`. |
| Slack does not respond | Check the public event URL, bot membership/scopes, signing secret, and server logs. |
| Signature verification fails | Ensure the provider and app have the same secret and the webhook points to the current public host. |
| Prisma cannot find the database | Create `.env`, verify `DATABASE_URL`, and run `npm run db:push`. |
| Build cannot fetch fonts | Allow network access to Google Fonts for the build. |

`SKIP_SLACK_SIGNATURE_VERIFY=1` is a local debugging option. Leave it unset for normal webhook verification.

# Convex Cloud

Deployment: **grokbot-clone** / production `youthful-mockingbird-449`
URL: `https://youthful-mockingbird-449.convex.cloud`
Dashboard: <https://dashboard.convex.dev/t/anti-nrml/grokbot-clone/youthful-mockingbird-449>

## What it is, and what it is not

grokbot-clone's primary store is **SQLite on the host** (`server/src/db.ts`): users, bots,
transcript rows, model history, approvals, routines, memories, computers. That is a
single-writer design and is the right shape for one server, so it stays.

This Convex deployment is a **durable side-channel**, not a mirror of that database. The
schema in `convex/schema.ts` defines the tables that a per-host SQLite file cannot serve:

| Table | Purpose |
| --- | --- |
| `bots` | bot identity stable across hosts |
| `events` | append-only activity log (`by_bot_at`) |
| `outbox` | work that must survive a process restart, with attempt counts for backoff |
| `templates` | reusable bot definitions |

`convex/functions.ts` holds the query/mutation surface for those tables. Nothing in the
application reads them at runtime yet — this is deliberately honest: pushing an empty
schema would have made the deployment "exist" while providing nothing.

## Deploying

Use a scoped deploy key, not a personal token:

```bash
CONVEX_DEPLOY_KEY=<key> npx convex deploy --typecheck disable
```

The key in `.env` is scoped to `deployment:deploy` on this one production deployment.
Mint another with:

```bash
curl -X POST https://api.convex.dev/v1/deployments/youthful-mockingbird-449/create_deploy_key \
  -H "Authorization: Bearer $CONVEX_PERSONAL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"label","allowedActions":["deployment:deploy"]}'
```

`npx convex deploy` also honours `CONVEX_DEPLOYMENT=prod:<name>`; if both are set the key
wins. Keep `CONVEX_DEPLOY_KEY` out of any environment a bot's shell can inherit.

## Verifying

```bash
curl -s -X POST https://youthful-mockingbird-449.convex.cloud/api/query \
  -H 'Content-Type: application/json' \
  -d '{"path":"functions:bot","args":{"botId":"probe"},"format":"json"}'
# {"status":"success","value":null}
```

`value: null` is the correct answer for a bot id that does not exist, and proves the
function, the schema and the index are all live.

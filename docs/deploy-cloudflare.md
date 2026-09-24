# Deploying rx-jev to Cloudflare

rx-jev runs as two Workers:

- **`rx-jev-api`**, the API Worker. It has no public URL (`workers_dev: false`) and uses these bindings:
  - D1 `DB`, the judgment store and the openFDA lookup cache;
  - KV `CACHE`, RxNorm's name list;
  - the Durable Object `AskLimiter`, the per-client ask limit;
  - a daily Cron Trigger that refreshes the name list.
- **`rx-jev-web`**, the web Worker. It serves the Vite build and passes `/api/*` to `rx-jev-api` through a service binding, so the site is one origin.

PLAN.md says not to launch publicly before Gate 2, so the site sits behind Cloudflare Access. In the order below, Access is on before the web Worker first deploys, so the site is never public.

Run every command from the repository root unless a step says otherwise. Steps 1 to 9 are one-time setup.

## Before you start

- **A Cloudflare account on the Workers Paid plan ($5 a month).** The Free plan allows 10 ms of CPU per request. Building the Jev request for a long label and splitting it into sentences takes longer than that.
- **Your TypeSafe API key, and an openFDA API key.** The openFDA key is optional but recommended; get one at https://open.fda.gov/apis/authentication/.
- **`apps/api/rx_jev.db`**, the store to import.
- **`npm install` done.**

## 1. Log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser for you to approve Wrangler. Check which account you are on:

```bash
npx wrangler whoami
```

## 2. Create the D1 database

```bash
cd apps/worker && npx wrangler d1 create rx-jev
```

Copy the `database_id` it prints into `apps/worker/wrangler.jsonc`, under `d1_databases`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "rx-jev",
    "database_id": "<paste here>",
    "migrations_dir": "migrations"
  }
],
```

## 3. Create the KV namespace

```bash
cd apps/worker && npx wrangler kv namespace create CACHE
```

Copy the `id` it prints into `kv_namespaces`:

```jsonc
"kv_namespaces": [{ "binding": "CACHE", "id": "<paste here>" }],
```

Commit both IDs. They are not secrets.

## 4. Create the tables and import the store

```bash
make db-remote
```

This applies the D1 migrations, then copies `apps/api/rx_jev.db` into D1, keeping every ID. Then it checks each run. Expect this output:

```
141/141 runs found for their label.
23/123 labels have a run for today's prompt, so load without Jev.
```

It is safe to run again: rows already in D1 are left as they are. Only 23 labels have a run for today's prompt, as on the Python app: the other labels were judged before the Gate 1 prompt changes and are judged again the first time someone opens them.

## 5. Deploy the API Worker

```bash
cd apps/worker && npx wrangler deploy
```

It has no URL of its own, so nothing is public yet.

## 6. Add the secrets

```bash
cd apps/worker && npx wrangler secret put TYPESAFE_API_KEY
```

```bash
cd apps/worker && npx wrangler secret put OPENFDA_API_KEY
```

Each command asks for the value; paste it at the prompt. Values never go in a file or the repository.

## 7. Put Cloudflare Access in front of the site

Do this before the web Worker's first deploy.

1. Find your workers.dev subdomain: in the dashboard, go to **Workers & Pages**. It is shown on the right, as `<subdomain>.workers.dev`. The site will be at `rx-jev-web.<subdomain>.workers.dev`.
2. Go to **Zero Trust**, then **Access**, then **Applications**, then **Add an application**, and choose **Self-hosted**.
   - Name: `rx-jev`.
   - Domain: `rx-jev-web.<subdomain>.workers.dev`.
   - Session duration: whatever suits you, for example 24 hours.
3. Add a policy named `Owners`:
   - Action: **Allow**.
   - Include: **Emails**, listing the addresses allowed in (yours, and later the Gate 2 reviewers).
4. Save.

For a custom domain instead: add the domain to Cloudflare, protect that hostname in Access in the same way, and add it to `apps/web/wrangler.jsonc` under `routes`, with `"custom_domain": true`.

## 8. Deploy the web Worker

```bash
cd apps/web && npm run deploy
```

This builds the app and deploys it. Check that Access protects it: open `https://rx-jev-web.<subdomain>.workers.dev` in a private window. You should get the Cloudflare Access login, not the app.

After this first time, `make deploy` deploys both Workers, the API first.

## 9. Service token for scripts

The smoke test runs without a browser, so it needs a service token.

1. In **Zero Trust**, go to **Access**, then **Service credentials**, then **Service tokens**, then **Create service token**. Name it `rx-jev-smoke`.
2. Copy the Client ID and Client Secret it shows. The secret is shown only once.
3. In the `rx-jev` application, add a second policy:
   - Action: **Service Auth**.
   - Include: **Service Token** `rx-jev-smoke`.

## 10. Smoke test

```bash
ACCESS_CLIENT_ID=<id> ACCESS_CLIENT_SECRET=<secret> make smoke URL=https://rx-jev-web.<subdomain>.workers.dev
```

It checks the health route, then loads Tylenol PM, Wellbutrin and Benadryl. It passes only if every label is served from the store, with no Jev call:

```
health: ok
Tylenol PM: otc v9 from the store
Wellbutrin: prescription v23 from the store
Benadryl: otc v8 from the store, prescription v2 from the store
Smoke test passed.
```

If a label says `judged now`, openFDA has published a newer version of it since the import. That label has been judged and stored now, so run the test again.

The first search suggestion after a deploy can take about 10 seconds: RxNorm's name list is not in KV until the first request, or the Cron at 04:17 UTC, fetches it.

## 11. Cutover

When the smoke test passes, tell Claude to finish M6.11: remove `apps/api` and update CLAUDE.md, the Makefile and the README for the TypeScript stack. The Python app stays the reference until then.

## Local development

1. Put the keys in `apps/worker/.dev.vars`, which Git ignores:

   ```
   TYPESAFE_API_KEY=...
   OPENFDA_API_KEY=...
   ```

2. Create the local D1 and import the store (once):

   ```bash
   make db-local
   ```

3. Run the API Worker on :8787 and Vite on :5173:

   ```bash
   make -j2 dev
   ```

To run both Workers as they run in production, on one port:

```bash
cd apps/web && npm run build
```

```bash
npx wrangler dev -c apps/web/wrangler.jsonc -c apps/worker/wrangler.jsonc --persist-to apps/worker/.wrangler/state
```

## Offline tools

The review-set batch, the review sheet and the second read run in Node against the local D1, or against the deployed one with `--remote`:

```bash
cd apps/worker && npm run tools:precompute -- --remote
```

```bash
cd apps/worker && npm run tools:review-sheet -- review_set_report.json 60 1 --remote
```

```bash
cd apps/worker && npm run tools:second-read -- packets --remote
```

## Costs and limits

- **Workers Paid: $5 a month.** That includes 10 million requests.
- **D1:** the store is about 14 MB against a 10 GB limit. The largest label is 265 KB, under D1's 2 MB row limit.
- **KV:** one key, RxNorm's name list, about 0.7 MB.
- **Durable Objects:** one small object per client address that asks a custom question.
- **Jev:** a stored label costs nothing to serve. A label judged for the first time costs 10K to 40K input tokens, and every custom question costs about 2K. Asks are limited to 5 a minute and 50 a day per client. Change `ASK_PER_MINUTE` and `ASK_PER_DAY` in `apps/worker/wrangler.jsonc` to adjust.

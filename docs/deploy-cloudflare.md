# Deploying rx-jev to Cloudflare

rx-jev runs as two Workers:

- **`rx-jev-api`**, the API Worker. It has no public URL (`workers_dev: false`) and uses these bindings:
  - D1 `DB`, the judgment store and the openFDA lookup cache;
  - KV `CACHE`, RxNorm's name list;
  - the Durable Object `AskLimiter`, the per-client ask limit;
  - a daily Cron Trigger that refreshes the name list.
- **`rx-jev-web`**, the web Worker. It serves the Vite build and passes `/api/*` to `rx-jev-api` through a service binding, so the site is one origin.

rx-jev is a public #BuildInPublic demo, launched on purpose before the Gate 2 review (see PLAN.md). These safeguards keep it a demo and cap what it can cost:
- the red caution strip on every page;
- the per-client ask limits (5 a minute, 50 a day);
- a Cloudflare rate-limiting rule on `/api/labels/*` (step 9);
- a spending cap on the TypeSafe account (step 10).

To keep the site private instead, put Cloudflare Access in front; see the optional section at the end.

Run every command from the repository root unless a step says otherwise. Steps 1 to 10 are one-time setup.

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

If Wrangler asks whether to add the database to your config, answer **no**. Saying yes adds
a second entry with a new binding instead of filling in the existing `DB` entry, and the
import then cannot find the database.

Copy the `database_id` it prints into `apps/worker/wrangler.jsonc`, into the existing `DB`
entry under `d1_databases`:

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

Answer **no** again if Wrangler offers to add it to your config. Copy the `id` it prints into
the existing `CACHE` entry under `kv_namespaces`:

```jsonc
"kv_namespaces": [{ "binding": "CACHE", "id": "<paste here>" }],
```

There should be one `d1_databases` entry and one `kv_namespaces` entry. Commit both IDs. They
are not secrets.

Local development keys its D1 by the ID, so run `make db-local` once more after adding it.

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

## 7. Deploy the web Worker

```bash
cd apps/web && npm run deploy
```

This builds the app and deploys it to `https://rx-jev-web.<subdomain>.workers.dev`. Your subdomain is shown in the dashboard under **Workers & Pages**. The site is public from this moment, so do steps 9 and 10 today.

After this first time, `make deploy` deploys both Workers, the API first.

## 8. Move to a custom domain

A rate-limiting rule only applies to hostnames in a Cloudflare zone you own, and `workers.dev` is not one. So serve the site on your own domain and turn the `workers.dev` URL off, leaving no way around the rule.

1. Add the domain to Cloudflare, or use one that is already there.
2. In `apps/web/wrangler.jsonc`, turn off `workers.dev` and add the domain as a custom domain:

   ```jsonc
   "workers_dev": false,
   "preview_urls": false,
   "routes": [{ "pattern": "rx-jev.example.com", "custom_domain": true }],
   ```

   Use your hostname in place of `rx-jev.example.com`. Wrangler creates the DNS record and the certificate on deploy.
3. Deploy again:

   ```bash
   cd apps/web && npm run deploy
   ```

4. Check that `https://rx-jev.example.com` serves the app, and that `https://rx-jev-web.<subdomain>.workers.dev` no longer does.

The API Worker needs no change: it has no public URL, and the web Worker reaches it through the service binding.

## 9. Add a rate-limiting rule

The Worker already limits custom questions per client. This rule also covers the answers route, since opening a label nobody has opened yet makes a Jev call of 10K to 40K tokens.

In the dashboard, open your domain and go to **Security**, then **Security rules**, then **Create rule**, then **Rate limiting rule**.

- **Name:** `rx-jev api`.
- **If incoming requests match:** Field **URI Path**, Operator **starts with**, Value `/api/labels/`.
- **With the same characteristics:** **IP**.
- **When rate exceeds:** 20 requests per 10 seconds. The Free plan allows only a 10-second period; on Pro and above, 60 requests per minute works too.
- **Then take action:** **Block**, for 10 seconds (the Free plan's duration), or longer on paid plans.
- **Deploy.**

One visitor opening a drug makes one request to `/api/labels/…/answers`, and each custom question makes one more. So the limit leaves normal use untouched and stops a script walking through many drugs.

## 10. Set a spending cap on TypeSafe

The TypeSafe key pays for every Jev call. At [console.typesafe.ai](https://console.typesafe.ai/), set a monthly spending limit on the account that owns the key, and an alert below it.

If the console offers only alerts and no hard limit, keep the account on prepaid credit, so usage stops when the credit runs out.

When the cap is reached, Jev calls fail. The Worker then returns "Answers are unavailable right now" for labels that are not stored yet and for custom questions. Stored answers keep loading, because they never call Jev.

## 11. Smoke test

```bash
make smoke URL=https://rx-jev.example.com
```

Behind Cloudflare Access, pass a service token too (see the optional section at the end):

```bash
ACCESS_CLIENT_ID=<id> ACCESS_CLIENT_SECRET=<secret> make smoke URL=https://rx-jev.example.com
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

## 12. Cutover

When the smoke test passes, tell Claude to finish M6.11: remove `apps/api` and update CLAUDE.md, the Makefile and the README for the TypeScript stack. The Python app stays the reference until then.

## Optional: keep the site private with Cloudflare Access

Access puts a login in front of the site, for example for a partner preview.

1. In the dashboard, go to **Zero Trust**, then **Access**, then **Applications**, then **Add an application**. Choose **Self-hosted**.
   - Name: `rx-jev`.
   - Domain: your custom domain, or `rx-jev-web.<subdomain>.workers.dev`.
2. Add a policy named `Owners`:
   - Action: **Allow**.
   - Include: **Emails**, listing the addresses allowed in.
3. For the smoke test, add a service token:
   1. Go to **Access**, then **Service credentials**, then **Service tokens**, and create a token named `rx-jev-smoke`. Copy its Client ID and Client Secret; the secret is shown only once.
   2. Add a second policy: Action **Service Auth**, Include **Service Token** `rx-jev-smoke`.
4. Check it in a private window: you should get the Access login, not the app.

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

# rx-jev

Type a drug name, pick a question like "pregnancy" or "diabetes", and see what the official
label says about it, quoted word for word.

rx-jev reads US drug labels from openFDA and uses [TypeSafe Jev](https://docs.typesafe.ai)
to find the sentence that answers your question. It does not give medical advice and does
not say whether a drug is right for you. Ask a pharmacist or doctor.

> Status: a public prototype on Cloudflare Workers, built in public. It is a demo, not medical
> advice, and has not yet had the Gate 2 review. See [PLAN.md](PLAN.md) for milestones.

## Requirements

- Node 24 and npm
- A TypeSafe API key from [console.typesafe.ai](https://console.typesafe.ai/)

## Setup

```bash
make install
```

Put your keys in `apps/worker/.dev.vars`, which Git ignores:

```
TYPESAFE_API_KEY=...
OPENFDA_API_KEY=...
```

Create the local D1 database:

```bash
make db-local
```

## Run

```bash
make -j2 dev
```

- Web: http://localhost:5173
- API Worker: http://localhost:8787/api/health

## Test and lint

```bash
make test
```

```bash
make lint
```

## Deploy

See [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md).

## Layout

```
apps/
  worker/   API Worker: Hono, Drizzle on D1, KV, Durable Objects, TypeSafe Jev
  web/      Vite + React app, and the web Worker that serves it
packages/
  contract/ zod schemas of the API, shared by both apps
fixtures/   recorded RxNorm and openFDA responses, golden files from the retired Python app
PLAN.md     product, architecture, milestones
CLAUDE.md   rules for AI coding agents working in this repo
```

## Data sources

- [RxNorm](https://lhncbc.nlm.nih.gov/RxNav/) for drug name resolution
- [openFDA drug label API](https://open.fda.gov/apis/drug/label/) for label text
- [DailyMed](https://dailymed.nlm.nih.gov/) for links to the full label

All label data is public. This repository contains no patient data.

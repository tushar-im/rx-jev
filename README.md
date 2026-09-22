# rx-jev

Type a drug name, pick a question like "pregnancy" or "diabetes", and see what the official
label says about it, quoted word for word.

rx-jev reads US drug labels from openFDA and uses [TypeSafe Jev](https://docs.typesafe.ai)
to find the sentence that answers your question. It does not give medical advice and does
not say whether a drug is right for you. Ask a pharmacist or doctor.

> Status: scaffold only. See [PLAN.md](PLAN.md) for milestones.

## Requirements

- Python 3.13 and [uv](https://docs.astral.sh/uv/)
- Node 24 and npm
- A TypeSafe API key from [console.typesafe.ai](https://console.typesafe.ai/), needed from M2

## Setup

```bash
make install
cp apps/api/.env.example apps/api/.env
```

Then put your key in `apps/api/.env`.

## Run

```bash
make -j2 dev
```

- Web: http://localhost:5173
- API: http://localhost:8000, interactive docs at http://localhost:8000/docs

## Test and lint

```bash
make test
```

```bash
make lint
```

## Layout

```
apps/
  api/   FastAPI backend: RxNorm, openFDA, Jev, storage
  web/   Vite + React frontend
PLAN.md    product, architecture, milestones
CLAUDE.md  rules for AI coding agents working in this repo
```

## Data sources

- [RxNorm](https://lhncbc.nlm.nih.gov/RxNav/) for drug name resolution
- [openFDA drug label API](https://open.fda.gov/apis/drug/label/) for label text
- [DailyMed](https://dailymed.nlm.nih.gov/) for links to the full label

All label data is public. This repository contains no patient data.

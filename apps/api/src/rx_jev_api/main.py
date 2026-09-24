from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from rx_jev_api.config import get_settings
from rx_jev_api.problems import register_problem_handlers
from rx_jev_api.routers import answers, drugs, health, labels

app = FastAPI(title="rx-jev API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
register_problem_handlers(app)

app.include_router(health.router)
app.include_router(drugs.router)
app.include_router(labels.router)
app.include_router(answers.router)

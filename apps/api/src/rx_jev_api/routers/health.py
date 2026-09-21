from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/health", tags=["health"])


class Health(BaseModel):
    status: Literal["ok"]


@router.get("")
def read_health() -> Health:
    return Health(status="ok")

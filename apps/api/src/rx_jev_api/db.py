from sqlalchemy import Engine
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, create_engine

# Import the table models so create_all sees them.
from rx_jev_api import store  # noqa: F401

__all__ = ["make_engine"]


def make_engine(url: str) -> Engine:
    """Create an engine and its tables. `sqlite://` gives a shared in-memory database."""
    if url.startswith("sqlite"):
        in_memory = url in ("sqlite://", "sqlite:///:memory:")
        engine = create_engine(
            url,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool if in_memory else None,
        )
    else:
        engine = create_engine(url)
    SQLModel.metadata.create_all(engine)
    return engine

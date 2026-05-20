"""Alembic environment for OmniVoice Studio.

DB URL is computed from `core.config.DB_PATH` at runtime so Alembic honours
the same `OMNIVOICE_DATA_DIR` override the app does. We use SQLite, so both
offline (SQL-scripted) and online (live-connection) paths are supported.

We do NOT use SQLAlchemy models — the schema lives in `core/db.py`'s
`_BASE_SCHEMA`. Migrations are hand-written using raw `op.execute(...)`
or the typed helpers (`op.add_column`, etc.). No autogeneration.
"""
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from core.config import DB_PATH  # noqa: E402 — backend/ is on sys.path via alembic.ini

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# SQLite file URL. Honour an externally-set URL (tests pass one via
# `cfg.set_main_option("sqlalchemy.url", ...)` to point at a fixture DB),
# otherwise resolve from `core.config.DB_PATH` so production runs respect
# the `OMNIVOICE_DATA_DIR` override.
if not config.get_main_option("sqlalchemy.url"):
    config.set_main_option("sqlalchemy.url", f"sqlite:///{DB_PATH}")

target_metadata = None  # no SQLAlchemy models — hand-written migrations only.


def run_migrations_offline() -> None:
    """Emit SQL to stdout without connecting to the DB."""
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,  # SQLite-safe ALTER
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Apply migrations against a live SQLite connection."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,  # SQLite-safe ALTER
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

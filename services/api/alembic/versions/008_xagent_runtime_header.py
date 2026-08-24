"""Store the DSH runtime session header.

Revision ID: 008_xagent_runtime_header
Revises: 007_xagent_sessions
Create Date: 2026-08-25
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "008_xagent_runtime_header"
down_revision = "007_xagent_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "xagent_sessions",
        sa.Column("runtime_header", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("xagent_sessions", "runtime_header")

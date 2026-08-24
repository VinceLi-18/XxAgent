import argparse
import asyncio
import getpass
import sys
from datetime import UTC, datetime

from argon2 import PasswordHasher
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.auth import XAgentAccountCredential, XAgentAuthSession, XAgentPermissionRevision
from app.models.identity import Account, Role

_password_hasher = PasswordHasher()


class AccountOperationRejected(Exception):
    pass


class AccountAdminSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file="../.env", env_ignore_empty=True, extra="ignore")

    DATABASE_ADMIN_URL: str


def _normalize_email(email: str) -> str:
    normalized = email.strip().casefold()
    if not normalized or len(normalized) > 320:
        raise AccountOperationRejected
    return normalized


def _read_password() -> str:
    if sys.stdin.isatty():
        password = getpass.getpass("新密码：")
        confirmation = getpass.getpass("再次输入新密码：")
    else:
        password = sys.stdin.readline().removesuffix("\n")
        confirmation = sys.stdin.readline().removesuffix("\n")
    if password != confirmation:
        raise ValueError("两次输入的密码不一致")
    if len(password) < 12 or len(password) > 1024:
        raise ValueError("密码长度必须为 12 至 1024 个字符")
    return password


async def _create_account(
    sessions: async_sessionmaker[AsyncSession],
    email: str,
    role: Role,
) -> None:
    normalized = _normalize_email(email)
    async with sessions() as session:
        async with session.begin():
            existing = await session.scalar(
                select(Account.id).where(func.lower(Account.email) == normalized)
            )
            if existing is not None:
                raise AccountOperationRejected
            session.add(Account(email=normalized, role=role, is_active=True))


async def _set_password(
    sessions: async_sessionmaker[AsyncSession],
    email: str,
    password: str,
) -> None:
    normalized = _normalize_email(email)
    now = datetime.now(UTC)
    password_hash = _password_hasher.hash(password)
    async with sessions() as session:
        async with session.begin():
            account = await session.scalar(
                select(Account).where(func.lower(Account.email) == normalized).with_for_update()
            )
            if account is None:
                raise AccountOperationRejected
            credential = await session.get(XAgentAccountCredential, account.id)
            if credential is None:
                session.add(
                    XAgentAccountCredential(
                        account_id=account.id,
                        password_hash=password_hash,
                        password_changed_at=now,
                    )
                )
            else:
                credential.password_hash = password_hash
                credential.password_changed_at = now
            await session.execute(
                update(XAgentAuthSession)
                .where(
                    XAgentAuthSession.account_id == account.id,
                    XAgentAuthSession.revoked_at.is_(None),
                )
                .values(revoked_at=now)
            )
            revision = await session.get(XAgentPermissionRevision, account.id, with_for_update=True)
            if revision is None:
                raise AccountOperationRejected
            revision.revision += 1
            revision.updated_at = now


async def _deactivate_account(
    sessions: async_sessionmaker[AsyncSession],
    email: str,
) -> None:
    normalized = _normalize_email(email)
    now = datetime.now(UTC)
    async with sessions() as session:
        async with session.begin():
            account = await session.scalar(
                select(Account).where(func.lower(Account.email) == normalized).with_for_update()
            )
            if account is None:
                raise AccountOperationRejected
            account.is_active = False
            await session.execute(
                update(XAgentAuthSession)
                .where(
                    XAgentAuthSession.account_id == account.id,
                    XAgentAuthSession.revoked_at.is_(None),
                )
                .values(revoked_at=now)
            )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="xagent-api")
    commands = parser.add_subparsers(dest="domain", required=True)
    account = commands.add_parser("account")
    account_commands = account.add_subparsers(dest="operation", required=True)

    create = account_commands.add_parser("create")
    create.add_argument("--email", required=True)
    create.add_argument("--role", choices=[role.value for role in Role], required=True)

    set_password = account_commands.add_parser("set-password")
    set_password.add_argument("--email", required=True)

    deactivate = account_commands.add_parser("deactivate")
    deactivate.add_argument("--email", required=True)
    return parser


async def _run(args: argparse.Namespace, sessions: async_sessionmaker[AsyncSession]) -> str:
    if args.domain != "account":
        raise AccountOperationRejected
    if args.operation == "create":
        await _create_account(sessions, args.email, Role(args.role))
        return "账号已创建"
    if args.operation == "set-password":
        await _set_password(sessions, args.email, _read_password())
        return "密码已更新，既有登录已撤销"
    if args.operation == "deactivate":
        await _deactivate_account(sessions, args.email)
        return "账号已停用，既有登录已撤销"
    raise AccountOperationRejected


async def _run_and_dispose(args: argparse.Namespace) -> str:
    settings = AccountAdminSettings()
    engine = create_async_engine(settings.DATABASE_ADMIN_URL, pool_pre_ping=True)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        return await _run(args, sessions)
    finally:
        await engine.dispose()


def main() -> None:
    args = _parser().parse_args()
    try:
        message = asyncio.run(_run_and_dispose(args))
    except ValueError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2) from None
    except (AccountOperationRejected, IntegrityError):
        print("账号操作失败", file=sys.stderr)
        raise SystemExit(2) from None
    print(message)


if __name__ == "__main__":
    main()

import argparse
import asyncio
import getpass
import sys
from datetime import UTC, datetime

from argon2 import PasswordHasher
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.database_engine import create_database_engine
from app.models.auth import XAgentAccountCredential, XAgentAuthSession, XAgentPermissionRevision
from app.models.identity import Account, Role
from app.models.workbench import XAgentCapability
from app.services.capabilities import (
    CapabilityOperationRejected,
    effective_capabilities_for_email,
    grant_capability,
    revoke_capability,
)

_password_hasher = PasswordHasher()


class AccountOperationRejected(Exception):
    pass


class AccountAdminSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file="../.env", env_ignore_empty=True, extra="ignore")

    DATABASE_ADMIN_URL: str
    POSTGRES_PASSWORD: str | None = None


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

    capability = account_commands.add_parser("capability")
    capability_commands = capability.add_subparsers(
        dest="capability_operation",
        required=True,
    )
    grant = capability_commands.add_parser("grant")
    grant.add_argument("--email", required=True)
    grant.add_argument(
        "--capability",
        choices=[capability.value for capability in XAgentCapability],
        required=True,
    )
    grant.add_argument("--granted-by", required=True)
    revoke_capability_parser = capability_commands.add_parser("revoke")
    revoke_capability_parser.add_argument("--email", required=True)
    revoke_capability_parser.add_argument(
        "--capability",
        choices=[capability.value for capability in XAgentCapability],
        required=True,
    )
    show_capabilities = capability_commands.add_parser("show")
    show_capabilities.add_argument("--email", required=True)

    worker = commands.add_parser(
        "worker",
        help="处理扫描、对象清理与资料索引持久任务",
    )
    worker.add_argument("--once", action="store_true", help="处理当前可领取任务后退出")
    roles = commands.add_parser("roles")
    roles_commands = roles.add_subparsers(dest="operation", required=True)
    roles_commands.add_parser("ensure")
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
    if args.operation == "capability" and args.capability_operation == "grant":
        async with sessions() as session:
            async with session.begin():
                changed = await grant_capability(
                    session,
                    email=args.email,
                    capability=XAgentCapability(args.capability),
                    granted_by=args.granted_by,
                )
        state = "已授予" if changed else "已存在"
        return f"能力{state}：{args.capability}"
    if args.operation == "capability" and args.capability_operation == "revoke":
        async with sessions() as session:
            async with session.begin():
                changed = await revoke_capability(
                    session,
                    email=args.email,
                    capability=XAgentCapability(args.capability),
                )
        state = "已撤销" if changed else "不存在"
        return f"能力{state}：{args.capability}"
    if args.operation == "capability" and args.capability_operation == "show":
        async with sessions() as session:
            capabilities = await effective_capabilities_for_email(
                session,
                args.email,
            )
        rendered = "、".join(sorted(capability.value for capability in capabilities))
        return f"有效能力：{rendered or '无'}"
    raise AccountOperationRejected


async def _run_and_dispose(args: argparse.Namespace) -> str:
    settings = AccountAdminSettings()
    engine = create_database_engine(
        settings.DATABASE_ADMIN_URL,
        password=settings.POSTGRES_PASSWORD,
    )
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        return await _run(args, sessions)
    finally:
        await engine.dispose()


def main() -> None:
    args = _parser().parse_args()
    if args.domain == "worker":
        from app.worker import run_worker

        asyncio.run(run_worker(once=args.once))
        return
    if args.domain == "roles":
        from app.roles import ensure_database_roles

        asyncio.run(ensure_database_roles())
        return
    try:
        message = asyncio.run(_run_and_dispose(args))
    except ValueError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2) from None
    except (AccountOperationRejected, CapabilityOperationRejected, IntegrityError):
        print("账号操作失败", file=sys.stderr)
        raise SystemExit(2) from None
    print(message)


if __name__ == "__main__":
    main()

import os
import subprocess
import time
from pathlib import Path

import pytest


if os.environ.get("XAGENT_COMPOSE_UPGRADE_E2E") != "1":
    pytest.skip(
        "set XAGENT_COMPOSE_UPGRADE_E2E=1 to run the retained-volume upgrade test",
        allow_module_level=True,
    )

_REPOSITORY = Path(__file__).resolve().parents[4]
_COMPOSE_FILE = _REPOSITORY / "services/api/compose.test.yml"
_PROJECT = "xagent-api-upgrade"


def _compose(*args: str, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [
            "docker",
            "compose",
            "--project-name",
            _PROJECT,
            "-f",
            str(_COMPOSE_FILE),
            *args,
        ],
        cwd=_REPOSITORY,
        input=input_text,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"docker compose {' '.join(args)} failed ({result.returncode})\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def _container_state(service: str) -> tuple[str, str]:
    container_id = _compose("ps", "--all", "--quiet", service).stdout.strip()
    assert container_id, f"{service} has no container"
    inspected = subprocess.run(
        [
            "docker",
            "inspect",
            "--format",
            "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} {{.State.ExitCode}}",
            container_id,
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    ).stdout.strip()
    status, health, exit_code = inspected.split(" ")
    return status, health or exit_code


def _wait_for_state(service: str, expected: tuple[str, str]) -> None:
    deadline = time.monotonic() + 60
    last_state: tuple[str, str] | None = None
    while time.monotonic() < deadline:
        last_state = _container_state(service)
        if last_state == expected:
            return
        time.sleep(0.25)
    raise AssertionError(
        f"{service} did not reach {expected} within 60 seconds; last state: {last_state}"
    )


def test_retained_pre_roles_volume_bootstraps_and_recovers_missing_worker_role() -> None:
    _compose("down", "--volumes", "--remove-orphans")
    try:
        _compose("up", "-d", "postgres", "--wait")
        _compose(
            "exec",
            "-T",
            "postgres",
            "psql",
            "--set=ON_ERROR_STOP=1",
            "--username",
            "postgres",
            "--dbname",
            "xagent_api_test",
            input_text=(
                "DROP ROLE IF EXISTS xagent_e2e_app;\n"
                "DROP ROLE IF EXISTS xagent_e2e_worker;\n"
                "CREATE ROLE xagent_e2e_app LOGIN PASSWORD 'old-app-password';\n"
                "CREATE ROLE xagent_e2e_worker LOGIN PASSWORD 'old-worker-password';\n"
            ),
        )
        _compose(
            "exec",
            "-T",
            "postgres",
            "sh",
            "-c",
            'rm -f "$PGDATA/.xagent-roles-ready"',
        )
        _compose("down", "--remove-orphans")

        _compose("up", "-d", "roles")
        _wait_for_state("roles", ("exited", "0"))
        _compose("down", "--remove-orphans")

        _compose("up", "-d", "postgres", "--wait")
        _compose(
            "exec",
            "-T",
            "postgres",
            "psql",
            "--set=ON_ERROR_STOP=1",
            "--username",
            "postgres",
            "--dbname",
            "xagent_api_test",
            input_text="DROP ROLE xagent_e2e_worker;\n",
        )
        _compose("down", "--remove-orphans")

        _compose("up", "-d", "--no-build", "--wait")
        assert _container_state("roles") == ("exited", "0")
        assert _container_state("migrate") == ("exited", "0")
        assert _container_state("api") == ("running", "healthy")
        assert _container_state("worker")[0] == "running"
    finally:
        _compose("down", "--volumes", "--remove-orphans")

import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from .db import connect, dumps, now_iso


ExecutorFn = Callable[[str, dict[str, Any]], dict[str, Any]]
executor = ThreadPoolExecutor(max_workers=2)


def create_job(project_id: str, job_type: str, payload: dict[str, Any], fn: ExecutorFn) -> str:
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    with connect() as con:
        con.execute(
            """
            insert into jobs(id, project_id, job_type, status, progress, input, output, created_at, updated_at)
            values (?, ?, ?, 'queued', 0, ?, '{}', ?, ?)
            """,
            (job_id, project_id, job_type, dumps(payload), now_iso(), now_iso()),
        )
    executor.submit(_run_job, job_id, payload, fn)
    return job_id


def _run_job(job_id: str, payload: dict[str, Any], fn: ExecutorFn) -> None:
    _update(job_id, status="running", progress=0.1)
    try:
        output = fn(job_id, payload)
        _update(job_id, status="succeeded", progress=1, output=output)
    except Exception as exc:  # pragma: no cover - keeps API alive for operator debugging
        _update(job_id, status="failed", progress=1, error=f"{exc}\n{traceback.format_exc()}")


def _update(
    job_id: str,
    *,
    status: str | None = None,
    progress: float | None = None,
    error: str | None = None,
    output: dict[str, Any] | None = None,
) -> None:
    fields: list[str] = ["updated_at = ?"]
    values: list[Any] = [now_iso()]
    if status is not None:
        fields.append("status = ?")
        values.append(status)
    if progress is not None:
        fields.append("progress = ?")
        values.append(progress)
    if error is not None:
        fields.append("error = ?")
        values.append(error)
    if output is not None:
        fields.append("output = ?")
        values.append(dumps(output))
    values.append(job_id)
    with connect() as con:
        con.execute(f"update jobs set {', '.join(fields)} where id = ?", values)


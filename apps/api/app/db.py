import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .config import DB_PATH, STORAGE_DIR

SCHEMA_LOCK = threading.Lock()

SCHEMA_SQL = """
create table if not exists projects (
  id text primary key,
  name text not null,
  size_name text not null default '',
  dpi integer not null,
  unit text not null default 'px',
  canvas_width integer not null default 0,
  canvas_height integer not null default 0,
  export_config text not null default '{}',
  created_at text not null,
  updated_at text not null
);

create table if not exists assets (
  id text primary key,
  project_id text not null,
  kind text not null,
  filename text not null,
  path text not null,
  width integer not null default 0,
  height integer not null default 0,
  sha256 text not null,
  metadata text not null default '{}',
  created_at text not null,
  foreign key(project_id) references projects(id)
);

create table if not exists pieces (
  id text primary key,
  project_id text not null,
  name text not null,
  mask_path text not null,
  polygon text not null,
  bbox text not null,
  source_x integer not null,
  source_y integer not null,
  width integer not null,
  height integer not null,
  area integer not null,
  centroid_x real not null,
  centroid_y real not null,
  group_name text not null default '',
  mirror_of text not null default '',
  transform text not null,
  created_at text not null,
  updated_at text not null,
  foreign key(project_id) references projects(id)
);

create table if not exists textures (
  id text primary key,
  project_id text not null,
  source_type text not null,
  source_path text not null,
  seamless_path text not null default '',
  prompt text not null default '',
  provider text not null default 'local',
  model text not null default 'local',
  seed text not null default '',
  version integer not null default 1,
  width integer not null default 0,
  height integer not null default 0,
  created_at text not null,
  foreign key(project_id) references projects(id)
);

create table if not exists jobs (
  id text primary key,
  project_id text not null,
  job_type text not null,
  status text not null,
  progress real not null default 0,
  error text not null default '',
  input text not null default '{}',
  output text not null default '{}',
  created_at text not null,
  updated_at text not null
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def loads(value: str | None, default: Any = None) -> Any:
    if value is None:
        return default
    return json.loads(value)


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    ensure_schema()
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    try:
        yield con
        con.commit()
    finally:
        con.close()


def init_db() -> None:
    ensure_schema()


def ensure_schema() -> None:
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    with SCHEMA_LOCK:
        con = sqlite3.connect(DB_PATH)
        try:
            con.executescript(SCHEMA_SQL)
            con.commit()
        finally:
            con.close()


def row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def rel_path(path: Path) -> str:
    return str(path.relative_to(STORAGE_DIR))


def storage_path(relative: str) -> Path:
    return STORAGE_DIR / relative

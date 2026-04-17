import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .config import DB_PATH, STORAGE_DIR

SCHEMA_LOCK = threading.Lock()
SCHEMA_READY = False

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
  design_canvas_path text not null default '',
  fit_source_recommendation text not null default 'source',
  fit_source text not null default 'source',
  seamless_mode text not null default '',
  analysis text not null default '{}',
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

create table if not exists template_sets (
  id text primary key,
  name text not null,
  garment_type text not null default 'unknown',
  version_label text not null default '',
  description text not null default '',
  base_size_template_id text not null default '',
  design_canvas text not null default '{}',
  mapping_confirmed_at text not null default '',
  created_at text not null,
  updated_at text not null
);

create table if not exists set_piece_defs (
  id text primary key,
  set_id text not null,
  piece_role text not null default 'unknown',
  name text not null,
  sort_order integer not null default 0,
  base_transform text not null default '{}',
  created_at text not null,
  updated_at text not null,
  foreign key(set_id) references template_sets(id)
);

create table if not exists size_templates (
  id text primary key,
  set_id text not null,
  size_name text not null,
  asset_id text not null,
  template_source text not null,
  template_path text not null,
  red_marker_path text not null default '',
  red_marker_count integer not null default 0,
  width integer not null default 0,
  height integer not null default 0,
  pieces_count integer not null default 0,
  is_base boolean not null default false,
  created_at text not null,
  updated_at text not null,
  foreign key(set_id) references template_sets(id)
);

create table if not exists size_template_pieces (
  id text primary key,
  size_template_id text not null,
  piece_def_id text not null default '',
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
  scale_to_base real not null default 1.0,
  transform text not null default '{}',
  created_at text not null,
  updated_at text not null,
  foreign key(size_template_id) references size_templates(id)
);

create table if not exists fabric_prompts (
  id text primary key,
  code text not null unique,
  name text not null,
  scenarios text not null,
  prompt text not null,
  category text not null default '面料',
  sort_order integer not null default 0,
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
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    ensure_schema()
    con = open_connection()
    try:
        yield con
        con.commit()
    finally:
        con.close()


def init_db() -> None:
    ensure_schema()


def ensure_schema() -> None:
    global SCHEMA_READY
    if SCHEMA_READY:
        return
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    with SCHEMA_LOCK:
        if SCHEMA_READY:
            return
        con = open_connection()
        try:
            con.executescript(SCHEMA_SQL)
            ensure_system_project(con)
            ensure_projects_template_set_id_column(con)
            ensure_asset_columns(con)
            ensure_texture_columns(con)
            ensure_template_set_columns(con)
            ensure_size_template_pieces_columns(con)
            ensure_fabric_prompts_columns(con)
            ensure_fabric_prompts_data(con)
            con.commit()
            SCHEMA_READY = True
        finally:
            con.close()


def open_connection() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    configure_connection(con)
    return con


def configure_connection(con: sqlite3.Connection) -> None:
    con.execute("pragma journal_mode=WAL")
    con.execute("pragma synchronous=NORMAL")
    con.execute("pragma busy_timeout=5000")
    con.execute("pragma foreign_keys=ON")


def ensure_system_project(con: sqlite3.Connection) -> None:
    current = now_iso()
    con.execute(
        """
        insert or ignore into projects(id, name, size_name, dpi, unit, canvas_width, canvas_height, export_config, created_at, updated_at)
        values ('', '模板套装素材', '', 300, 'px', 0, 0, '{}', ?, ?)
        """,
        (current, current),
    )


_FABRIC_PROMPTS_PATH = Path(__file__).parent / "init_data" / "fabric_prompts.json"
FABRIC_PROMPTS_DATA: list[dict[str, Any]] = []
if _FABRIC_PROMPTS_PATH.exists():
    with open(_FABRIC_PROMPTS_PATH, "r", encoding="utf-8") as _fp:
        FABRIC_PROMPTS_DATA = json.load(_fp)


def ensure_projects_template_set_id_column(con: sqlite3.Connection) -> None:
    columns = {row[1] for row in con.execute("pragma table_info(projects)").fetchall()}
    if "template_set_id" not in columns:
        con.execute("alter table projects add column template_set_id text not null default ''")


def ensure_fabric_prompts_columns(con: sqlite3.Connection) -> None:
    columns = {row[1] for row in con.execute("pragma table_info(fabric_prompts)").fetchall()}
    if "category" not in columns:
        con.execute("alter table fabric_prompts add column category text not null default '面料'")
        con.execute("update fabric_prompts set category = '面料' where category = '' or category is null")


def ensure_fabric_prompts_data(con: sqlite3.Connection) -> None:
    current = now_iso()
    for idx, item in enumerate(FABRIC_PROMPTS_DATA, start=1):
        con.execute(
            """
            insert into fabric_prompts(id, code, name, scenarios, prompt, category, sort_order, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(id) do update set
              code=excluded.code,
              name=excluded.name,
              scenarios=excluded.scenarios,
              prompt=excluded.prompt,
              category=excluded.category,
              sort_order=excluded.sort_order,
              updated_at=excluded.updated_at
            """,
            (
                item["id"],
                item["code"],
                item["name"],
                item["scenarios"],
                item["prompt"],
                item.get("category", "面料"),
                idx,
                current,
                current,
            ),
        )


def ensure_asset_columns(con: sqlite3.Connection) -> None:
    columns = {row[1] for row in con.execute("pragma table_info(assets)").fetchall()}
    if "thumb_path" not in columns:
        con.execute("alter table assets add column thumb_path text not null default ''")


def ensure_texture_columns(con: sqlite3.Connection) -> None:
    columns = {row[1] for row in con.execute("pragma table_info(textures)").fetchall()}
    additions = {
        "design_canvas_path": "text not null default ''",
        "fit_source_recommendation": "text not null default 'source'",
        "fit_source": "text not null default 'source'",
        "seamless_mode": "text not null default ''",
        "analysis": "text not null default '{}'",
        "source_thumb_path": "text not null default ''",
        "seamless_thumb_path": "text not null default ''",
        "design_canvas_thumb_path": "text not null default ''",
    }
    for name, definition in additions.items():
        if name not in columns:
            con.execute(f"alter table textures add column {name} {definition}")


def ensure_template_set_columns(con: sqlite3.Connection) -> None:
    columns = {row[1] for row in con.execute("pragma table_info(template_sets)").fetchall()}
    if "mapping_confirmed_at" not in columns:
        con.execute("alter table template_sets add column mapping_confirmed_at text not null default ''")


def ensure_size_template_pieces_columns(con: sqlite3.Connection) -> None:
    columns = {row[1] for row in con.execute("pragma table_info(size_template_pieces)").fetchall()}
    if "transform" not in columns:
        con.execute("alter table size_template_pieces add column transform text not null default '{}'")
    migrate_size_template_pieces_fk(con)


def migrate_size_template_pieces_fk(con: sqlite3.Connection) -> None:
    """移除 size_template_pieces 对 set_piece_defs 的外键约束，允许 piece_def_id 为空。"""
    fks = con.execute("pragma foreign_key_list(size_template_pieces)").fetchall()
    has_def_fk = any(row["table"] == "set_piece_defs" for row in fks)
    if not has_def_fk:
        return
    con.execute("alter table size_template_pieces rename to size_template_pieces_old")
    con.executescript("""
    create table size_template_pieces (
      id text primary key,
      size_template_id text not null,
      piece_def_id text not null default '',
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
      scale_to_base real not null default 1.0,
      transform text not null default '{}',
      created_at text not null,
      updated_at text not null,
      foreign key(size_template_id) references size_templates(id)
    );
    insert into size_template_pieces select * from size_template_pieces_old;
    drop table size_template_pieces_old;
    """)


def row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def rel_path(path: Path) -> str:
    return str(path.relative_to(STORAGE_DIR))


def storage_path(relative: str) -> Path:
    return STORAGE_DIR / relative

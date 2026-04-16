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
            ensure_texture_columns(con)
            ensure_template_set_columns(con)
            ensure_size_template_pieces_columns(con)
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


FABRIC_PROMPTS_DATA = [
    {
        "id": "fp-01",
        "code": "01",
        "name": "高端梭织面料纹理",
        "scenarios": "西装、衬衫、套装、商务面料、成衣基础纹理",
        "prompt": "生成一张专业服装面料背景图。\n以【参数1：纹理主体 例如：细斜纹羊毛】为核心，\n体现【参数2：工艺与视觉风格 例如：高端成衣】的高级感，\n整体色彩采用【参数3：色彩气质 例如：深灰黑+冷银】。\n\n要求呈现真实梭织纤维组织、\n细密经纬结构、\n自然光下的微弱层次变化，\n可用于高端服装面料开发参考。\n\n画面具有完整平铺逻辑，四边自然衔接，可连续扩展。\n呈现纯面料纹理 / 图案背景，构图干净，细节稳定。\n高细节，纹理清晰，纤维层次丰富，专业面料质感，适合服装印花、贴图、裁片铺图。",
    },
    {
        "id": "fp-02",
        "code": "02",
        "name": "针织肌理",
        "scenarios": "毛衣、卫衣、针织衫、秋冬面料、弹力纹理",
        "prompt": "生成一张专业针织类服装纹理背景图。\n以【参数1：纹理主体 例如：柔软针织罗纹】为核心，\n表现【参数2：工艺与视觉风格 例如：日系极简】的针织质感，\n整体色彩采用【参数3：色彩气质 例如：奶油白+浅米色】。\n\n要求看到细微线圈感、\n针路规律、\n柔软弹性、\n轻微蓬松纤维触感，\n整体适合服装面料开发与数字贴图。\n\n画面适合连续平铺扩展，边缘过渡自然。\n呈现纯针织纹理背景，纹理清晰，层次丰富，适合大面积应用。",
    },
    {
        "id": "fp-03",
        "code": "03",
        "name": "提花 / 织纹图案",
        "scenarios": "女装提花、轻奢面料、礼服、窗帘布、家纺联动",
        "prompt": "生成一张高端提花面料图案背景。\n以【参数1：纹理主体 例如：花卉提花】为主要视觉元素，\n风格偏向【参数2：工艺与视觉风格 例如：轻奢女装】，\n配色采用【参数3：色彩气质 例如：酒红+金棕】。\n\n要求图案与织纹一体化，\n更接近真实织造形成的层次纹理，\n具有微浮雕感、\n经纬变化、\n细腻光泽与连续重复节奏。\n\n画面适合连续延展，纹理细节完整。\n呈现提花 / 织纹背景，高细节，层次丰富，适合服装与家纺花型开发。",
    },
    {
        "id": "fp-04",
        "code": "04",
        "name": "数码印花花卉",
        "scenarios": "女装连衣裙、衬衫、半裙、丝巾、春夏印花",
        "prompt": "生成一张适合服装数码印花的面料背景。\n以【参数1：纹理主体 例如：热带花卉印花】为主题花型或植物元素，\n融入【参数2：工艺与视觉风格 例如：度假时装】的审美特征，\n色彩采用【参数3：色彩气质 例如：珊瑚粉+橄榄绿+米白】。\n\n要求图案密度适中，\n重复节奏自然，\n既有设计感，\n又适合大面积连续印花。\n\n边缘过渡自然，整体延展性好。\n呈现花卉印花面料背景，高细节，图案清晰，适合印花开发与服装贴图。",
    },
    {
        "id": "fp-05",
        "code": "05",
        "name": "几何重复纹样",
        "scenarios": "男装衬衫、运动面料、童装、品牌辅料、科技感图案",
        "prompt": "生成一张专业几何类服装面料图案背景。\n以【参数1：纹理主体 例如：微几何重复网格】为主要构成语言，\n体现【参数2：工艺与视觉风格 例如：运动科技】的秩序感与设计感，\n整体配色采用【参数3：色彩气质 例如：黑灰+荧光绿】。\n\n要求图案重复节奏精确，\n结构干净，\n适合连续平铺，\n兼具现代审美与服装应用价值。\n\n画面边界稳定，重复逻辑清晰。\n呈现几何面料背景，高细节，适合服装与辅料设计。",
    },
    {
        "id": "fp-06",
        "code": "06",
        "name": "牛仔 / 水洗 / 做旧肌理",
        "scenarios": "牛仔服、工装、复古休闲、街头风、磨毛面料",
        "prompt": "生成一张服装材质类背景图。\n以【参数1：纹理主体 例如：牛仔磨白颗粒】为基础材质，\n风格体现【参数2：工艺与视觉风格 例如：复古做旧】，\n配色采用【参数3：色彩气质 例如：靛蓝+灰白】。\n\n要求表现真实布面颗粒、\n旧化层次、\n轻微磨白感、\n洗水过渡、\n纤维细节。\n\n整体保持专业面料贴图感。\n画面适合连续扩展，纹理自然，材质真实，适合牛仔与工装面料开发。",
    },
    {
        "id": "fp-07",
        "code": "07",
        "name": "真丝 / 缎面 / 光泽面料",
        "scenarios": "礼服、真丝衬衫、睡衣、轻奢家居、舞台服饰",
        "prompt": "生成一张高端光泽类服装面料背景。\n以【参数1：纹理主体 例如：真丝缎面波纹】为基础，\n结合【参数2：工艺与视觉风格 例如：奢牌秀场】的审美方向，\n整体色彩采用【参数3：色彩气质 例如：宝石蓝+黑】。\n\n要求有真实丝缎表面反光、\n柔顺流动感、\n细腻高光与暗部过渡。\n\n画面保持纯面料背景表达，\n适合连续扩展。\n高细节，光泽自然，层次细腻，适合礼服与高端女装开发。",
    },
    {
        "id": "fp-08",
        "code": "08",
        "name": "亚麻 / 棉麻 / 自然纤维",
        "scenarios": "家居服、文艺女装、童装、家纺、自然风品牌",
        "prompt": "生成一张自然纤维感的服装面料背景。\n以【参数1：纹理主体 例如：亚麻竹节肌理】为主要材质特征，\n体现【参数2：工艺与视觉风格 例如：北欧自然】的自然与高级感，\n整体色彩采用【参数3：色彩气质 例如：燕麦色+浅卡其】。\n\n要求可见棉麻纤维、\n竹节、\n自然不规则细节、\n柔和颗粒感和透气质感，\n整体审美干净克制。\n\n画面适合连续平铺与扩展。\n高细节，纹理自然，纤维感明确，适合家居与自然系服装开发。",
    },
    {
        "id": "fp-09",
        "code": "09",
        "name": "科技机能纹理",
        "scenarios": "运动服、冲锋衣、羽绒服面料、未来感品牌、数码服饰",
        "prompt": "生成一张科技机能风服装纹理背景。\n以【参数1：纹理主体 例如：微科技织纹】为主要图案基础，\n融合【参数2：工艺与视觉风格 例如：未来数字感】的未来感与功能性，\n整体配色采用【参数3：色彩气质 例如：黑灰银+冷蓝】。\n\n要求具有微科技织纹、\n功能面料颗粒、\n细密网格、\n压纹或热压感。\n\n整体专业、克制，\n适合运动与机能服饰。\n高细节，纹理清晰，科技感强，适合机能服饰与数码主题面料开发。",
    },
    {
        "id": "fp-10",
        "code": "10",
        "name": "抽象艺术面料图案",
        "scenarios": "设计师品牌、时装秀款、先锋女装、围巾、视觉冲击型印花",
        "prompt": "生成一张具有时装设计感的抽象服装面料图案背景。\n以【参数1：纹理主体 例如：抽象流体颗粒纹】作为抽象视觉母题，\n风格偏向【参数2：工艺与视觉风格 例如：未来数字感】，\n色彩采用【参数3：色彩气质 例如：冷白+冰蓝+银灰】。\n\n要求既有艺术表现力，\n又保留专业服装印花的可用性。\n\n图案节奏均衡，\n层次丰富，\n适合大面积铺陈。\n\n画面适合连续扩展，整体气质干净、现代、精致。\n高细节，纹理清晰，颗粒层次丰富，具有未来数字感与时装设计感，适合设计师品牌印花开发。",
    },
]


def ensure_fabric_prompts_data(con: sqlite3.Connection) -> None:
    current = now_iso()
    for idx, item in enumerate(FABRIC_PROMPTS_DATA, start=1):
        con.execute(
            """
            insert or ignore into fabric_prompts(id, code, name, scenarios, prompt, sort_order, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item["id"],
                item["code"],
                item["name"],
                item["scenarios"],
                item["prompt"],
                idx,
                current,
                current,
            ),
        )


def ensure_texture_columns(con: sqlite3.Connection) -> None:
    columns = {row[1] for row in con.execute("pragma table_info(textures)").fetchall()}
    additions = {
        "design_canvas_path": "text not null default ''",
        "fit_source_recommendation": "text not null default 'source'",
        "fit_source": "text not null default 'source'",
        "seamless_mode": "text not null default ''",
        "analysis": "text not null default '{}'",
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

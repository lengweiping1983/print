from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[3]
STORAGE_DIR = ROOT_DIR / "storage"
PROJECTS_DIR = STORAGE_DIR / "projects"
DB_PATH = STORAGE_DIR / "print_studio.sqlite3"

DEFAULT_DPI = 300
MIN_COMPONENT_AREA = 1000


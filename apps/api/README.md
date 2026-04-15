# Print Studio API

FastAPI backend for the garment piece texture workflow.

## Run

```bash
cd apps/api
python3 -m uvicorn app.main:app --reload --port 8000
```

The first version stores data in `storage/print_studio.sqlite3` and files under
`storage/projects/{project_id}`. Redis, Celery, S3 and MinIO are intentionally
not required.


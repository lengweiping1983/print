from io import BytesIO
import time

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app.main import app


def test_preview_creates_default_texture_when_none_exists() -> None:
    client = TestClient(app)
    with client:
        project = client.post("/api/projects", json={"name": "preview fallback"}).json()
        mask = Image.new("RGBA", (140, 90), (0, 0, 0, 0))
        draw = ImageDraw.Draw(mask)
        draw.rectangle((10, 10, 70, 70), fill=(255, 255, 255, 255))
        buf = BytesIO()
        mask.save(buf, format="PNG")
        buf.seek(0)
        asset = client.post(
            f"/api/projects/{project['id']}/assets",
            data={"kind": "template"},
            files={"file": ("mask.png", buf, "image/png")},
        ).json()
        client.post(f"/api/projects/{project['id']}/templates/import", data={"asset_id": asset["id"]})

        job_id = client.post(f"/api/projects/{project['id']}/render/preview", data={"texture_id": ""}).json()["job_id"]
        job = wait_job(client, job_id)

        assert job["status"] == "succeeded"
        assert job["output"]["preview_url"].endswith("preview.png")


def wait_job(client: TestClient, job_id: str) -> dict:
    for _ in range(20):
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in {"succeeded", "failed"}:
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


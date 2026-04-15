from io import BytesIO
import time

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app.db import storage_path
from app.image_ops import marker_path_for_mask
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


def test_jpeg_layout_image_import_creates_piece_masks() -> None:
    client = TestClient(app)
    with client:
        project = client.post("/api/projects", json={"name": "jpeg layout"}).json()
        layout = Image.new("RGB", (240, 140), (255, 255, 255))
        draw = ImageDraw.Draw(layout)
        draw.rectangle((12, 12, 102, 120), fill=(18, 42, 104))
        draw.rectangle((44, 18, 58, 22), fill=(238, 0, 40))
        draw.rectangle((142, 24, 222, 112), fill=(18, 42, 104))
        buf = BytesIO()
        layout.save(buf, format="JPEG", quality=95)
        buf.seek(0)

        asset = client.post(
            f"/api/projects/{project['id']}/assets",
            data={"kind": "template"},
            files={"file": ("layout.jpg", buf, "image/jpeg")},
        ).json()
        imported = client.post(f"/api/projects/{project['id']}/templates/import", data={"asset_id": asset["id"]}).json()

        assert imported["template_source"] == "layout_image"
        assert imported["template_path"].endswith("_template.png")
        assert len(imported["pieces"]) == 2
        for piece in imported["pieces"]:
            assert storage_path(piece["mask_path"]).exists()
        marker_paths = [marker_path_for_mask(storage_path(piece["mask_path"])) for piece in imported["pieces"]]
        assert any(path.exists() for path in marker_paths)


def wait_job(client: TestClient, job_id: str) -> dict:
    for _ in range(80):
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in {"succeeded", "failed"}:
            return job
        time.sleep(0.1)
    raise AssertionError("job did not finish")


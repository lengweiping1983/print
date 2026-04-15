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
        import_template(client, project["id"], asset["id"])

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
        imported = import_template(client, project["id"], asset["id"])

        assert imported["template_source"] == "layout_image"
        assert imported["template_path"].endswith("_template.png")
        assert len(imported["pieces"]) == 2
        assert imported["design_canvas"]["width"] > 0
        assert all(piece["transform"]["mode"] == "global_canvas" for piece in imported["pieces"])
        for piece in imported["pieces"]:
            assert storage_path(piece["mask_path"]).exists()
        marker_paths = [marker_path_for_mask(storage_path(piece["mask_path"])) for piece in imported["pieces"]]
        assert any(path.exists() for path in marker_paths)


def test_global_fit_updates_piece_transforms_and_preview() -> None:
    client = TestClient(app)
    with client:
        project = client.post("/api/projects", json={"name": "global fit"}).json()
        mask = Image.new("RGBA", (220, 120), (0, 0, 0, 0))
        draw = ImageDraw.Draw(mask)
        draw.rectangle((10, 12, 90, 110), fill=(255, 255, 255, 255))
        draw.rectangle((120, 12, 200, 110), fill=(255, 255, 255, 255))
        template_buf = BytesIO()
        mask.save(template_buf, format="PNG")
        template_buf.seek(0)
        template = client.post(
            f"/api/projects/{project['id']}/assets",
            data={"kind": "template"},
            files={"file": ("template.png", template_buf, "image/png")},
        ).json()
        imported = import_template(client, project["id"], template["id"])
        assert len(imported["pieces"]) == 2

        texture = Image.new("RGBA", (64, 64), (24, 96, 180, 255))
        texture_buf = BytesIO()
        texture.save(texture_buf, format="PNG")
        texture_buf.seek(0)
        asset = client.post(
            f"/api/projects/{project['id']}/assets",
            data={"kind": "pattern"},
            files={"file": ("water.png", texture_buf, "image/png")},
        ).json()
        texture_job = client.post(
            f"/api/projects/{project['id']}/textures/generate",
            json={"source_asset_id": asset["id"], "source_type": "pattern", "provider": "local", "model": "local-copy"},
        ).json()["job_id"]
        texture_done = wait_job(client, texture_job)
        texture_id = texture_done["output"]["texture"]["id"]

        fit_job = client.post(
            f"/api/projects/{project['id']}/textures/{texture_id}/fit-global",
            json={"garment_type": "shirt", "texture_scale": 1, "texture_angle": 15, "symmetry": "continuous"},
        ).json()["job_id"]
        fit_done = wait_job(client, fit_job)

        assert fit_done["status"] == "succeeded"
        assert fit_done["output"]["fit_preview_url"].endswith(".png")
        pieces = client.get(f"/api/projects/{project['id']}/pieces").json()
        assert all(piece["transform"]["mode"] == "global_canvas" for piece in pieces)
        assert all(piece["transform"]["design_width"] > 0 for piece in pieces)
        assert all(piece["transform"]["safe_zones"] for piece in pieces)
        assert all(piece["transform"]["avoid_zones"] for piece in pieces)


def test_texture_generation_recommends_source_for_transparent_logo() -> None:
    client = TestClient(app)
    with client:
        project = client.post("/api/projects", json={"name": "logo source"}).json()
        logo = Image.new("RGBA", (96, 96), (255, 255, 255, 0))
        ImageDraw.Draw(logo).ellipse((18, 18, 78, 78), fill=(250, 20, 20, 255))
        buf = BytesIO()
        logo.save(buf, format="PNG")
        buf.seek(0)
        asset = client.post(
            f"/api/projects/{project['id']}/assets",
            data={"kind": "pattern"},
            files={"file": ("logo.png", buf, "image/png")},
        ).json()
        texture_job = client.post(
            f"/api/projects/{project['id']}/textures/generate",
            json={"source_asset_id": asset["id"], "source_type": "pattern", "prompt": "胸前 logo", "provider": "local", "model": "local-copy"},
        ).json()["job_id"]
        texture = wait_job(client, texture_job)["output"]["texture"]

        assert texture["fit_source_recommendation"] == "source"
        assert texture["fit_source"] == "source"
        assert texture["seamless_path"] == ""
        assert texture["analysis"]["recommendation"] == "source"


def test_texture_generation_auto_creates_seamless_for_water_pattern() -> None:
    client = TestClient(app)
    with client:
        project = client.post("/api/projects", json={"name": "water seamless"}).json()
        texture_img = Image.new("RGBA", (64, 64), (24, 128, 220, 255))
        draw = ImageDraw.Draw(texture_img)
        for y in range(0, 64, 8):
            draw.line((0, y, 64, y + 6), fill=(220, 245, 255, 255), width=2)
        buf = BytesIO()
        texture_img.save(buf, format="PNG")
        buf.seek(0)
        asset = client.post(
            f"/api/projects/{project['id']}/assets",
            data={"kind": "pattern"},
            files={"file": ("water.png", buf, "image/png")},
        ).json()
        texture_job = client.post(
            f"/api/projects/{project['id']}/textures/generate",
            json={"source_asset_id": asset["id"], "source_type": "pattern", "prompt": "水纹满版纹理", "provider": "local", "model": "local-copy"},
        ).json()["job_id"]
        texture = wait_job(client, texture_job)["output"]["texture"]

        assert texture["fit_source_recommendation"] == "seamless"
        assert texture["fit_source"] == "seamless"
        assert texture["seamless_mode"] == "mirror"
        assert texture["seamless_path"].endswith("_seamless.png")
        assert storage_path(texture["seamless_path"]).exists()


def test_global_fit_texture_source_selection_and_fallback() -> None:
    client = TestClient(app)
    with client:
        project = client.post("/api/projects", json={"name": "fit source selection"}).json()
        mask = Image.new("RGBA", (120, 90), (0, 0, 0, 0))
        ImageDraw.Draw(mask).rectangle((10, 10, 80, 70), fill=(255, 255, 255, 255))
        mask_buf = BytesIO()
        mask.save(mask_buf, format="PNG")
        mask_buf.seek(0)
        template = client.post(
            f"/api/projects/{project['id']}/assets",
            data={"kind": "template"},
            files={"file": ("template.png", mask_buf, "image/png")},
        ).json()
        import_template(client, project["id"], template["id"])

        logo = Image.new("RGBA", (80, 80), (255, 255, 255, 0))
        ImageDraw.Draw(logo).rectangle((20, 20, 60, 60), fill=(20, 20, 20, 255))
        logo_buf = BytesIO()
        logo.save(logo_buf, format="PNG")
        logo_buf.seek(0)
        logo_asset = client.post(
            f"/api/projects/{project['id']}/assets",
            data={"kind": "pattern"},
            files={"file": ("logo.png", logo_buf, "image/png")},
        ).json()
        logo_job = client.post(
            f"/api/projects/{project['id']}/textures/generate",
            json={"source_asset_id": logo_asset["id"], "source_type": "pattern", "prompt": "logo", "provider": "local", "model": "local-copy"},
        ).json()["job_id"]
        logo_texture = wait_job(client, logo_job)["output"]["texture"]
        fallback_job = client.post(
            f"/api/projects/{project['id']}/textures/{logo_texture['id']}/fit-global",
            json={"texture_source": "seamless", "texture_scale": 1, "texture_angle": 0},
        ).json()["job_id"]
        fallback = wait_job(client, fallback_job)
        assert fallback["output"]["texture"]["fit_source"] == "source"
        assert any("回退为原图" in warning for warning in fallback["output"]["warnings"])

        water = Image.new("RGBA", (64, 64), (24, 128, 220, 255))
        water_buf = BytesIO()
        water.save(water_buf, format="PNG")
        water_buf.seek(0)
        water_asset = client.post(
            f"/api/projects/{project['id']}/assets",
            data={"kind": "pattern"},
            files={"file": ("water.png", water_buf, "image/png")},
        ).json()
        water_job = client.post(
            f"/api/projects/{project['id']}/textures/generate",
            json={"source_asset_id": water_asset["id"], "source_type": "pattern", "prompt": "水纹满版纹理", "provider": "local", "model": "local-copy"},
        ).json()["job_id"]
        water_texture = wait_job(client, water_job)["output"]["texture"]
        fit_job = client.post(
            f"/api/projects/{project['id']}/textures/{water_texture['id']}/fit-global",
            json={"texture_source": "seamless", "texture_scale": 1, "texture_angle": 0},
        ).json()["job_id"]
        fit = wait_job(client, fit_job)
        assert fit["output"]["texture"]["fit_source"] == "seamless"
        assert fit["output"]["texture"]["seamless_path"].endswith("_seamless.png")
        assert fit["output"]["texture"]["design_canvas_path"].endswith("_design_canvas.png")


def test_design_canvas_layers_safety_and_export_manifest() -> None:
    client = TestClient(app)
    with client:
        project = client.post("/api/projects", json={"name": "design layers"}).json()
        mask = Image.new("RGBA", (180, 120), (0, 0, 0, 0))
        draw = ImageDraw.Draw(mask)
        draw.rectangle((10, 10, 100, 100), fill=(255, 255, 255, 255))
        template_buf = BytesIO()
        mask.save(template_buf, format="PNG")
        template_buf.seek(0)
        template = client.post(
            f"/api/projects/{project['id']}/assets",
            data={"kind": "template"},
            files={"file": ("template.png", template_buf, "image/png")},
        ).json()
        import_template(client, project["id"], template["id"])

        texture = Image.new("RGBA", (80, 80), (24, 96, 180, 255))
        texture_buf = BytesIO()
        texture.save(texture_buf, format="PNG")
        texture_buf.seek(0)
        texture_asset = client.post(
            f"/api/projects/{project['id']}/assets",
            data={"kind": "pattern"},
            files={"file": ("water.png", texture_buf, "image/png")},
        ).json()
        logo = Image.new("RGBA", (32, 32), (255, 255, 255, 0))
        ImageDraw.Draw(logo).rectangle((4, 4, 28, 28), fill=(255, 0, 0, 255))
        logo_buf = BytesIO()
        logo.save(logo_buf, format="PNG")
        logo_buf.seek(0)
        logo_asset = client.post(
            f"/api/projects/{project['id']}/assets",
            data={"kind": "pattern"},
            files={"file": ("logo.png", logo_buf, "image/png")},
        ).json()

        texture_job = client.post(
            f"/api/projects/{project['id']}/textures/generate",
            json={"source_asset_id": texture_asset["id"], "source_type": "pattern", "provider": "local", "model": "local-copy"},
        ).json()["job_id"]
        texture_id = wait_job(client, texture_job)["output"]["texture"]["id"]
        fit_job = client.post(
            f"/api/projects/{project['id']}/textures/{texture_id}/fit-global",
            json={"garment_type": "shirt", "texture_scale": 1, "texture_angle": 0, "symmetry": "continuous"},
        ).json()["job_id"]
        wait_job(client, fit_job)

        piece = client.get(f"/api/projects/{project['id']}/pieces").json()[0]
        transform = piece["transform"]
        transform["piece_role"] = "front_left"
        transform["role_confirmed"] = True
        saved_piece = client.patch(f"/api/projects/{project['id']}/pieces/{piece['id']}", json=transform).json()
        dx = saved_piece["transform"]["design_x"]
        dy = saved_piece["transform"]["design_y"]
        role = saved_piece["transform"]["piece_role"]
        layers = [
            {
                "id": "layer_ok",
                "type": "image",
                "name": "安全 logo",
                "visible": True,
                "locked": False,
                "anchor": "front_center",
                "x": dx + 24,
                "y": dy + 24,
                "width": 20,
                "height": 20,
                "rotation": 0,
                "opacity": 1,
                "target_roles": [role],
                "asset_id": logo_asset["id"],
                "source_url": logo_asset["url"],
            },
            {
                "id": "layer_warn",
                "type": "text",
                "name": "压线文字",
                "visible": True,
                "locked": False,
                "anchor": "front_center",
                "x": dx,
                "y": dy,
                "width": 80,
                "height": 40,
                "rotation": 0,
                "opacity": 1,
                "target_roles": [role],
                "content": "23",
                "font_size": 28,
                "font_weight": "700",
                "fill": "#ffffff",
                "stroke": "#111111",
                "stroke_width": 2,
            },
        ]
        patched = client.patch(f"/api/projects/{project['id']}/design-canvas", json={"design_canvas": {"layers": layers}}).json()
        assert len(patched["design_canvas"]["layers"]) == 2

        render_job = client.post(f"/api/projects/{project['id']}/textures/{texture_id}/design-canvas/render").json()["job_id"]
        rendered = wait_job(client, render_job)
        assert rendered["status"] == "succeeded"
        assert rendered["output"]["design_canvas_url"].endswith(".png")
        report = rendered["output"]["safety_report"]
        assert any(item["level"] == "ok" for item in report)
        assert any(item["level"] == "warning" for item in report)
        after_piece = client.get(f"/api/projects/{project['id']}/pieces").json()[0]
        assert after_piece["transform"]["piece_role"] == "front_left"
        assert after_piece["transform"]["role_confirmed"] is True

        export_job = client.post(f"/api/projects/{project['id']}/exports", json={"format": "zip"}).json()["job_id"]
        exported = wait_job(client, export_job)
        manifest = exported["output"]["manifest"]
        assert len(manifest["design_canvas"]["layers"]) == 2
        assert manifest["safety_report"]


def wait_job(client: TestClient, job_id: str) -> dict:
    for _ in range(80):
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in {"succeeded", "failed"}:
            return job
        time.sleep(0.1)
    raise AssertionError("job did not finish")


def import_template(client: TestClient, project_id: str, asset_id: str) -> dict:
    created = client.post(f"/api/projects/{project_id}/templates/import", data={"asset_id": asset_id}).json()
    assert "job_id" in created
    done = wait_job(client, created["job_id"])
    assert done["status"] == "succeeded"
    return done["output"]

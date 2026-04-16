from io import BytesIO
import time

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
import pytest

from app.main import app


def test_template_set_full_workflow() -> None:
    client = TestClient(app)
    with client:
        # 1. POST /api/template-sets
        ts = client.post(
            "/api/template-sets",
            json={"name": "Test Set", "garment_type": "shirt", "version_label": "v1"},
        ).json()
        assert ts["name"] == "Test Set"
        assert ts["garment_type"] == "shirt"
        assert ts["version_label"] == "v1"
        assert ts["base_size_template_id"] == ""
        set_id = ts["id"]

        # 2. GET /api/template-sets and GET /api/template-sets/{set_id}
        list_resp = client.get("/api/template-sets").json()
        assert any(s["id"] == set_id for s in list_resp)

        get_resp = client.get(f"/api/template-sets/{set_id}").json()
        assert get_resp["id"] == set_id
        assert get_resp["design_canvas"] == {}

        # 3. POST /api/template-sets/{set_id}/assets
        base_buf = _make_rect_pair_image(scale=1.0)
        base_asset = client.post(
            f"/api/template-sets/{set_id}/assets",
            files={"file": ("base.png", base_buf, "image/png")},
        ).json()
        assert base_asset["project_id"] == ""
        assert base_asset["filename"] == "base.png"

        larger_buf = _make_rect_pair_image(scale=1.25)
        larger_asset = client.post(
            f"/api/template-sets/{set_id}/assets",
            files={"file": ("larger.png", larger_buf, "image/png")},
        ).json()

        # 4. POST /api/template-sets/{set_id}/sizes/import (first import -> base)
        base_import = client.post(
            f"/api/template-sets/{set_id}/sizes/import",
            data={"asset_id": base_asset["id"], "size_name": "S"},
        ).json()
        size_s = base_import["size_template"]
        assert size_s["is_base"] == True
        assert size_s["pieces_count"] == 2
        assert size_s["size_name"] == "S"
        assert len(base_import["pieces"]) == 2
        assert base_import["warnings"] == []

        ts_after = client.get(f"/api/template-sets/{set_id}").json()
        assert ts_after["base_size_template_id"] == size_s["id"]

        # 5. GET /api/template-sets/{set_id}/piece-defs
        piece_defs = client.get(f"/api/template-sets/{set_id}/piece-defs").json()
        assert len(piece_defs) == 2
        def0 = piece_defs[0]
        assert def0["set_id"] == set_id
        assert "base_transform" in def0

        # 6. POST /api/template-sets/{set_id}/sizes/import (second import -> auto-match)
        m_import = client.post(
            f"/api/template-sets/{set_id}/sizes/import",
            data={"asset_id": larger_asset["id"], "size_name": "M"},
        ).json()
        size_m = m_import["size_template"]
        assert size_m["is_base"] == False
        assert size_m["pieces_count"] == 2
        assert len(m_import["pieces"]) == 2

        m_pieces = m_import["pieces"]
        for p in m_pieces:
            assert p["scale_to_base"] > 1.0
            assert p["piece_def_id"] != ""

        # 7. PATCH /api/template-sets/{set_id}/piece-defs/{def_id}
        patched_def = client.patch(
            f"/api/template-sets/{set_id}/piece-defs/{def0['id']}",
            json={"name": "前片", "piece_role": "front_center"},
        ).json()
        assert patched_def["name"] == "前片"
        assert patched_def["piece_role"] == "front_center"

        # 8. GET /api/template-sets/{set_id}/sizes/{size_id}/pieces reflects updated role/name
        s_pieces = client.get(
            f"/api/template-sets/{set_id}/sizes/{size_s['id']}/pieces"
        ).json()
        assert len(s_pieces) == 2
        # The first piece def should be reflected on the corresponding size piece
        assert s_pieces[0]["piece_role"] == "front_center"
        assert s_pieces[0]["name"] == "前片"

        m_pieces_endpoint = client.get(
            f"/api/template-sets/{set_id}/sizes/{size_m['id']}/pieces"
        ).json()
        assert len(m_pieces_endpoint) == 2
        assert m_pieces_endpoint[0]["piece_role"] == "front_center"

        # 9. POST /api/projects/from-template-set with copy_design_from_base=true
        #    legacy design_width/height may remain, but rendering uses real piece size.
        project = client.post(
            "/api/projects/from-template-set",
            json={"set_id": set_id, "size_name": "M", "copy_design_from_base": True},
        ).json()
        assert project["name"] == "Test Set-M"
        assert project["size_name"] == "M"

        project_pieces = client.get(f"/api/projects/{project['id']}/pieces").json()
        assert len(project_pieces) == 2
        for pp in project_pieces:
            assert "transform" in pp
            # role should carry from piece-def
            assert pp["transform"]["piece_role"] in ("front_center", "unknown")

        for pp, stp in zip(project_pieces, m_pieces_endpoint):
            assert pp["width"] == stp["width"]
            assert pp["height"] == stp["height"]
            assert isinstance(pp["transform"]["design_x"], (int, float))
            assert isinstance(pp["transform"]["design_y"], (int, float))

        # 10. POST /api/template-sets/{set_id}/base-size
        switch = client.post(
            f"/api/template-sets/{set_id}/base-size",
            data={"size_template_id": size_m["id"]},
        ).json()
        assert switch["base_size_template_id"] == size_m["id"]

        sizes = client.get(f"/api/template-sets/{set_id}/sizes").json()
        base_sizes = [s for s in sizes if s["is_base"]]
        assert len(base_sizes) == 1
        assert base_sizes[0]["id"] == size_m["id"]


def test_template_set_delete_size_reassigns_base() -> None:
    client = TestClient(app)
    with client:
        ts = client.post(
            "/api/template-sets",
            json={"name": "Delete Test", "garment_type": "t_shirt", "version_label": "v1"},
        ).json()
        set_id = ts["id"]

        buf_s = _make_rect_pair_image(scale=1.0)
        asset_s = client.post(
            f"/api/template-sets/{set_id}/assets",
            files={"file": ("s.png", buf_s, "image/png")},
        ).json()

        buf_m = _make_rect_pair_image(scale=1.1)
        asset_m = client.post(
            f"/api/template-sets/{set_id}/assets",
            files={"file": ("m.png", buf_m, "image/png")},
        ).json()

        import_s = client.post(
            f"/api/template-sets/{set_id}/sizes/import",
            data={"asset_id": asset_s["id"], "size_name": "S"},
        ).json()
        size_s_id = import_s["size_template"]["id"]

        import_m = client.post(
            f"/api/template-sets/{set_id}/sizes/import",
            data={"asset_id": asset_m["id"], "size_name": "M"},
        ).json()
        size_m_id = import_m["size_template"]["id"]

        # DELETE /api/template-sets/{set_id}/sizes/{size_id}
        del_resp = client.delete(f"/api/template-sets/{set_id}/sizes/{size_s_id}").json()
        assert del_resp["deleted"] == size_s_id

        ts_after = client.get(f"/api/template-sets/{set_id}").json()
        assert ts_after["base_size_template_id"] == size_m_id

        sizes = client.get(f"/api/template-sets/{set_id}/sizes").json()
        assert any(s["id"] == size_m_id and s["is_base"] for s in sizes)
        assert not any(s["id"] == size_s_id for s in sizes)


@pytest.mark.parametrize(
    ("mirror_x", "mirror_y"),
    [(False, False), (True, False), (False, True), (True, True)],
)
def test_template_set_linked_piece_creates_project_mirror_relation(mirror_x: bool, mirror_y: bool) -> None:
    client = TestClient(app)
    with client:
        ts = client.post(
            "/api/template-sets",
            json={"name": "Linked Pieces", "garment_type": "shirt", "version_label": "v1"},
        ).json()
        set_id = ts["id"]
        asset = client.post(
            f"/api/template-sets/{set_id}/assets",
            files={"file": ("base.png", _make_rect_pair_image(), "image/png")},
        ).json()
        client.post(
            f"/api/template-sets/{set_id}/sizes/import",
            data={"asset_id": asset["id"], "size_name": "S"},
        ).json()
        piece_defs = client.get(f"/api/template-sets/{set_id}/piece-defs").json()
        source_def, linked_def = piece_defs[0], piece_defs[1]
        linked_transform = {
            **linked_def["base_transform"],
            "linked_def_id": source_def["id"],
            "link_mirror_x": mirror_x,
            "link_mirror_y": mirror_y,
        }
        client.patch(
            f"/api/template-sets/{set_id}/piece-defs/{linked_def['id']}",
            json={"base_transform": linked_transform},
        )

        project = client.post(
            "/api/projects/from-template-set",
            json={"set_id": set_id, "size_name": "S", "copy_design_from_base": True},
        ).json()
        pieces = client.get(f"/api/projects/{project['id']}/pieces").json()
        source_piece = next(piece for piece in pieces if piece["name"] == source_def["name"])
        linked_piece = next(piece for piece in pieces if piece["name"] == linked_def["name"])

        assert linked_piece["mirror_of"] == source_piece["id"]
        assert linked_piece["transform"]["mirror_x"] is mirror_x
        assert linked_piece["transform"]["mirror_y"] is mirror_y
        assert linked_piece["transform"]["global_enabled"] is False
        assert "design_x" not in linked_piece["transform"] or linked_piece["transform"]["design_x"] == 0


def test_global_fit_mappings_exclude_linked_pieces() -> None:
    client = TestClient(app)
    with client:
        ts = client.post(
            "/api/template-sets",
            json={"name": "Linked Fit", "garment_type": "shirt", "version_label": "v1"},
        ).json()
        set_id = ts["id"]
        asset = client.post(
            f"/api/template-sets/{set_id}/assets",
            files={"file": ("base.png", _make_rect_pair_image(), "image/png")},
        ).json()
        client.post(
            f"/api/template-sets/{set_id}/sizes/import",
            data={"asset_id": asset["id"], "size_name": "S"},
        )
        piece_defs = client.get(f"/api/template-sets/{set_id}/piece-defs").json()
        source_def, linked_def = piece_defs[0], piece_defs[1]
        client.patch(
            f"/api/template-sets/{set_id}/piece-defs/{linked_def['id']}",
            json={
                "base_transform": {
                    **linked_def["base_transform"],
                    "linked_def_id": source_def["id"],
                    "link_mirror_x": False,
                    "link_mirror_y": False,
                }
            },
        )
        project = client.post(
            "/api/projects/from-template-set",
            json={"set_id": set_id, "size_name": "S", "copy_design_from_base": True},
        ).json()
        pieces = client.get(f"/api/projects/{project['id']}/pieces").json()
        linked_piece = next(piece for piece in pieces if piece["mirror_of"])

        texture = Image.new("RGBA", (64, 64), (24, 96, 180, 255))
        texture_buf = BytesIO()
        texture.save(texture_buf, format="PNG")
        texture_buf.seek(0)
        texture_asset = client.post(
            f"/api/projects/{project['id']}/assets",
            data={"kind": "pattern"},
            files={"file": ("water.png", texture_buf, "image/png")},
        ).json()
        texture_job = client.post(
            f"/api/projects/{project['id']}/textures/generate",
            json={"source_asset_id": texture_asset["id"], "source_type": "pattern", "provider": "local", "model": "local-copy"},
        ).json()["job_id"]
        texture_done = _wait_job(client, texture_job)
        texture_id = texture_done["output"]["texture"]["id"]

        fit_job = client.post(
            f"/api/projects/{project['id']}/textures/{texture_id}/fit-global",
            json={"garment_type": "shirt", "texture_scale": 1, "texture_angle": 0, "symmetry": "continuous"},
        ).json()["job_id"]
        fit_done = _wait_job(client, fit_job)

        mapped_ids = {mapping["id"] for mapping in fit_done["output"]["mappings"]}
        assert fit_done["status"] == "succeeded"
        assert linked_piece["id"] not in mapped_ids
        assert len(mapped_ids) == 1


def _make_rect_pair_image(scale: float = 1.0) -> BytesIO:
    img = Image.new("RGBA", (200, 100), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    w = int(60 * scale)
    h = int(30 * scale)
    # rect 1 centered at (50, 35)
    x1 = 50 - w // 2
    y1 = 35 - h // 2
    draw.rectangle((x1, y1, x1 + w, y1 + h), fill=(255, 255, 255, 255))
    # rect 2 centered at (150, 35)
    x2 = 150 - w // 2
    y2 = 35 - h // 2
    draw.rectangle((x2, y2, x2 + w, y2 + h), fill=(255, 255, 255, 255))
    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf


def _wait_job(client: TestClient, job_id: str) -> dict:
    for _ in range(80):
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in {"succeeded", "failed"}:
            return job
        time.sleep(0.1)
    raise AssertionError("job did not finish")

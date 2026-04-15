import httpx

from app import providers


class FakeClient:
    calls = 0

    def __init__(self, timeout):
        self.timeout = timeout

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def request(self, method, url, headers, json):
        FakeClient.calls += 1
        if FakeClient.calls == 1:
            return httpx.Response(500, request=httpx.Request(method, url), json={"error": "busy"})
        return httpx.Response(200, request=httpx.Request(method, url), json={"ok": True})


def test_request_json_retries_retryable_status(monkeypatch) -> None:
    FakeClient.calls = 0
    monkeypatch.setattr(providers.httpx, "Client", FakeClient)

    data = providers.request_json("POST", "https://example.test", headers={}, payload={"prompt": "布料"}, retries=1)

    assert data == {"ok": True}
    assert FakeClient.calls == 2

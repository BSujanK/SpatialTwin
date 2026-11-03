import threading
import time

import httpx

from app import llm

U = [{"role": "user", "content": "q"}]


def enable(monkeypatch):
    monkeypatch.setenv("QUALCOMM_API_KEY", "k")
    monkeypatch.setenv("QUALCOMM_ENDPOINT", "https://qc.example/v2")


def seq_transport(statuses, calls):
    it = iter(statuses)

    def handler(req):
        calls.append(1)
        st = next(it, statuses[-1])
        if st == 200:
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok text"}}]})
        return httpx.Response(st, json={})

    return httpx.MockTransport(handler)


def test_retry_once_on_429_and_5xx(monkeypatch):
    enable(monkeypatch)
    for first in (429, 503):
        calls = []
        llm.reset_state()
        llm.set_transport(seq_transport([first, 200], calls))
        assert llm.chat("s", U)[0] == "ok text" and len(calls) == 2


def test_http_errors_never_disable_provider(monkeypatch):
    enable(monkeypatch)
    calls = []
    llm.set_transport(seq_transport([500], calls))
    assert llm.chat("s", U) is None and len(calls) == 2  # tried + one retry
    assert llm.providers() == ["qualcomm"]  # still usable
    llm.set_transport(seq_transport([200], calls))
    assert llm.chat("s", U)[0] == "ok text"


def test_background_failure_never_disables_copilot(monkeypatch):
    enable(monkeypatch)

    def boom(req):
        raise httpx.ReadTimeout("slow")

    llm.set_transport(httpx.MockTransport(boom))
    assert llm.chat("s", U, background=True) is None
    assert llm.providers() == ["qualcomm"]  # not on the skip list
    assert llm.chat("s", U) is None  # a copilot timeout does trigger the skip
    assert llm.providers() == []


def test_worker_single_concurrency_newest_first_and_drops_stale():
    w = llm.BackgroundWorker(max_age=0.3)
    order, running, peak = [], [0], [0]
    gate = threading.Event()

    def job(name, block=False):
        def run():
            running[0] += 1
            peak[0] = max(peak[0], running[0])
            if block:
                gate.wait(2)
            order.append(name)
            running[0] -= 1
        return run

    w.submit(job("first", block=True))
    time.sleep(0.1)  # worker picks up "first" and blocks
    w.submit(job("old"))
    time.sleep(0.4)  # "old" becomes stale
    w.submit(job("a"))
    w.submit(job("b"))
    gate.set()
    deadline = time.time() + 2
    while time.time() < deadline and len(order) < 3:
        time.sleep(0.02)
    assert order == ["first", "b", "a"]  # newest first, stale one dropped
    assert peak[0] == 1


def test_warm_up_makes_one_background_call(monkeypatch):
    enable(monkeypatch)
    calls = []
    llm.set_transport(seq_transport([200], calls))
    llm.warm_up()
    deadline = time.time() + 2
    while time.time() < deadline and not calls:
        time.sleep(0.02)
    assert len(calls) == 1
    llm.reset_state()
    monkeypatch.delenv("QUALCOMM_API_KEY")
    calls.clear()
    llm.warm_up()  # no provider: no call
    time.sleep(0.1)
    assert not calls


def test_logging_has_no_key(monkeypatch, caplog):
    import logging
    enable(monkeypatch)
    monkeypatch.setenv("QUALCOMM_API_KEY", "super-secret-key-123")
    llm.set_transport(seq_transport([401], []))
    with caplog.at_level(logging.INFO, logger="spatialtwin.llm"):
        llm.chat("s", U)
    assert "HTTP 401" in caplog.text and "super-secret-key-123" not in caplog.text

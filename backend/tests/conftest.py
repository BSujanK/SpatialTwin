import pytest

from app import llm


@pytest.fixture(autouse=True)
def no_ai_keys(monkeypatch):
    """Tests must pass with no keys (and never touch the network)."""
    for k in ("QUALCOMM_API_KEY", "QUALCOMM_ENDPOINT", "QUALCOMM_MODEL", "ANTHROPIC_API_KEY", "COPILOT_MODEL"):
        monkeypatch.delenv(k, raising=False)
    llm.reset_state()
    llm.set_transport(None)
    yield
    llm.reset_state()
    llm.set_transport(None)

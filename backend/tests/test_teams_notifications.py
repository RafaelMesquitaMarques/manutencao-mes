"""
Microsoft Teams channel notifications — notification_service.
=============================================================
Same container harness as test_pit_stop.py: each async body runs on one shared
event loop and every write is ALWAYS rolled back. Covers:

  Adaptive Card payload shape (message envelope, facts vs free text, mono mode,
  link button, accent color) · teams_channel_on gating (global toggle, URL,
  channel_matrix per trigger) · send_teams statuses (simulated without URL,
  sent on 2xx, failed on HTTP error/exception — never raises) and the
  notification_logs row it writes · _dispatch posts exactly ONE card per event
  regardless of recipients · deep links only with PUBLIC_BASE_URL.

Run (inside the backend container):
    pytest tests/test_teams_notifications.py -v
"""
import asyncio
import os
import sys
import uuid
from types import SimpleNamespace
from unittest import mock

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                                  # noqa: E402
from app.models.models import NotificationLog                         # noqa: E402
from app.services import notification_service                         # noqa: E402
from app.services.notification_service import (                       # noqa: E402
    NotificationService, build_teams_payload, teams_channel_on, teams_link,
)

_LOOP = asyncio.new_event_loop()
_ENGINE = {}


def _maker():
    if "e" not in _ENGINE:
        _ENGINE["e"] = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    return async_sessionmaker(_ENGINE["e"], expire_on_commit=False)


def with_session(fn):
    """Async body on the shared loop, always rolled back."""
    def wrapper():
        async def runner():
            s = _maker()()
            try:
                await fn(s)
            finally:
                await s.rollback()
                await s.close()
        _LOOP.run_until_complete(runner())
    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


def _esc(**over):
    """EscalationSettings stand-in with every field _dispatch/gating reads."""
    base = dict(
        sms_enabled=False, email_enabled=False,
        teams_enabled=True, teams_webhook_url="https://example.test/hook",
        of_teams_webhook_url=None,
        channel_matrix=None, sms_templates=None,
    )
    base.update(over)
    return SimpleNamespace(**base)


class _FakeResp:
    def __init__(self, code, text=""):
        self.status_code = code
        self.text = text


class _FakeClient:
    """Stands in for httpx.AsyncClient — records posts, returns a canned
    response or raises."""
    def __init__(self, resp=None, exc=None):
        self._resp, self._exc = resp, exc
        self.posts = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json=None):
        self.posts.append((url, json))
        if self._exc:
            raise self._exc
        return self._resp


def _patched_client(fake):
    return mock.patch.object(
        notification_service.httpx, "AsyncClient", new=lambda **kw: fake
    )


async def _last_log(s, role):
    return (await s.execute(
        select(NotificationLog).where(NotificationLog.recipient_role == role)
        .order_by(NotificationLog.created_at.desc()).limit(1)
    )).scalar_one_or_none()


# ── Payload builder ──────────────────────────────────────────────────────────

def test_payload_is_adaptive_card_message_envelope():
    p = build_teams_payload("Title", ["Machine: FH6", "free text"])
    assert p["type"] == "message"
    att = p["attachments"][0]
    assert att["contentType"] == "application/vnd.microsoft.card.adaptive"
    card = att["content"]
    assert card["type"] == "AdaptiveCard" and card["version"] == "1.4"
    assert card["body"][0]["text"] == "Title"


def test_payload_splits_facts_and_free_text():
    p = build_teams_payload("T", ["Machine: FH6", "Priorité: high", "some prose", ""])
    body = p["attachments"][0]["content"]["body"]
    facts = [b for b in body if b["type"] == "FactSet"]
    assert len(facts) == 1
    assert [f["title"] for f in facts[0]["facts"]] == ["Machine:", "Priorité:"]
    texts = [b["text"] for b in body if b["type"] == "TextBlock"]
    assert "some prose" in texts        # free text survives
    assert "" not in texts              # blank lines dropped


def test_payload_time_ranges_never_become_facts():
    # "07:00-15:00" contains a colon but is not a Key: Value label
    p = build_teams_payload("T", ["07:00-15:00"])
    body = p["attachments"][0]["content"]["body"]
    assert not any(b["type"] == "FactSet" for b in body)
    assert any(b.get("text") == "07:00-15:00" for b in body)


def test_payload_link_and_accent():
    p = build_teams_payload("T", [], link_url="https://x/tickets/1", accent="attention")
    card = p["attachments"][0]["content"]
    assert card["actions"][0]["type"] == "Action.OpenUrl"
    assert card["actions"][0]["url"] == "https://x/tickets/1"
    assert card["body"][0]["color"] == "attention"
    no_link = build_teams_payload("T", [])
    assert "actions" not in no_link["attachments"][0]["content"]
    assert "color" not in no_link["attachments"][0]["content"]["body"][0]


def test_payload_mono_preserves_lines():
    p = build_teams_payload("T", ["AAA  1", "", "BBB  2"], mono=True)
    body = p["attachments"][0]["content"]["body"][1:]
    assert [b["fontType"] for b in body] == ["Monospace"] * 3
    assert [b["spacing"] for b in body] == ["None"] * 3
    assert not any(b["type"] == "FactSet" for b in body)


# ── Gating ───────────────────────────────────────────────────────────────────

def test_teams_channel_on_gating():
    assert teams_channel_on(_esc()) == "https://example.test/hook"
    assert teams_channel_on(_esc(teams_enabled=False)) == ""
    assert teams_channel_on(_esc(teams_webhook_url="  ")) == ""
    assert teams_channel_on(_esc(teams_webhook_url=None)) == ""
    m = {"ticket_opened": {"teams": False, "sms": True}}
    assert teams_channel_on(_esc(channel_matrix=m), "ticket_opened") == ""
    # missing matrix entry = enabled; other triggers untouched
    assert teams_channel_on(_esc(channel_matrix=m), "ticket_completed") != ""
    assert teams_channel_on(_esc(channel_matrix=m)) != ""


def test_teams_channel_on_of_routing():
    """OF events (of=True) use the dedicated OF channel when set, fall back to
    the machine channel otherwise, and obey the same master switch/matrix."""
    both = _esc(of_teams_webhook_url="https://example.test/of-hook")
    assert teams_channel_on(both, "of_watch", of=True) == "https://example.test/of-hook"
    # machine events never route to the OF channel
    assert teams_channel_on(both, "ticket_opened") == "https://example.test/hook"
    # no OF URL → shared machine channel
    assert teams_channel_on(_esc(), "of_watch", of=True) == "https://example.test/hook"
    # OF URL alone works even without a machine channel
    only_of = _esc(teams_webhook_url=None, of_teams_webhook_url="https://example.test/of-hook")
    assert teams_channel_on(only_of, "of_watch", of=True) == "https://example.test/of-hook"
    assert teams_channel_on(only_of, "ticket_opened") == ""
    # master switch and per-trigger matrix still gate the OF channel
    assert teams_channel_on(_esc(teams_enabled=False, of_teams_webhook_url="https://x"), "of_watch", of=True) == ""
    m = {"of_watch": {"teams": False}}
    assert teams_channel_on(both, "of_watch", of=True) != ""
    assert teams_channel_on(_esc(of_teams_webhook_url="https://x", channel_matrix=m), "of_watch", of=True) == ""


def test_teams_link_needs_public_base_url():
    with mock.patch.object(notification_service.app_settings, "PUBLIC_BASE_URL", ""):
        assert teams_link(ticket_id="abc") is None
    with mock.patch.object(notification_service.app_settings, "PUBLIC_BASE_URL", "https://kaizo.example/"):
        assert teams_link(ticket_id="abc") == "https://kaizo.example/tickets/abc"
        assert teams_link(alert_id="def") == "https://kaizo.example/alerts/def"
        assert teams_link() == "https://kaizo.example"


# ── send_teams statuses + log rows ───────────────────────────────────────────

@with_session
async def test_send_teams_without_url_simulates(s):
    role = f"t-{uuid.uuid4().hex[:8]}"
    status = await NotificationService(s).send_teams("", "Title", ["a"], recipient_role=role)
    assert status == "simulated"
    log = await _last_log(s, role)
    assert log is not None and log.status == "simulated"
    assert log.notification_type == "teams"
    assert "Title" in log.message


@with_session
async def test_send_teams_2xx_is_sent_and_url_not_logged(s):
    role = f"t-{uuid.uuid4().hex[:8]}"
    fake = _FakeClient(resp=_FakeResp(202))
    with _patched_client(fake):
        status = await NotificationService(s).send_teams(
            "https://secret.example/hook", "Title", ["Machine: X"], recipient_role=role,
        )
    assert status == "sent"
    assert fake.posts[0][0] == "https://secret.example/hook"
    assert fake.posts[0][1]["type"] == "message"
    log = await _last_log(s, role)
    assert log.status == "sent"
    assert "secret.example" not in (log.message or "")
    assert "secret.example" not in (log.recipient_contact or "")


@with_session
async def test_send_teams_http_error_and_exception_fail_softly(s):
    svc = NotificationService(s)
    role1 = f"t-{uuid.uuid4().hex[:8]}"
    with _patched_client(_FakeClient(resp=_FakeResp(400, "Bad payload"))):
        assert await svc.send_teams("https://h", "T", [], recipient_role=role1) == "failed"
    log = await _last_log(s, role1)
    assert log.status == "failed" and "HTTP 400" in log.message

    role2 = f"t-{uuid.uuid4().hex[:8]}"
    with _patched_client(_FakeClient(exc=RuntimeError("boom"))):
        assert await svc.send_teams("https://h", "T", [], recipient_role=role2) == "failed"
    assert (await _last_log(s, role2)).status == "failed"


# ── _dispatch: one card per event ────────────────────────────────────────────

@with_session
async def test_dispatch_posts_one_card_per_event(s):
    svc = NotificationService(s)
    calls = []

    async def spy(url, title, lines, **kw):
        calls.append((url, title, kw.get("accent")))
        return "sent"

    with mock.patch.object(svc, "send_teams", side_effect=spy):
        await svc._dispatch(
            recipients=[], esc=_esc(), subject="[MES] Nouveau ticket T-1 — FH6",
            body="Ticket: T-1\nMachine: FH6", sms_text="sms",
            role_label="ticket_opened", trigger="ticket_opened",
        )
    assert len(calls) == 1
    assert calls[0][0] == "https://example.test/hook"
    assert calls[0][1] == "Nouveau ticket T-1 — FH6"      # [MES] prefix stripped


@with_session
async def test_dispatch_respects_matrix_and_global_toggle(s):
    svc = NotificationService(s)
    calls = []

    async def spy(*a, **kw):
        calls.append(a)
        return "sent"

    with mock.patch.object(svc, "send_teams", side_effect=spy):
        for esc in (
            _esc(channel_matrix={"ticket_opened": {"teams": False}}),
            _esc(teams_enabled=False),
            _esc(teams_webhook_url=""),
        ):
            await svc._dispatch(
                recipients=[], esc=esc, subject="s", body="b", sms_text="x",
                role_label="ticket_opened", trigger="ticket_opened",
            )
    assert calls == []


@with_session
async def test_dispatch_critical_gets_attention_accent(s):
    svc = NotificationService(s)
    seen = {}

    async def spy(url, title, lines, **kw):
        seen.update(kw)
        return "sent"

    with mock.patch.object(svc, "send_teams", side_effect=spy):
        await svc._dispatch(
            recipients=[], esc=_esc(), subject="[MES] CRITICAL: T-9",
            body="x", sms_text="x", role_label="critical_alert", trigger="critical_alert",
        )
    assert seen.get("accent") == "attention"

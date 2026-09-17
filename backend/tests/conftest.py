"""Session-wide setup for the backend suite.

The DB-facing modules used to own a private event loop and engine each (30 of
them), which leaked 30 loops/engines per run and left nowhere to put setup that
has to happen once. They now all import ``tests/db_harness.py``; this conftest
owns its lifecycle:

  · ``ensure_hypertable_chunks()`` before the first test — the fix for the
    deadlock flakiness, see the long comment in db_harness.py
  · ``shutdown()`` after the last one — dispose the engine, close the loop
"""
import os
import sys

import pytest

# so the test modules can ``from db_harness import with_session`` whatever
# import mode pytest is in, and so db_harness can import ``app.*``
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

import db_harness                                                 # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def db_harness_session():
    db_harness.ensure_hypertable_chunks()
    yield
    db_harness.shutdown()

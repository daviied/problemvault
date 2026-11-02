"""Server-sent events hub: browsers subscribe to a workspace id (or 'index' for
the sidebar) and get every change made by another device or by Claude."""
import json
import queue
import threading

_subs = {}  # key -> set of queues
_lock = threading.Lock()


def subscribe(key):
    q = queue.Queue(maxsize=500)
    with _lock:
        _subs.setdefault(key, set()).add(q)
    return q


def unsubscribe(key, q):
    with _lock:
        _subs.get(key, set()).discard(q)


def publish(key, event, origin=None):
    """event: dict with a 'type'. origin: client id that caused it (it skips its own echo)."""
    msg = json.dumps({**event, "origin": origin})
    with _lock:
        targets = list(_subs.get(key, ()))
    for q in targets:
        try:
            q.put_nowait(msg)
        except queue.Full:
            pass

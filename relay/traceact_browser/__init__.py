"""traceact-browser relay: receives browser traces and writes traceact JSONL.

The relay is the disk-writing half of traceact-browser. The extension
captures console output, page errors, network activity, and interactions
in the browser and POSTs them here in batches; the relay appends them to
one JSONL file that any agent can read and `traceact view` can render.
It also carries commands the other way: DOM snapshots on request, and
click-to-focus from the viewer back to the owning tab.
"""

from traceact_browser.client import RelayNotRunning, focus, health, snapshot
from traceact_browser.server import RelayServer, find_running_relay

__version__ = "1.2.0"

__all__ = ["RelayServer", "find_running_relay", "snapshot", "focus", "health",
           "RelayNotRunning", "__version__"]

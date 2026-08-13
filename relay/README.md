# traceact-browser (relay)

The pip-installable half of [traceact-browser](https://github.com/traceact/traceact-browser): a localhost-only, zero-dependency relay that receives browser traces from the traceact-browser extension and appends them to one traceact-format JSONL file, which any agent can read and [traceact](https://pypi.org/project/traceact/)'s viewer can render live.

```bash
pip install traceact-browser
traceact-browser
```

```
traceact-browser relay on http://127.0.0.1:8631
Trace file: /Users/you/.traceact-browser/traces.jsonl
Demo page:  http://127.0.0.1:8631/demo
View:       traceact view /Users/you/.traceact-browser/traces.jsonl --map --focus-hook http://127.0.0.1:8631/focus
```

The extension half loads unpacked from the repo (no build step): see the [install guide](https://github.com/traceact/traceact-browser/blob/main/README.md). Full manual: [USAGE.md](https://github.com/traceact/traceact-browser/blob/main/USAGE.md).

Built by Mo Shehu — mohammedshehu.com

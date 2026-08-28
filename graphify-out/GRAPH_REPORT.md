# Graph Report - SlopeBattles  (2026-08-23)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 13 nodes · 11 edges · 2 communities (1 shown, 1 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `12460e39`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- manifest.json
- sw.js

## God Nodes (most connected - your core abstractions)
1. `background_color` - 1 edges
2. `display` - 1 edges
3. `icons` - 1 edges
4. `orientation` - 1 edges
5. `scope` - 1 edges
6. `short_name` - 1 edges
7. `start_url` - 1 edges
8. `theme_color` - 1 edges
9. `SHELL_FILES` - 1 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Import Cycles
- None detected.

## Communities (2 total, 1 thin omitted)

### Community 0 - "manifest.json"
Cohesion: 0.18
Nodes (10): background_color, description, display, icons, name, orientation, scope, short_name (+2 more)

## Knowledge Gaps
- **11 isolated node(s):** `background_color`, `description`, `display`, `icons`, `name` (+6 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What connects `background_color`, `description`, `display` to the rest of the system?**
  _11 weakly-connected nodes found - possible documentation gaps or missing edges._
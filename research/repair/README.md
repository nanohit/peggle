# Repair study workflow

This workflow records the difference between a generated candidate and the
author's repaired level. It does not show expressibility scores while editing.

## 1. Build one self-contained session file

From the repository root:

```powershell
node research/tools/build-repair-session.mjs
```

The output is `research/generated/repair-pilot-v1/repair-session.json`. It has
one calibration control followed by five study candidates in seeded order.

## 2. Repair in the normal editor

Open the editor, click **Start / Resume Repair Study**, and choose the session
JSON. The side panel owns navigation, Before/Current comparison, notes,
friction notes, and Done/Defer/Unfixable dispositions.

The active session is autosaved to IndexedDB after each completed editor
transaction and resumes after a reload. This avoids the small `localStorage`
quota: a session embeds six complete baselines and can be several megabytes.
**Before** is read-only. Defer and Unfixable require a reason.

Use **More → Combine into object** after selecting pegs to declare Ring,
Polygon, Line, Arc, or a literal Cluster. A rejected geometric fit is retained
explicitly as a literal cluster with its rejection reason.

**Finish & export** recomputes semantic replay, peg/group lineage,
command/transaction log integrity, and static checks (bounds, launcher
clearance, and cross-object overlap). It waits for the final durable autosave
and exports one `repair-session-result.json` only after the required gates pass.

## 3. Read the result independently

```powershell
node research/tools/analyze-repair-session.mjs "C:\path\to\repair-session-result.json"
```

The output directory contains `analysis.json`, `report.html`, and SVG before /
after views rendered only from the embedded level JSON. The analyzer recomputes
the final diff and replay instead of trusting metrics stored by the editor.

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bug, X, Save, RotateCcw, GitBranch, Search, Plus, ChevronRight, Check } from "lucide-react";

/* Floating inspect badge that follows any [data-viz] element while debug is on */
export function DebugLayer({ active, onInspect }) {
  const [hot, setHot] = useState(null); // { name, label, rect }
  useEffect(() => {
    if (!active) { setHot(null); return; }
    const onMove = (e) => {
      const el = e.target.closest && e.target.closest("[data-viz]");
      if (!el) { setHot(null); return; }
      const r = el.getBoundingClientRect();
      setHot({ name: el.getAttribute("data-viz"), label: el.getAttribute("data-viz-label") || el.getAttribute("data-viz"), rect: { top: r.top, left: r.left, right: r.right, width: r.width, height: r.height } });
    };
    document.addEventListener("mousemove", onMove, true);
    return () => document.removeEventListener("mousemove", onMove, true);
  }, [active]);
  if (!active || !hot) return null;
  return (
    <>
      <div className="dbg-outline" style={{ top: hot.rect.top, left: hot.rect.left, width: hot.rect.width, height: hot.rect.height }} />
      <button className="dbg-badge" style={{ top: hot.rect.top + 6, left: hot.rect.right - 96 }}
        onClick={() => onInspect({ name: hot.name, label: hot.label })}>
        <Search size={12} /> Inspect
      </button>
    </>
  );
}

/* Glow the border of any [data-viz] tile that has a saved insight — no hover needed. */
export function InsightGlow({ refreshKey }) {
  const [names, setNames] = useState(null);
  useEffect(() => {
    fetch("/api/debug/overrides", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { names: [] }))
      .then((j) => setNames(new Set(j.names || [])))
      .catch(() => setNames(new Set()));
  }, [refreshKey]);
  useEffect(() => {
    if (!names) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      document.querySelectorAll("[data-viz]").forEach((el) =>
        el.classList.toggle("has-insight", names.has(el.getAttribute("data-viz"))));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
    apply();
    const obs = new MutationObserver(schedule);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => { obs.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [names]);
  return null;
}

const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(body) }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "Request failed"); return j; });

const ROLE_LABEL = { ceo: "CEO", gm: "GM", area: "Area Manager" };

/* Power BI–style visual editor: measures + table columns, per-role, drag to add/reorder */
export function Inspector({ viz, params, role = "ceo", onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [avail, setAvail] = useState([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [adv, setAdv] = useState(false);
  const [trace, setTrace] = useState(null);
  const [dropHot, setDropHot] = useState(false);
  const [nf, setNf] = useState({ field: "", type: "", op: "notblank", v1: "", v2: "", vals: "" });
  const [ffq, setFfq] = useState("");   // field-picker search (filter on any catalogue field)
  const [fvals, setFvals] = useState({ values: [], numeric: false, loading: false });  // distinct values for the picked column
  const [checked, setChecked] = useState([]);   // Basic-filtering selected values
  const [fmode, setFmode] = useState("basic");  // basic | advanced
  const [valSearch, setValSearch] = useState("");

  useEffect(() => {
    setBusy(true); setErr(""); setDirty(false); setSaved(false); setTrace(null);
    post("/api/debug/run", { name: viz.name, params, role }).then((j) => { setData(j); setBusy(false); }).catch((e) => { setErr(e.message); setBusy(false); });
    fetch("/api/debug/available", { credentials: "include" }).then((r) => r.json()).then((j) => setAvail([...(j.measures || []), ...(j.columns || [])])).catch(() => {});
  }, [viz, params, role]);

  const transform = useCallback((op) => {
    if (!data) return;
    setBusy(true); setErr("");
    post("/api/debug/transform", { name: viz.name, params, role, dax: data.dax, op }).then((j) => { setData(j); setDirty(true); setSaved(false); setBusy(false); })
      .catch((e) => { setErr(e.message); setBusy(false); });
  }, [viz, params, role, data]);

  const addItem = (it) => transform({ kind: "add", itemType: it.type, name: it.name, table: it.table });
  const removeItem = (key) => transform({ kind: "remove", key });
  const reorderTo = (dragKey, targetKey) => {
    const keys = (data?.items || []).map((x) => x.key);
    const from = keys.indexOf(dragKey), to = keys.indexOf(targetKey);
    if (from < 0 || to < 0 || from === to) return;
    keys.splice(to, 0, keys.splice(from, 1)[0]);
    transform({ kind: "reorder", order: keys });
  };
  const save = () => {
    const payload = { name: viz.name, role, dax: data.dax };
    console.log("[VisualEditor] SAVE →", { visual: viz.name, role, items: (data.items || []).map((x) => `${x.kind}:${x.key}`), daxLength: data.dax.length, dax: data.dax });
    setBusy(true); setErr("");
    post("/api/debug/save", payload).then(() => {
      console.log("[VisualEditor] SAVE ok — persisted for role", role);
      setDirty(false); setSaved(true); setBusy(false);
      onSaved && onSaved(role);   // App re-fetches the visual + shows toast
      onClose();                  // close the editor
    }).catch((e) => { console.warn("[VisualEditor] SAVE failed:", e.message); setErr(e.message); setBusy(false); }); // keep panel open on error
  };
  const revert = () => post("/api/debug/revert", { name: viz.name, role }).then(() => post("/api/debug/run", { name: viz.name, params, role })).then((j) => { setData(j); setDirty(false); setSaved(false); }).catch((e) => setErr(e.message));
  const doTrace = () => fetch(`/api/debug/trace/${viz.name}`, { credentials: "include" }).then((r) => r.json()).then(setTrace).catch(() => {});

  const current = data?.items || [];
  const usedNames = useMemo(() => new Set(current.map((c) => (c.kind === "measure" ? c.alias : c.name || c.ref).toLowerCase())), [current]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return avail.filter((m) => !s || m.name.toLowerCase().includes(s) || m.table.toLowerCase().includes(s)).slice(0, 250);
  }, [avail, q]);
  const cols = data && data.rows && data.rows.length ? Object.keys(data.rows[0]) : [];
  const rows = data ? (data.rows || []).slice(0, 60) : [];
  // visual filters (Power BI "Filters on this visual") — measures AND columns
  const MEASURE_OPS = [["notblank", "is not blank"], ["blank", "is blank"], ["gte", "≥"], ["lte", "≤"], ["gt", ">"], ["lt", "<"], ["eq", "="], ["ne", "≠"], ["between", "between"]];
  const COLUMN_OPS = [["is", "is"], ["isnot", "is not"], ["in", "in (list)"], ["contains", "contains"], ["startswith", "starts with"], ["notblank", "is not blank"], ["blank", "is blank"]];
  const NUMCOL_OPS = [["gte", "≥"], ["lte", "≤"], ["gt", ">"], ["lt", "<"], ["between", "between"], ["eq", "="], ["ne", "≠"], ["notblank", "is not blank"], ["blank", "is blank"]];
  const OP_LABEL = Object.fromEntries([...MEASURE_OPS, ...COLUMN_OPS, ...NUMCOL_OPS]);
  // filter on ANY catalogue field (measure or column) — not just what's on the visual
  const catFields = useMemo(() => avail.map((a) => a.type === "measure"
    ? { key: `m::${a.name}`, type: "measure", ref: a.name, label: a.name, table: a.table }
    : { key: `c::${a.table}::${a.name}`, type: "column", ref: `'${a.table}'[${a.name}]`, label: a.name, table: a.table, rowKey: `${a.table}[${a.name}]` }
  ), [avail]);
  const selField = catFields.find((f) => f.key === nf.field);
  const fieldMatches = useMemo(() => {
    const s = ffq.trim().toLowerCase(); if (!s) return [];
    return catFields.filter((f) => f.label.toLowerCase().includes(s) || f.table.toLowerCase().includes(s)).slice(0, 40);
  }, [catFields, ffq]);
  const fieldOps = selField ? (selField.type === "measure" ? MEASURE_OPS : (fvals.numeric ? NUMCOL_OPS : COLUMN_OPS)) : MEASURE_OPS;
  const mFilters = data?.measureFilters || [];
  const setMeasureFilters = (filters) => transform({ kind: "setFilters", filters });
  const noVal = (op) => op === "notblank" || op === "blank";
  const pickField = (f) => { const ops = f.type === "column" ? COLUMN_OPS : MEASURE_OPS; setNf({ field: f.key, type: f.type, op: ops[0][0], v1: "", v2: "", vals: "" }); setFfq(""); setFmode("basic"); };
  const clearField = () => { setNf({ field: "", type: "", op: "notblank", v1: "", v2: "", vals: "" }); setFfq(""); setChecked([]); setValSearch(""); };
  // when a column is chosen, load its distinct values for the Basic value list
  useEffect(() => {
    if (!selField || selField.type !== "column") { setFvals({ values: [], numeric: false, loading: false }); return; }
    setFvals({ values: [], numeric: false, loading: true }); setChecked([]); setValSearch("");
    fetch(`/api/debug/values?table=${encodeURIComponent(selField.table)}&column=${encodeURIComponent(selField.label)}&model=${encodeURIComponent(data?.model || "main")}`, { credentials: "include" })
      .then((r) => r.json()).then((j) => { const numeric = !!j.numeric; setFvals({ values: j.values || [], numeric, loading: false }); setNf((n) => ({ ...n, op: numeric ? "gte" : "is" })); })
      .catch(() => setFvals({ values: [], numeric: false, loading: false }));
  }, [nf.field]); // eslint-disable-line
  const shownVals = useMemo(() => { const s = valSearch.trim().toLowerCase(); return (s ? fvals.values.filter((v) => String(v).toLowerCase().includes(s)) : fvals.values).slice(0, 1000); }, [fvals, valSearch]);
  const toggleVal = (v) => { const k = String(v); setChecked((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k])); };
  const allShownChecked = shownVals.length > 0 && shownVals.every((v) => checked.includes(String(v)));
  const toggleAll = () => setChecked((c) => (allShownChecked ? c.filter((k) => !shownVals.map(String).includes(k)) : [...new Set([...c, ...shownVals.map(String)])]));
  const addBasic = () => {
    if (!selField || !checked.length) return;
    setMeasureFilters([...mFilters, { type: "column", ref: selField.ref, label: selField.label, op: "in", vals: [...checked], numeric: fvals.numeric }]);
    clearField();
  };
  const addFilter = () => {
    if (!selField) return;
    const filt = { type: selField.type, ref: selField.ref, label: selField.label, op: nf.op };
    if (selField.type === "column" && fvals.numeric) filt.numeric = true;
    if (nf.op === "in") filt.vals = nf.vals.split(",").map((s) => s.trim()).filter(Boolean);
    else if (!noVal(nf.op)) { filt.v1 = nf.v1; if (nf.op === "between") filt.v2 = nf.v2; }
    setMeasureFilters([...mFilters, filt]); clearField();
  };
  const chipVal = (mf) => (mf.op === "in" ? ((mf.vals || []).length > 4 ? `${(mf.vals || []).slice(0, 4).join(", ")} +${mf.vals.length - 4}` : (mf.vals || []).join(", ")) : mf.op === "between" ? `${mf.v1}–${mf.v2}` : (mf.v1 != null ? mf.v1 : ""));

  const onDropAdd = (e) => {
    e.preventDefault(); setDropHot(false);
    try { const it = JSON.parse(e.dataTransfer.getData("additem")); if (it?.name) addItem(it); } catch {}
  };

  return (
    <AnimatePresence>
      <motion.div className="dbg-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.aside className="dbg-panel" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", stiffness: 320, damping: 36 }}>
        <div className="dbg-head">
          <div className="dbg-title"><span className="dbg-ico"><Bug size={15} /></span>
            <div><b>{viz.name}</b><span>Editing the <b className="dbg-role">{ROLE_LABEL[role]}</b> version{data?.hasOverride ? " · override active" : ""}{busy ? " · running…" : ""}</span></div>
          </div>
          <button className="as-x" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="dbg-toolbar">
          <button className="btn primary" onClick={save} disabled={busy || !dirty}><Save size={13} /> {saved ? "Saved" : `Save for ${ROLE_LABEL[role]}`}{saved && <Check size={13} />}</button>
          <button className="btn" onClick={revert} disabled={busy || (!data?.hasOverride && !dirty)}><RotateCcw size={13} /> {data?.hasOverride ? "Revert" : "Cancel"}</button>
          <button className="btn" onClick={doTrace}><GitBranch size={13} /> Trace</button>
          <button className="btn" onClick={onClose} style={{ marginLeft: "auto" }}>Done</button>
        </div>
        {err && <div className="dbg-err">{err}</div>}

        <div className="dbg-editor">
          {/* current items (drop target + reorderable) */}
          <section className="dbg-sec">
            <div className="dbg-lbl">On this visual — {ROLE_LABEL[role]} <span className="dbg-hint">drag items in · drag chips to reorder · ✕ to remove</span></div>
            <div className={`dbg-current ${dropHot ? "hot" : ""}`}
              onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer.types.includes("additem")) setDropHot(true); }} onDragLeave={() => setDropHot(false)} onDrop={onDropAdd}>
              {current.map((c) => {
                const label = c.kind === "measure" ? c.alias : (c.name || c.ref);
                return (
                  <span key={c.key} className={`dbg-mchip ${c.kind}`} draggable
                    onDragStart={(e) => e.dataTransfer.setData("reorderkey", c.key)}
                    onDragOver={(e) => { if (e.dataTransfer.types.includes("reorderkey")) e.preventDefault(); }}
                    onDrop={(e) => { const dk = e.dataTransfer.getData("reorderkey"); if (dk) { e.preventDefault(); e.stopPropagation(); reorderTo(dk, c.key); } }}>
                    <span className="dbg-mtype">{c.kind === "measure" ? "ƒ" : "▦"}</span><b>{label}</b>
                    <button onClick={() => removeItem(c.key)} title="Remove"><X size={11} /></button>
                  </span>
                );
              })}
              {!current.length && <span className="dbg-muted">no editable items</span>}
            </div>
          </section>

          {/* measure filters — like Power BI "Filters on this visual" */}
          <section className="dbg-sec">
            <div className="dbg-lbl">Filters on this visual <span className="dbg-hint">filter by ANY measure or column — even fields not shown on the visual</span></div>
            <div className="dbg-mfilters">
              {mFilters.map((mf, i) => (
                <div key={i} className="dbg-mfilter">
                  <span className={`dbg-mtype ${mf.type === "column" ? "col" : ""}`}>{mf.type === "column" ? "▦" : "ƒ"}</span><b>{mf.label || mf.measure}</b>
                  <span className="dbg-mfop">{OP_LABEL[mf.op] || mf.op}{chipVal(mf) ? ` ${chipVal(mf)}` : ""}</span>
                  <button onClick={() => setMeasureFilters(mFilters.filter((_, j) => j !== i))} title="Remove filter"><X size={11} /></button>
                </div>
              ))}
              {!mFilters.length && <span className="dbg-muted">no filters — every row shown</span>}
            </div>
            {!selField ? (
              <div className="dbg-fieldpick">
                <div className="dbg-search"><Search size={13} /><input placeholder="Search any measure or column to filter…" value={ffq} onChange={(e) => setFfq(e.target.value)} /></div>
                {ffq.trim() && (
                  <div className="dbg-fieldlist">
                    {fieldMatches.map((f) => (
                      <button key={f.key} className="dbg-fielditem" onClick={() => pickField(f)}>
                        <span className={`dbg-avkind ${f.type}`}>{f.type === "measure" ? "ƒ" : "▦"}</span>
                        <b>{f.label}</b><span className="dbg-ftable">{f.table}</span>
                      </button>
                    ))}
                    {!fieldMatches.length && <span className="dbg-muted" style={{ padding: "6px 8px" }}>no field matches “{ffq}”</span>}
                  </div>
                )}
              </div>
            ) : (
              <div className="dbg-fb">
                <div className="dbg-fb-head">
                  <span className="dbg-selfield"><span className={`dbg-mtype ${selField.type === "column" ? "col" : ""}`}>{selField.type === "column" ? "▦" : "ƒ"}</span>{selField.label}<span className="dbg-fb-tbl">{selField.table}</span><button title="Change field" onClick={clearField}><X size={11} /></button></span>
                  {selField.type === "column" && (
                    <div className="dbg-fb-tabs">
                      <button className={fmode === "basic" ? "on" : ""} onClick={() => setFmode("basic")}>Basic</button>
                      <button className={fmode === "advanced" ? "on" : ""} onClick={() => setFmode("advanced")}>Advanced</button>
                    </div>
                  )}
                </div>
                {selField.type === "column" && fmode === "basic" ? (
                  fvals.loading ? <span className="dbg-muted">loading values…</span> : (
                    <div className="dbg-fb-basic">
                      <div className="dbg-search sm"><Search size={12} /><input placeholder={`Search ${selField.label} values…`} value={valSearch} onChange={(e) => setValSearch(e.target.value)} /></div>
                      <label className="dbg-valrow sel-all"><input type="checkbox" checked={allShownChecked} onChange={toggleAll} /> <b>Select all</b> <span className="dbg-muted">({shownVals.length}{fvals.values.length > shownVals.length ? ` of ${fvals.values.length}` : ""})</span></label>
                      <div className="dbg-vallist">
                        {shownVals.map((v) => (
                          <label key={String(v)} className="dbg-valrow"><input type="checkbox" checked={checked.includes(String(v))} onChange={() => toggleVal(v)} /> <span>{String(v)}</span></label>
                        ))}
                        {!shownVals.length && <span className="dbg-muted" style={{ padding: 6 }}>{fvals.values.length ? "no match" : "no values"}</span>}
                      </div>
                      <button className="dbg-af-add" disabled={busy || !checked.length} onClick={addBasic}><Plus size={12} /> Add filter{checked.length ? ` (${checked.length})` : ""}</button>
                    </div>
                  )
                ) : (
                  <div className="dbg-addfilter">
                    <select value={nf.op} onChange={(e) => setNf({ ...nf, op: e.target.value })}>{fieldOps.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                    {nf.op === "in" ? (
                      <input placeholder="value1, value2" value={nf.vals} onChange={(e) => setNf({ ...nf, vals: e.target.value })} />
                    ) : !noVal(nf.op) ? (
                      <>
                        <input list="dbg-fvals" type={selField.type === "column" && !fvals.numeric ? "text" : "number"} placeholder={nf.op === "between" ? "Min" : "Value"} value={nf.v1} onChange={(e) => setNf({ ...nf, v1: e.target.value })} />
                        {nf.op === "between" && <input type="number" placeholder="Max" value={nf.v2} onChange={(e) => setNf({ ...nf, v2: e.target.value })} />}
                        <datalist id="dbg-fvals">{fvals.values.slice(0, 300).map((v) => <option key={String(v)} value={String(v)} />)}</datalist>
                      </>
                    ) : null}
                    <button className="dbg-af-add" disabled={busy || (nf.op === "in" ? !nf.vals.trim() : (!noVal(nf.op) && nf.v1 === ""))} onClick={addFilter}><Plus size={12} /> Add filter</button>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* available: measures + table columns */}
          <section className="dbg-sec dbg-avail-sec">
            <div className="dbg-search"><Search size={13} /><input placeholder="Find measures or columns" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <div className="dbg-avail">
              {filtered.map((m) => {
                const inUse = usedNames.has(m.name.toLowerCase());
                return (
                  <div key={m.type + "|" + m.table + "|" + m.name} className={`dbg-avitem ${inUse ? "used" : ""}`} draggable
                    onDragStart={(e) => e.dataTransfer.setData("additem", JSON.stringify(m))}>
                    <span className={`dbg-avkind ${m.type}`}>{m.type === "measure" ? "Measure" : "Column"}</span>
                    <div className="dbg-avmain"><span className="dbg-avname">{m.name}</span><span className="dbg-avtable">{m.table}</span></div>
                    <button className="dbg-avadd" title={inUse ? "Already added" : "Add"} onClick={() => addItem(m)} disabled={inUse}>{inUse ? <Check size={13} /> : <Plus size={13} />}</button>
                  </div>
                );
              })}
              {!filtered.length && <span className="dbg-muted" style={{ padding: 10 }}>No measures or columns match “{q}”.</span>}
            </div>
          </section>
        </div>

        <div className="dbg-results">
          <div className="dbg-lbl" style={{ padding: "8px 16px 4px" }}>Live results <span className="dbg-hint">{data ? `${data.rows?.length || 0} rows` : ""} · updates instantly</span></div>
          <div className="dbg-tablewrap">
            <table className="dbg-table">
              <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className={r[c] == null || r[c] === "" ? "null" : ""}>{r[c] == null ? "∅" : String(r[c]).slice(0, 36)}</td>)}</tr>)}
                {!rows.length && <tr><td colSpan={cols.length || 1} className="dbg-muted" style={{ padding: 12 }}>No rows</td></tr>}
              </tbody>
            </table>
          </div>

          <button className="dbg-advtoggle" onClick={() => setAdv((a) => !a)}><ChevronRight size={13} className={adv ? "open" : ""} /> Advanced · DAX, filters, diagnostics</button>
          {adv && (
            <div className="dbg-adv">
              <div className="dbg-lbl">Filters applied</div>
              {(data?.filters || []).map((f, i) => <div key={i} className="dbg-filter"><b>{f.label}</b><code>{f.expr}</code></div>)}
              <div className="dbg-lbl" style={{ marginTop: 10 }}>Diagnostics</div>
              {(data?.diagnostics || []).map((d) => (
                <div key={d.column} className={`dbg-diag ${d.status}`}><span className="dbg-diag-col">{d.column}</span><span className="dbg-diag-st">{d.status === "ok" ? `${d.filled}/${d.total}` : d.status}</span>{d.reason && <span className="dbg-diag-why">{d.reason}</span>}</div>
              ))}
              <div className="dbg-lbl" style={{ marginTop: 10 }}>DAX</div>
              <pre className="dbg-daxview">{data?.dax}</pre>
              {trace && (<><div className="dbg-lbl" style={{ marginTop: 10 }}>Trace — {trace.dependents.length} dependents</div>
                {trace.dependents.map((d) => <div key={d.visual} className="dbg-trace"><b>{d.visual}</b><span className="dbg-muted">{d.page}</span><span className="dbg-share">{d.sharedMeasures.join(", ")}</span></div>)}</>)}
            </div>
          )}
        </div>
      </motion.aside>
    </AnimatePresence>
  );
}

/* header toggle — admins only */
export function DebugToggle({ on, onToggle }) {
  return (
    <button className={`dbg-toggle ${on ? "on" : ""}`} onClick={onToggle} title="Admin debug / visual editor">
      <Bug size={14} /> Debug {on ? "on" : ""}
    </button>
  );
}

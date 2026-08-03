import React, { useState, useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Search, X, Plus, Save, Download, RotateCcw, Trash2, BarChart3, LineChart, PieChart, Table as TableIcon, Grid3x3, Hash, ScatterChart, ChevronDown, ChevronLeft, Pencil, GripVertical, BookOpen, Maximize2, LayoutGrid, HelpCircle } from "lucide-react";
import { EChart, CountUp, Skeleton, barOption, multiLineOption, groupedBarOption, donutOption, heatOption } from "./ui.jsx";
import AgTable from "./AgTableLazy.jsx";
import { selBody, presetLabel } from "./dates.js";
import LearnPage from "./AnalysisLabLearn.jsx";
import Tour, { tourDone, lastStep } from "./Tour.jsx";

const nn = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const FMT = {
  kd: (v) => "KD " + Math.round(nn(v)).toLocaleString("en-US"),
  kdc: (v) => "KD " + nn(v).toFixed(2),
  num: (v) => Math.round(nn(v)).toLocaleString("en-US"),
  min: (v) => nn(v).toFixed(1) + " min",
  pct: (v) => (nn(v) * 100).toFixed(2) + "%",
  rate: (v) => nn(v).toFixed(2),
};
const fmtOf = (f) => FMT[f] || ((v) => String(v ?? ""));
const PALETTE = ["#12B76A", "#2E90FA", "#F79009", "#F04438", "#7A5AF8", "#EE46BC", "#06AED4", "#EAAA08"];
const CHART_TYPES = [
  { key: "auto", label: "Auto (recommended)", icon: Hash },
  { key: "bar", label: "Bar", icon: BarChart3 },
  { key: "line", label: "Line", icon: LineChart },
  { key: "area", label: "Stacked Area", icon: LineChart },
  { key: "grouped", label: "Grouped Bar", icon: BarChart3 },
  { key: "donut", label: "Donut", icon: PieChart },
  { key: "heatmap", label: "Heatmap", icon: Grid3x3 },
  { key: "scatter", label: "Scatter", icon: ScatterChart },
  { key: "big", label: "Big Number", icon: Hash },
  { key: "table", label: "Table", icon: TableIcon },
];
const TYPE_ICON = Object.fromEntries(CHART_TYPES.map((t) => [t.key, t.icon]));

function recommend(measKeys, dimObjs) {
  const m = measKeys.length, d = dimObjs.length;
  if (m === 0) return null;
  if (d === 0) return "big";
  if (d >= 3) return "table";
  const time = dimObjs.some((x) => x.time);
  if (d === 2) return "heatmap";
  if (m === 1) return time ? "line" : "bar";
  if (m >= 2) return time ? "area" : "grouped";
  return "table";
}
async function api(path, opts) {
  const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
const uid = () => "v_" + Math.random().toString(36).slice(2, 9);
const blankVisual = () => ({ id: uid(), name: "Untitled visual", measures: [], dimensions: [], order: "default", filters: { brands: [], locations: [], channels: [] }, chartType: "auto", span: 3 });

/* ============================ container ============================ */
export default function AnalysisLab({ sel, brand = "all", userName = "" }) {
  const reduce = useReducedMotion();
  const [view, setView] = useState("landing");          // landing | editor | learn
  const [cat, setCat] = useState({ measures: [], dimensions: [], brands: [], locations: [], channels: [] });
  const [saved, setSaved] = useState([]);
  const [editing, setEditing] = useState(null);         // the analysis object in the editor
  const [toast, setToast] = useState("");
  const [tour, setTour] = useState(null);               // { type, step }
  const editorApi = useRef(null);                        // imperative handle into the editor (for the tour)
  const flash = (t) => { setToast(t); setTimeout(() => setToast(""), 2400); };

  useEffect(() => { api(`/api/analysis-lab/catalog?brand=${encodeURIComponent(brand)}`).then(setCat).catch(() => {}); }, [brand]);
  const loadList = () => api("/api/analysis-lab/list").then((j) => setSaved(j.analyses || [])).catch(() => {});
  useEffect(() => { loadList(); }, []);
  // first-time onboarding — auto-start the landing tour once (skippable)
  useEffect(() => { if (!tourDone("landing")) { const t = setTimeout(() => setTour({ type: "landing", step: 0 }), 700); return () => clearTimeout(t); } }, []);

  const startTour = (type) => setTour({ type, step: lastStep(type) });
  const tourActions = {
    goEditor: () => { openNew(); setTimeout(() => setTour({ type: "editor", step: 0 }), 350); },
    openLearn: () => setView("learn"),
    openBuilderDemo: () => editorApi.current?.openBuilderDemo(),
    addDemo: () => editorApi.current?.addDemo(),
    closeBuilder: () => editorApi.current?.closeBuilder(),
  };

  const openNew = () => { setEditing({ id: null, name: "Untitled Analysis", visuals: [blankVisual()], cols: 2 }); setView("editor"); };
  const openExisting = (a) => {
    const cfg = a.config || {};
    setEditing({ id: a.own ? a.id : null, name: a.name, visuals: (cfg.visuals && cfg.visuals.length ? cfg.visuals : [blankVisual()]).map((v) => ({ ...blankVisual(), ...v })), cols: cfg.cols || 2, shared: a.isShared });
    setView("editor");
  };
  const del = async (a) => { await api("/api/analysis-lab/delete", { method: "POST", body: JSON.stringify({ id: a.id }) }).catch(() => {}); loadList(); flash("Deleted"); };

  const ctx = { cat, sel, brand, reduce, flash };
  return (
    <div className="alab">
      {view === "learn" ? <LearnPage onBack={() => setView("landing")} onStartTour={() => { setView("landing"); setTimeout(() => setTour({ type: "landing", step: 0 }), 200); }} />
        : view === "editor" ? <Editor analysis={editing} ctx={ctx} tourApiRef={editorApi} onHelp={() => startTour("editor")} onBack={() => { setView("landing"); loadList(); }} onSaved={() => loadList()} />
        : <Landing analyses={saved} onNew={openNew} onOpen={openExisting} onDelete={del} onLearn={() => setView("learn")} onHelp={() => startTour("landing")} reduce={reduce} />}
      <AnimatePresence>{toast && <motion.div className="dbg-toast" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}>✓ {toast}</motion.div>}</AnimatePresence>
      {tour && <Tour type={tour.type} startStep={tour.step} actions={tourActions} onClose={() => setTour(null)} />}
    </div>
  );
}

/* ============================ landing ============================ */
function Landing({ analyses, onNew, onOpen, onDelete, onLearn, onHelp, reduce }) {
  return (
    <>
      <div className="alab-toolbar">
        <div className="alab-brand" data-tour="my-analyses">Analysis Lab <span className="alab-sub">My Analyses</span></div>
        <div className="spacer" />
        <button className="alab-help" onClick={onHelp} title="Take the guided tour"><HelpCircle size={18} /></button>
        <button className="btn" onClick={onLearn}><BookOpen size={14} /> Learn</button>
        <button className="btn primary" data-tour="new-analysis" onClick={onNew}><Plus size={14} /> New Analysis</button>
      </div>
      {analyses.length === 0 ? (
        <div className="alab-landing-empty" data-tour="analysis-card">
          <LayoutGrid size={34} />
          <b>No analyses yet</b>
          <span>Create your first dashboard — pick measures, add a chart, save it.</span>
          <button className="btn primary" onClick={onNew}><Plus size={14} /> New Analysis</button>
        </div>
      ) : (
        <div className="alab-cards">
          {analyses.map((a, i) => {
            const visuals = (a.config?.visuals) || [];
            return (
              <motion.div key={a.id} className="alab-card" data-tour={i === 0 ? "analysis-card" : undefined} initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reduce ? 0 : i * 0.05 }} onClick={() => onOpen(a)}>
                <div className="alab-card-thumb">
                  {visuals.slice(0, 6).map((v, j) => { const Icon = TYPE_ICON[v.chartType === "auto" ? "bar" : v.chartType] || BarChart3; return <span key={j} className="alab-thumb-ic"><Icon size={20} /></span>; })}
                  {visuals.length === 0 && <span className="alab-thumb-ic muted"><BarChart3 size={20} /></span>}
                </div>
                <div className="alab-card-body">
                  <div className="alab-card-name">{a.name}{!a.own && <span className="alab-shared">shared</span>}</div>
                  <div className="alab-card-meta">{visuals.length} visual{visuals.length === 1 ? "" : "s"} · {new Date(a.updatedAt || a.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}{!a.own && a.creator ? " · " + a.creator : ""}</div>
                </div>
                {a.own && <button className="alab-card-del" title="Delete" onClick={(e) => { e.stopPropagation(); if (confirm(`Delete “${a.name}”?`)) onDelete(a); }}><Trash2 size={14} /></button>}
              </motion.div>
            );
          })}
          <button className="alab-card alab-card-new" onClick={onNew}><Plus size={22} /><span>New Analysis</span></button>
        </div>
      )}
    </>
  );
}

/* ============================ editor ============================ */
function Editor({ analysis, ctx, tourApiRef, onHelp, onBack, onSaved }) {
  const { cat, sel, brand, reduce, flash } = ctx;
  const [name, setName] = useState(analysis.name);
  const [editName, setEditName] = useState(false);
  const [visuals, setVisuals] = useState(analysis.visuals);
  const [cols, setCols] = useState(analysis.cols || 2);
  const [id, setId] = useState(analysis.id);
  const [builder, setBuilder] = useState(null);          // visual being added/edited (draft) or null
  const dragId = useRef(null);

  // imperative handle so the guided tour can drive the editor (open builder, add a demo visual)
  useEffect(() => {
    if (!tourApiRef) return;
    const demo = () => ({ ...blankVisual(), measures: ["net"], dimensions: ["brand"], name: "Net Sales by Brand" });
    tourApiRef.current = {
      openBuilderDemo: () => setBuilder((b) => b || demo()),
      closeBuilder: () => setBuilder(null),
      addDemo: () => { setBuilder(null); setVisuals((l) => l.some((v) => v.name === "Net Sales by Brand") ? l : [...l, demo()]); },
    };
    return () => { if (tourApiRef) tourApiRef.current = null; };
  }, [tourApiRef]);

  const upsert = (v) => setVisuals((list) => list.some((x) => x.id === v.id) ? list.map((x) => x.id === v.id ? v : x) : [...list, v]);
  const removeVisual = (vid) => setVisuals((list) => list.filter((x) => x.id !== vid));
  const setSpan = (vid, span) => setVisuals((list) => list.map((x) => x.id === vid ? { ...x, span } : x));
  const onDrop = (targetId) => { const from = dragId.current; if (!from || from === targetId) return; setVisuals((l) => { const a = [...l]; const fi = a.findIndex((x) => x.id === from), ti = a.findIndex((x) => x.id === targetId); a.splice(ti, 0, a.splice(fi, 1)[0]); return a; }); dragId.current = null; };

  const save = async () => {
    const config = { visuals, cols };
    const j = await api("/api/analysis-lab/save", { method: "POST", body: JSON.stringify({ id, name, config, chartType: visuals[0]?.chartType || "auto" }) }).catch(() => { flash("Save failed"); return null; });
    if (j) { setId(j.analysis.id); flash(`Saved “${name}”`); onSaved(); }
  };
  const applyPreset = (n) => { setCols(n); const span = n === 1 ? 6 : n === 2 ? 3 : 2; setVisuals((l) => l.map((v) => ({ ...v, span }))); };

  return (
    <>
      <div className="alab-toolbar" data-tour="editor-toolbar">
        <button className="btn" onClick={onBack}><ChevronLeft size={15} /> Back</button>
        {editName
          ? <input autoFocus className="alab-name-in" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setEditName(false)} onKeyDown={(e) => e.key === "Enter" && setEditName(false)} />
          : <button className="alab-name" onClick={() => setEditName(true)}>{name} <Pencil size={13} /></button>}
        <div className="spacer" />
        <button className="alab-help" onClick={onHelp} title="Take the guided tour"><HelpCircle size={18} /></button>
        <div className="alab-layouts" data-tour="editor-layout">
          {[1, 2, 3].map((n) => <button key={n} className={`alab-lyt ${cols === n ? "on" : ""}`} title={`${n} column`} onClick={() => applyPreset(n)}>{n}‑col</button>)}
        </div>
        <button className="btn" onClick={save}><Save size={14} /> Save</button>
      </div>

      <div className="alab-editor" data-tour="editor">
        <aside className="alab-vside" data-tour="editor-sidebar">
          <button className="btn primary alab-addbtn" data-tour="add-visual" onClick={() => setBuilder(blankVisual())}><Plus size={14} /> Add Visual</button>
          <div className="alab-vlist">
            {visuals.map((v) => { const Icon = TYPE_ICON[v.chartType === "auto" ? "bar" : v.chartType] || BarChart3; return (
              <button key={v.id} className="alab-vitem" onClick={() => setBuilder(v)}><Icon size={14} /><span className="alab-vitem-n">{v.name}</span></button>
            ); })}
            {visuals.length === 0 && <div className="alab-empty-sm">No visuals yet — click “Add Visual”.</div>}
          </div>
        </aside>

        <div className="alab-canvas-grid" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
          {visuals.map((v, vi) => (
            <motion.div key={v.id} layout={!reduce} className="alab-vcard" data-tour={vi === 0 ? "canvas-visual" : undefined} style={{ gridColumn: `span ${v.span || 3}` }}
              draggable onDragStart={() => (dragId.current = v.id)} onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop(v.id)}
              initial={reduce ? false : { opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}>
              <div className="alab-vcard-head">
                <GripVertical size={14} className="alab-vgrip" />
                <span className="alab-vcard-title">{v.name}</span>
                <div className="spacer" />
                <div className="alab-span-ctl">{[2, 3, 6].map((s) => <button key={s} className={v.span === s ? "on" : ""} onClick={() => setSpan(v.id, s)} title={s === 6 ? "Full width" : s === 3 ? "Half" : "Third"}>{s === 6 ? "▭" : s === 3 ? "◧" : "▏"}</button>)}</div>
                <button className="alab-vic" onClick={() => setBuilder(v)} title="Edit"><Pencil size={13} /></button>
                <button className="alab-vic" onClick={() => removeVisual(v.id)} title="Remove"><X size={14} /></button>
              </div>
              <VisualCard visual={v} ctx={ctx} />
            </motion.div>
          ))}
          {visuals.length === 0 && <div className="alab-canvas-empty" style={{ gridColumn: "span 6" }}><Maximize2 size={26} /><b>Empty canvas</b><span>Add a visual to get started.</span></div>}
        </div>
      </div>

      <AnimatePresence>
        {builder && <BuilderModal draft={builder} ctx={ctx} onClose={() => setBuilder(null)} onSave={(v) => { upsert(v); setBuilder(null); }} isEdit={visuals.some((x) => x.id === builder.id)} />}
      </AnimatePresence>
    </>
  );
}

/* a saved visual on the canvas — runs its own query */
function VisualCard({ visual, ctx }) {
  const { sel, brand, reduce } = ctx;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const key = JSON.stringify({ m: visual.measures, d: visual.dimensions, o: visual.order, f: visual.filters, sel, brand });
  useEffect(() => {
    if (!visual.measures.length) { setData(null); setLoading(false); setErr("No measure selected"); return; }
    let live = true; setLoading(true); setErr("");
    api("/api/analysis-lab/query", { method: "POST", body: JSON.stringify({ measures: visual.measures, dimensions: visual.dimensions, order: visual.order, filters: visual.filters, range: selBody(sel), brand }) })
      .then((j) => { if (live) { setData(j); setLoading(false); } }).catch((e) => { if (live) { setErr(String(e.message)); setLoading(false); } });
    return () => { live = false; };
  }, [key]);
  const dimObjs = visual.dimensions.map((k) => ctx.cat.dimensions.find((d) => d.key === k)).filter(Boolean);
  const effType = visual.chartType === "auto" ? recommend(visual.measures, dimObjs) : visual.chartType;
  return (
    <div className="alab-vcard-body">
      {loading ? <Skeleton h={200} /> : err ? <div className="alab-err sm">{err}</div> : data ? <ChartArea type={effType} data={data} reduce={reduce} compact /> : <div className="alab-err sm">No data</div>}
    </div>
  );
}

/* add/edit visual modal — the query builder + live preview */
function BuilderModal({ draft, ctx, onClose, onSave, isEdit }) {
  const { cat, sel, brand, reduce } = ctx;
  const [v, setV] = useState({ ...draft });
  const [mSearch, setMSearch] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const set = (patch) => setV((s) => ({ ...s, ...patch }));
  const dimObjs = v.dimensions.map((k) => cat.dimensions.find((d) => d.key === k)).filter(Boolean);
  const recommended = recommend(v.measures, dimObjs);
  const effType = v.chartType === "auto" ? recommended : v.chartType;

  const key = JSON.stringify({ m: v.measures, d: v.dimensions, o: v.order, f: v.filters, sel, brand });
  useEffect(() => {
    if (!v.measures.length) { setData(null); setError(""); return; }
    let live = true; setLoading(true); setError("");
    const t = setTimeout(() => api("/api/analysis-lab/query", { method: "POST", body: JSON.stringify({ measures: v.measures, dimensions: v.dimensions, order: v.order, filters: v.filters, range: selBody(sel), brand }) })
      .then((j) => { if (live) { setData(j); setLoading(false); } }).catch((e) => { if (live) { setError(String(e.message)); setLoading(false); } }), 300);
    return () => { live = false; clearTimeout(t); };
  }, [key]);

  const filtered = cat.measures.filter((m) => !mSearch || (m.label + " " + m.desc + " " + m.table).toLowerCase().includes(mSearch.toLowerCase()));
  const toggleMeasure = (k) => set({ measures: v.measures.includes(k) ? v.measures.filter((x) => x !== k) : v.measures.length >= 3 ? v.measures : [...v.measures, k] });
  const toggleDim = (k) => set({ dimensions: v.dimensions.includes(k) ? v.dimensions.filter((x) => x !== k) : v.dimensions.length >= 2 ? v.dimensions : [...v.dimensions, k] });
  const defaultName = () => { const m = cat.measures.find((x) => x.key === v.measures[0]); const d = cat.dimensions.find((x) => x.key === v.dimensions[0]); return m ? m.label + (d ? " by " + d.label : "") : "Untitled visual"; };
  const commit = () => onSave({ ...v, name: v.name && v.name !== "Untitled visual" ? v.name : defaultName() });

  return (
    <motion.div className="alab-modal-ov" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div className="alab-bmodal" onClick={(e) => e.stopPropagation()} initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.97, opacity: 0 }}>
        <div className="alab-bmodal-head"><b>{isEdit ? "Edit Visual" : "Create New Visual"}</b><button className="alab-vic" onClick={onClose}><X size={17} /></button></div>
        <div className="alab-bmodal-body">
          <div className="alab-bcfg">
            <div className="alab-lbl">Measures <span className="alab-hint">{v.measures.length}/3</span></div>
            <div className="alab-search" data-tour="builder-measures"><Search size={14} /><input value={mSearch} onChange={(e) => setMSearch(e.target.value)} placeholder="Find measures" /></div>
            {v.measures.length > 0 && <div className="alab-pills">{v.measures.map((k) => { const m = cat.measures.find((x) => x.key === k); return <span key={k} className="alab-pill on">{m?.label || k}<button onClick={() => toggleMeasure(k)}><X size={11} /></button></span>; })}</div>}
            <div className="alab-list sm">{filtered.map((m) => (
              <button key={m.key} className={`alab-item ${v.measures.includes(m.key) ? "sel" : ""}`} onClick={() => toggleMeasure(m.key)} disabled={!v.measures.includes(m.key) && v.measures.length >= 3}>
                <span className="alab-item-name">{m.label}</span><span className="alab-item-meta">{m.desc} · {m.table}</span>
              </button>))}
            </div>
            <div className="alab-lbl2">Group / Filter by <span className="alab-hint">{v.dimensions.length}/2</span></div>
            <div className="alab-chips" data-tour="builder-dims">{cat.dimensions.map((d) => <button key={d.key} className={`alab-chip ${v.dimensions.includes(d.key) ? "on" : ""}`} onClick={() => toggleDim(d.key)} disabled={!v.dimensions.includes(d.key) && v.dimensions.length >= 2}>{d.label}</button>)}</div>
            <div className="alab-lbl2">Order by</div>
            <select className="ctl alab-sel" value={v.order} onChange={(e) => set({ order: e.target.value })}>
              <option value="default">Default (highest first)</option><option value="top10">Top 10</option><option value="bottom10">Bottom 10</option><option value="az">A – Z</option>
            </select>
            <div className="alab-lbl2" data-tour="builder-filters">Filters</div>
            <MultiPick label="Brand" options={cat.brands} value={v.filters.brands} onChange={(x) => set({ filters: { ...v.filters, brands: x } })} />
            <MultiPick label="Location" options={cat.locations} value={v.filters.locations} onChange={(x) => set({ filters: { ...v.filters, locations: x } })} />
            <MultiPick label="Channel" options={cat.channels} value={v.filters.channels} onChange={(x) => set({ filters: { ...v.filters, channels: x } })} />
          </div>
          <div className="alab-bprev">
            <div className="alab-rec" data-tour="builder-charttype">
              <span className="alab-rec-tag">Recommended: <b>{(CHART_TYPES.find((t) => t.key === recommended) || {}).label || "—"}</b></span>
              <div className="spacer" />
              <select className="ctl alab-sel sm" value={v.chartType} onChange={(e) => set({ chartType: e.target.value })}>{CHART_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select>
            </div>
            <div className="alab-lbl2">Visual name</div>
            <input className="alab-modal-in" value={v.name === "Untitled visual" ? "" : v.name} placeholder={defaultName()} onChange={(e) => set({ name: e.target.value })} />
            <div className="alab-prev-canvas" data-tour="builder-preview">
              {!v.measures.length ? <div className="alab-emptystate sm"><Hash size={24} /><b>Select a measure</b></div>
                : loading ? <Skeleton h={260} /> : error ? <div className="alab-err">{error}</div> : data ? <ChartArea type={effType} data={data} reduce={reduce} /> : <Skeleton h={260} />}
            </div>
            {data && <div className="alab-insight sm">{data.insight}</div>}
          </div>
        </div>
        <div className="alab-bmodal-foot"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" data-tour="builder-add" onClick={commit} disabled={!v.measures.length}>{isEdit ? "Update Visual" : "Add to Analysis"}</button></div>
      </motion.div>
    </motion.div>
  );
}

function MultiPick({ label, options, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => { const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);
  const toggle = (o) => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);
  const summary = value.length === 0 ? "All" : value.length === 1 ? value[0] : value.length + " selected";
  return (
    <div className="alab-mp" ref={ref}>
      <button className="alab-mp-btn" onClick={() => setOpen((o) => !o)}><span className="alab-mp-lbl">{label}</span><span className="alab-mp-val">{summary}</span><ChevronDown size={13} /></button>
      {open && (
        <div className="alab-mp-menu">
          {value.length > 0 && <button className="alab-mp-clear" onClick={() => onChange([])}>Clear (All)</button>}
          {options.length === 0 && <div className="alab-empty-sm">No options</div>}
          {options.map((o) => <label key={o} className="alab-mp-opt"><input type="checkbox" checked={value.includes(o)} onChange={() => toggle(o)} />{o}</label>)}
        </div>
      )}
    </div>
  );
}

export function ChartArea({ type, data, reduce, compact }) {
  const { rows, schema } = data;
  const dcount = schema.dims.length, mcount = schema.measures.length;
  const m0 = schema.measures[0], fmt0 = fmtOf(m0 && m0.fmt);
  const H = compact ? 210 : 380;
  if (!rows.length) return <div className="alab-err sm">No rows for this configuration.</div>;
  if (type === "big" || (!dcount && type !== "table")) {
    return <div className="alab-big-wrap" style={compact ? { minHeight: 180 } : undefined}>{schema.measures.map((m) => (
      <div key={m.key} className="alab-big"><span className="alab-big-lbl">{m.label}</span><span className="alab-big-val" style={compact ? { fontSize: 30 } : undefined}><CountUp value={nn(rows[0][m.key])} format={fmtOf(m.fmt)} /></span></div>))}</div>;
  }
  if (type === "table") {
    const cols = [...schema.dims.map((d) => ({ headerName: d.label, field: d.key, flex: 1.2, minWidth: 120 })),
      ...schema.measures.map((m) => ({ headerName: m.label, field: m.key, type: "rightAligned", minWidth: 110, valueFormatter: (p) => fmtOf(m.fmt)(p.value) }))];
    return <AgTable title="Result" filename="analysis" height={compact ? 220 : 420} rows={rows} columns={cols} />;
  }
  const cats = rows.map((r) => String(r.d0 ?? ""));
  if (type === "bar") return <EChart height={compact ? H : Math.max(300, Math.min(560, rows.length * 26 + 40))} option={barOption({ data: rows.map((r) => ({ label: String(r.d0), value: nn(r.m0) })), horizontal: true, inverse: true, fmt: fmt0, color: PALETTE[0] })} />;
  if (type === "donut") return <EChart height={H} option={donutOption({ data: rows.slice(0, 10).map((r) => ({ label: String(r.d0), value: nn(r.m0) })), fmt: fmt0 })} />;
  if (type === "line" || type === "area") {
    const series = schema.measures.map((m, i) => ({ name: m.label, data: rows.map((r) => nn(r[m.key])), color: PALETTE[i % PALETTE.length], area: true, stack: type === "area" && mcount > 1 ? "s" : undefined }));
    return <EChart height={H} option={multiLineOption({ x: cats, fmt: fmt0, series })} />;
  }
  if (type === "grouped") { const series = schema.measures.map((m, i) => ({ name: m.label, data: rows.map((r) => nn(r[m.key])), color: PALETTE[i % PALETTE.length] })); return <EChart height={H} option={groupedBarOption({ cats, series, fmt: fmt0 })} />; }
  if (type === "heatmap") {
    if (dcount < 2) return <div className="alab-err sm">Heatmap needs two dimensions.</div>;
    const hd = rows.map((r) => ({ row: String(r.d0), col: String(r.d1), value: nn(r.m0) }));
    return <EChart height={compact ? 240 : Math.max(300, new Set(hd.map((x) => x.row)).size * 26 + 80)} option={heatOption({ data: hd, fmt: fmt0 })} />;
  }
  if (type === "scatter") {
    if (mcount < 2) return <div className="alab-err sm">Scatter needs two measures.</div>;
    const m1 = schema.measures[1];
    const option = { grid: { left: 8, right: 16, top: 16, bottom: 30, containLabel: true },
      tooltip: { trigger: "item", formatter: (p) => `${p.data[2]}<br/>${m0.label}: ${fmt0(p.data[0])}<br/>${m1.label}: ${fmtOf(m1.fmt)(p.data[1])}` },
      xAxis: { type: "value", name: m0.label }, yAxis: { type: "value", name: m1.label },
      series: [{ type: "scatter", symbolSize: 12, data: rows.map((r) => [nn(r.m0), nn(r.m1), String(r.d0)]), itemStyle: { color: PALETTE[4] } }] };
    return <EChart height={H} option={option} />;
  }
  const cols = [...schema.dims.map((d) => ({ headerName: d.label, field: d.key, flex: 1 })), ...schema.measures.map((m) => ({ headerName: m.label, field: m.key, type: "rightAligned", valueFormatter: (p) => fmtOf(m.fmt)(p.value) }))];
  return <AgTable title="Result" filename="analysis" height={compact ? 220 : 420} rows={rows} columns={cols} />;
}

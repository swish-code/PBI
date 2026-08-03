// ============================================================================
//  WIDGET FRAMEWORK — registry-driven layout engine
//  Phase 1: layout engine (drag / resize / hide / collapse) + per-user named
//           layouts persisted server-side.
//  Phase 3: admin GOVERNANCE — per-widget config { enabled, defaultVisible,
//           movable, hideable, roles[] } published globally, enforced for users
//           (they can only arrange what admins allow), edited via a config drawer.
//  Governance: users arrange/hide/resize; admins control availability, access,
//  and defaults. Data, filters and security are never user-editable.
// ============================================================================
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { LayoutGrid, Pencil, Check, Save, RotateCcw, Plus, GripVertical, Maximize2, ChevronsDownUp, ChevronsUpDown, EyeOff, Settings, Share2, ChevronDown, Lock, X, Minus } from "lucide-react";

const api = (url, opts) => fetch(url, { credentials: "include", ...opts }).then((r) => (r.ok ? r.json() : Promise.reject(r)));
const SIZES = [4, 6, 8, 12];
const clampW = (w) => (SIZES.includes(w) ? w : 12);
const ROLES = [["ops", "Operations"], ["area", "Area Manager"], ["gm", "GM / Brand"], ["marketing", "Marketing"], ["admin", "Admin"]];
const defCfg = (c) => ({ enabled: true, defaultVisible: true, movable: true, hideable: true, roles: [], ...(c || {}) });

function reconcile(layout, widgets, config) {
  const byId = new Map(widgets.map((w) => [w.id, w]));
  const regIndex = new Map(widgets.map((w, i) => [w.id, i]));   // default registry order
  const seen = new Set();
  const kept = (layout || []).filter((it) => byId.has(it.id)).map((it) => { seen.add(it.id); const w = byId.get(it.id); return { id: it.id, w: clampW(it.w || w.defaultW || 12), hidden: !!it.hidden, collapsed: !!it.collapsed }; });
  // Widgets NOT in the saved layout (newly added to the registry) slot in at their
  // registry-order position — before the first kept widget that comes after them —
  // rather than always appending to the bottom. So a new top-of-registry widget
  // (e.g. Target Achievement) lands at the top even for users with a saved layout.
  for (const w of widgets) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    const item = { id: w.id, w: clampW(w.defaultW || 12), hidden: defCfg(config[w.id]).defaultVisible === false || !!w.defaultHidden, collapsed: false };
    const myIdx = regIndex.get(w.id);
    let at = kept.findIndex((k) => regIndex.get(k.id) > myIdx);
    if (at < 0) at = kept.length;
    kept.splice(at, 0, item);
  }
  return kept;
}
const defaultLayout = (widgets, config) => widgets.map((w) => ({ id: w.id, w: clampW(w.defaultW || 12), hidden: defCfg(config[w.id]).defaultVisible === false || !!w.defaultHidden, collapsed: false }));

function useLayout(dash, widgets) {
  const [layouts, setLayouts] = useState(null);
  const [active, setActive] = useState("Default");
  const [globalDefault, setGlobalDefault] = useState(null);
  const [config, setConfigState] = useState({});
  const persist = useCallback((nl, act) => { api(`/api/layouts/${dash}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layouts: nl, active: act }) }).catch(() => {}); }, [dash]);

  useEffect(() => {
    let live = true;
    api(`/api/layouts/${dash}`).then(({ user, globalDefault, config }) => {
      if (!live) return;
      setGlobalDefault(globalDefault); setConfigState(config || {});
      if (user && user.layouts && Object.keys(user.layouts).length) { setLayouts(user.layouts); setActive(user.active && user.layouts[user.active] ? user.active : Object.keys(user.layouts)[0]); }
      else { setLayouts({ Default: globalDefault || defaultLayout(widgets, config || {}) }); setActive("Default"); }
    }).catch(() => { if (live) { setLayouts({ Default: defaultLayout(widgets, {}) }); setActive("Default"); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dash]);

  const layout = useMemo(() => (layouts ? reconcile(layouts[active] || defaultLayout(widgets, config), widgets, config) : null), [layouts, active, widgets, config]);
  const setLayout = useCallback((next) => { setLayouts((cur) => { const nl = { ...cur, [active]: next }; persist(nl, active); return nl; }); }, [active, persist]);
  const saveAs = useCallback((name) => { if (!name) return; setLayouts((cur) => { const nl = { ...cur, [name]: reconcile(cur[active] || defaultLayout(widgets, config), widgets, config) }; persist(nl, name); return nl; }); setActive(name); }, [active, persist, widgets, config]);
  const switchTo = useCallback((name) => { setActive(name); setLayouts((cur) => { persist(cur, name); return cur; }); }, [persist]);
  const removeLayout = useCallback((name) => { setLayouts((cur) => { const nl = { ...cur }; delete nl[name]; const keys = Object.keys(nl); const na = keys[0] || "Default"; if (!nl[na]) nl[na] = globalDefault || defaultLayout(widgets, config); persist(nl, na); setActive(na); return nl; }); }, [globalDefault, persist, widgets, config]);
  const resetDefault = useCallback(() => setLayout(globalDefault || defaultLayout(widgets, config)), [globalDefault, setLayout, widgets, config]);
  const publish = useCallback((role) => api(`/api/admin/layouts/${dash}/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout, role: role || undefined }) }).catch(() => {}), [dash, layout]);
  const saveConfig = useCallback((cfg) => { setConfigState(cfg); return api(`/api/admin/layouts/${dash}/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: cfg }) }).catch(() => {}); }, [dash]);

  return { layout, setLayout, layouts, active, switchTo, saveAs, removeLayout, resetDefault, publish, config, saveConfig, ready: !!layouts };
}

export default function WidgetGrid({ dash, widgets, isAdmin = false, role = "" }) {
  const L = useLayout(dash, widgets);
  const [edit, setEdit] = useState(false);
  const [menu, setMenu] = useState(null);
  const [cfgOpen, setCfgOpen] = useState(false);
  const dragId = useRef(null);
  const gridRef = useRef(null);
  const reduce = useReducedMotion();   // must stay ABOVE the !L.ready early return (hooks rule)
  const byId = useMemo(() => Object.fromEntries(widgets.map((w) => [w.id, w])), [widgets]);
  const cfgOf = useCallback((id) => defCfg(L.config[id]), [L.config]);

  if (!L.ready) return <div className="wg-grid"><div className="wg-item" style={{ gridColumn: "span 12" }}><div className="card"><div className="skl" style={{ height: 80 }} /></div></div></div>;

  const layout = L.layout;
  // governance: hide disabled widgets + role-gated widgets from the dashboard
  const allowed = (id) => { const c = cfgOf(id); return c.enabled && (!c.roles.length || c.roles.includes(role) || isAdmin); };
  const visible = layout.filter((it) => !it.hidden && byId[it.id] && allowed(it.id));
  const hidden = layout.filter((it) => it.hidden && byId[it.id] && allowed(it.id));
  const update = (id, patch) => L.setLayout(layout.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  const cycleSize = (it) => { const sizes = (byId[it.id] && byId[it.id].sizes) || SIZES; const i = sizes.indexOf(it.w); update(it.id, { w: sizes[(i + 1) % sizes.length] }); };
  // drop ANYWHERE — snap the dragged tile to the nearest slot under the cursor (empty gaps too)
  const onGridDrop = (e) => {
    e.preventDefault();
    const dragged = dragId.current; dragId.current = null;
    if (!dragged || !gridRef.current) return;
    const els = [...gridRef.current.querySelectorAll("[data-wgid]")];
    let bestId = null, best = Infinity, after = false;
    for (const el of els) {
      const id = el.getAttribute("data-wgid"); if (id === dragged) continue;
      const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const d = Math.hypot(e.clientX - cx, e.clientY - cy);
      if (d < best) { best = d; bestId = id; after = (e.clientY > cy + r.height * 0.15) || (Math.abs(e.clientY - cy) <= r.height * 0.35 && e.clientX > cx); }
    }
    if (!bestId) return;
    const from = layout.findIndex((it) => it.id === dragged); if (from < 0) return;
    const next = [...layout]; const [m] = next.splice(from, 1);
    let insert = next.findIndex((it) => it.id === bestId); if (insert < 0) insert = next.length;
    if (after) insert += 1;
    next.splice(insert, 0, m); L.setLayout(next);
  };
  const canMove = (id) => isAdmin || cfgOf(id).movable;
  const canHide = (id) => isAdmin || cfgOf(id).hideable;

  return (
    <div className="wg">
      <div className="wg-bar">
        <div className="wg-layouts" onClick={() => setMenu(menu === "layouts" ? null : "layouts")}>
          <LayoutGrid size={14} /> <b>{L.active}</b> <ChevronDown size={13} />
          {menu === "layouts" && (
            <div className="wg-pop" onClick={(e) => e.stopPropagation()}>
              {Object.keys(L.layouts).map((n) => (
                <div key={n} className={`wg-pop-row ${n === L.active ? "on" : ""}`}>
                  <button className="wg-pop-name" onClick={() => { L.switchTo(n); setMenu(null); }}>{n}</button>
                  {n !== "Default" && <button className="wg-pop-x" title="Delete layout" onClick={() => L.removeLayout(n)}>×</button>}
                </div>
              ))}
              <button className="wg-pop-add" onClick={() => { const name = window.prompt("Save current arrangement as:"); if (name) { L.saveAs(name.trim()); setMenu(null); } }}><Plus size={13} /> Save as new layout…</button>
            </div>
          )}
        </div>
        <div style={{ flex: 1 }} />
        {edit && <button className="wg-btn" onClick={L.resetDefault} title="Restore the default layout"><RotateCcw size={13} /> Reset</button>}
        {edit && <button className="wg-btn" onClick={() => { const name = window.prompt("Save layout as:", L.active === "Default" ? "" : L.active); if (name) L.saveAs(name.trim()); }}><Save size={13} /> Save as…</button>}
        {edit && isAdmin && <button className="wg-btn admin" onClick={() => setCfgOpen(true)} title="Admin: configure widget availability, access & defaults"><Settings size={13} /> Configure</button>}
        <button className={`wg-btn ${edit ? "primary" : ""}`} onClick={() => { setEdit((e) => !e); setMenu(null); }}>{edit ? <><Check size={13} /> Done</> : <><Pencil size={13} /> Customize</>}</button>
      </div>

      {edit && hidden.length > 0 && (
        <div className="wg-tray">
          <span className="wg-tray-lbl"><EyeOff size={13} /> Hidden</span>
          {hidden.map((it) => byId[it.id] && <button key={it.id} className="wg-chip" disabled={!canHide(it.id)} onClick={() => canHide(it.id) && update(it.id, { hidden: false })}><Plus size={12} /> {byId[it.id].title}</button>)}
        </div>
      )}

      <div className={`wg-grid ${edit ? "editing ios-editing" : ""}`} ref={gridRef}
        onDragOver={(e) => edit && e.preventDefault()} onDrop={(e) => edit && onGridDrop(e)}>
        {visible.map((it, ix) => {
          const w = byId[it.id]; if (!w) return null;
          const mv = canMove(it.id), hd = canHide(it.id);
          // Scroll reveal — tiles rise in as they enter the viewport, staggered
          // across a row. Skipped in edit mode so it never fights drag-to-reorder.
          const reveal = edit || reduce ? {} : {
            initial: { opacity: 0, y: 18 },
            whileInView: { opacity: 1, y: 0 },
            viewport: { once: true, margin: "0px 0px -12% 0px" },
            transition: { duration: 0.55, ease: [0.22, 0.61, 0.36, 1], delay: Math.min(ix, 6) * 0.06 },
          };
          return (
            <motion.div layout={!edit} key={it.id} data-wgid={it.id} {...reveal} className={`wg-item ${edit ? "ios-tile" : ""} ${edit && mv ? "wg-drag" : ""}`} style={{ gridColumn: `span ${it.w}` }}
              data-viz={w.meta && w.meta.viz} data-viz-label={w.title} data-viz-nomenu={edit ? "1" : undefined}
              draggable={edit && mv} onDragStart={() => (dragId.current = it.id)}>
              {edit && hd && <button className="ios-remove" title="Remove from dashboard" onClick={(e) => { e.stopPropagation(); update(it.id, { hidden: true }); }}><Minus size={14} strokeWidth={3} /></button>}
              {edit && mv && <button className="ios-resize" title={`Resize (${it.w === 12 ? "Full" : it.w === 8 ? "⅔" : it.w === 6 ? "½" : "⅓"})`} onClick={(e) => { e.stopPropagation(); cycleSize(it); }}><Maximize2 size={12} strokeWidth={2.5} /></button>}
              {edit && (
                <div className="wg-head">
                  <span className="wg-grip">{mv ? <GripVertical size={14} /> : <Lock size={13} />}</span>
                  <span className="wg-title">{w.title}</span>
                  <div className="wg-tools">
                    {mv && <button title="Resize" onClick={() => cycleSize(it)}><Maximize2 size={13} /> {it.w === 12 ? "Full" : it.w === 8 ? "⅔" : it.w === 6 ? "½" : "⅓"}</button>}
                    <button title={it.collapsed ? "Expand" : "Collapse"} onClick={() => update(it.id, { collapsed: !it.collapsed })}>{it.collapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}</button>
                    {hd && <button title="Hide" onClick={() => update(it.id, { hidden: true })}><EyeOff size={13} /></button>}
                  </div>
                </div>
              )}
              {!it.collapsed && <div className="wg-body">{w.component}</div>}
            </motion.div>
          );
        })}
      </div>

      <AnimatePresence>
        {cfgOpen && isAdmin && <ConfigDrawer widgets={widgets} config={L.config} onSave={L.saveConfig} onPublish={L.publish} onClose={() => setCfgOpen(false)} />}
      </AnimatePresence>
    </div>
  );
}

// ---- admin governance drawer -----------------------------------------------
function ConfigDrawer({ widgets, config, onSave, onPublish, onClose }) {
  const [cfg, setCfg] = useState(() => Object.fromEntries(widgets.map((w) => [w.id, defCfg(config[w.id])])));
  const [role, setRole] = useState("");
  const [saved, setSaved] = useState(false);
  const set = (id, patch) => setCfg((c) => ({ ...c, [id]: { ...c[id], ...patch } }));
  const toggleRole = (id, r) => setCfg((c) => { const roles = c[id].roles.includes(r) ? c[id].roles.filter((x) => x !== r) : [...c[id].roles, r]; return { ...c, [id]: { ...c[id], roles } }; });
  const save = async () => { await onSave(cfg); setSaved(true); setTimeout(() => setSaved(false), 1800); };
  return (
    <>
      <motion.div className="modal-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div className="wg-drawer" initial={{ x: 460 }} animate={{ x: 0 }} exit={{ x: 460 }} transition={{ type: "spring", stiffness: 380, damping: 40 }}>
        <div className="wg-drawer-head"><div><b>Widget configuration</b><span>Global governance — applies to all users</span></div><button className="ic" onClick={onClose}><X size={16} /></button></div>
        <div className="wg-drawer-body">
          <div className="wg-cfg-hint">Control what each widget does for end users. They can only rearrange what you allow — never data, filters or security.</div>
          {widgets.map((w) => { const c = cfg[w.id]; return (
            <div key={w.id} className={`wg-cfg ${c.enabled ? "" : "off"}`}>
              <div className="wg-cfg-top"><b>{w.title}</b>
                <label className="wg-switch"><input type="checkbox" checked={c.enabled} onChange={(e) => set(w.id, { enabled: e.target.checked })} /><span>Enabled</span></label>
              </div>
              {c.enabled && <>
                <div className="wg-cfg-flags">
                  <label className="wg-chk"><input type="checkbox" checked={c.defaultVisible} onChange={(e) => set(w.id, { defaultVisible: e.target.checked })} /> Visible by default</label>
                  <label className="wg-chk"><input type="checkbox" checked={c.movable} onChange={(e) => set(w.id, { movable: e.target.checked })} /> Users can move/resize</label>
                  <label className="wg-chk"><input type="checkbox" checked={c.hideable} onChange={(e) => set(w.id, { hideable: e.target.checked })} /> Users can hide</label>
                </div>
                <div className="wg-cfg-roles"><span>Access:</span>
                  {c.roles.length === 0 && <em>all roles</em>}
                  {ROLES.map(([id, lbl]) => <button key={id} className={`wg-role ${c.roles.includes(id) ? "on" : ""}`} onClick={() => toggleRole(w.id, id)}>{lbl}</button>)}
                </div>
              </>}
            </div>
          ); })}
        </div>
        <div className="wg-drawer-foot">
          <div className="wg-publish">
            <select value={role} onChange={(e) => setRole(e.target.value)}><option value="">Global default</option>{ROLES.filter(([id]) => id !== "admin").map(([id, l]) => <option key={id} value={id}>{l} default</option>)}</select>
            <button className="btn" onClick={() => onPublish(role)} title="Publish the current on-screen arrangement as the default layout">Publish current layout</button>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save}>{saved ? "Saved ✓" : "Save config"}</button>
        </div>
      </motion.div>
    </>
  );
}

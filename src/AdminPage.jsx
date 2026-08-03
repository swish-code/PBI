import React, { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { UserPlus, Pencil, Trash2, X, ShieldCheck, Users, MapPin, Plus, Search, Database, Check as CheckIcon, CalendarDays, AlertTriangle, Target } from "lucide-react";

const ROLES = [
  { id: "ceo", label: "CEO", hint: "Full access — all brands, areas and stores." },
  { id: "gm", label: "General Manager", hint: "Executive dashboard, filtered to the assigned brand(s)." },
  { id: "opsmgr", label: "Operations Manager", hint: "Operations dashboard for a whole brand — sees every store in it." },
  { id: "area", label: "Area Manager", hint: "Operations dashboard, filtered to the assigned location(s)." },
  { id: "store", label: "Store User", hint: "Store landing page for a single store only." },
  { id: "ops_director", label: "Ops Director", hint: "Sets operational targets across all brands/stores." },
  { id: "admin", label: "Admin", hint: "System administration + full data access." },
];
const ALL_LABELS = { ...Object.fromEntries(ROLES.map((r) => [r.id, r.label])), ops: "Operation Manager (legacy)", marketing: "Marketing" };
const roleLabel = (r) => ALL_LABELS[r] || r;

const api = (url, opts) => fetch(url, { credentials: "include", ...opts }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "Request failed"); return j; });

export default function AdminPage() {
  const [users, setUsers] = useState([]);
  const [tree, setTree] = useState([]);        // [{brand, locations:[...]}]
  const [audit, setAudit] = useState([]);
  const [editing, setEditing] = useState(null); // null | {} (new) | user (edit)
  const [err, setErr] = useState("");
  const [view, setView] = useState("users");    // "users" | "locations"

  const reload = () => Promise.all([
    api("/api/admin/users").then((j) => setUsers(j.users || [])),
    api("/api/admin/audit").then((j) => setAudit(j.log || [])),
  ]).catch((e) => setErr(e.message));

  useEffect(() => {
    reload();
    api("/api/admin/scopetree").then((j) => setTree(j.tree || [])).catch(() => {});
  }, []);

  async function remove(u) {
    if (!window.confirm(`Deactivate ${u.email}? They will lose access immediately.`)) return;
    try { await api(`/api/admin/users/${u.id}`, { method: "DELETE" }); reload(); } catch (e) { setErr(e.message); }
  }

  return (
    <div className="page admin">
      <div className="admin-head">
        <div><h1 className="admin-title"><ShieldCheck size={19} /> {view === "users" ? "User Management" : view === "locations" ? "Location Master" : view === "events" ? "Business Events" : view === "targets" ? "AOV Targets" : "Data Sources"}</h1><p className="admin-sub">{view === "users" ? "Create users, assign roles and data scope. All changes are audited." : view === "locations" ? "Every branch value across your source tables — map unmapped names to a location." : view === "events" ? "Eid, Ramadan and campaign dates used to align comparisons by occasion day. Seeded dates are estimates until you confirm them." : view === "targets" ? "Set each brand's monthly average-order-value target. Orders Target is derived from Sales Target divided by AOV Target." : "The Power BI dataset each semantic model connects to. Update a dataset ID to reconnect."}</p></div>
        {view === "users" && <button className="btn primary" onClick={() => { setErr(""); setEditing({}); }}><UserPlus size={15} /> Create User</button>}
      </div>

      <div className="admin-tabs">
        <button className={`admin-tab ${view === "users" ? "on" : ""}`} onClick={() => setView("users")}><Users size={15} /> Users</button>
        <button className={`admin-tab ${view === "locations" ? "on" : ""}`} onClick={() => setView("locations")}><MapPin size={15} /> Location Master</button>
        <button className={`admin-tab ${view === "targets" ? "on" : ""}`} onClick={() => setView("targets")}><Target size={15} /> AOV Targets</button>
        <button className={`admin-tab ${view === "models" ? "on" : ""}`} onClick={() => setView("models")}><Database size={15} /> Data Sources</button>
        <button className={`admin-tab ${view === "events" ? "on" : ""}`} onClick={() => setView("events")}><CalendarDays size={15} /> Business Events</button>
      </div>

      {err && <div className="admin-err">{err}</div>}

      {view === "locations" && <LocationMaster onErr={setErr} />}
      {view === "models" && <DataSources onErr={setErr} />}
      {view === "events" && <BusinessEvents onErr={setErr} />}
      {view === "targets" && <AovTargets tree={tree} onErr={setErr} />}

      {view === "users" && <>
      <div className="card admin-card">
        <table className="dt admin-table">
          <thead><tr>
            <th className="dt-th l">Name</th><th className="dt-th l">Email</th><th className="dt-th l">Role</th>
            <th className="dt-th l">Data scope</th><th className="dt-th l">Status</th><th className="dt-th r">Actions</th>
          </tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="l" style={{ fontWeight: 700 }}>{u.name}</td>
                <td className="l">{u.email}</td>
                <td className="l"><span className={`role-tag ${u.role}`}>{roleLabel(u.role)}</span></td>
                <td className="l admin-scope">{u.summary}</td>
                <td className="l">{u.active ? <span className="st-on">Active</span> : <span className="st-off">Inactive</span>}</td>
                <td className="r admin-actions">
                  <button className="ic" title="Edit" onClick={() => { setErr(""); setEditing(u); }}><Pencil size={14} /></button>
                  <button className="ic danger" title="Deactivate" onClick={() => remove(u)}><Trash2 size={14} /></button>
                </td>
              </tr>
            ))}
            {!users.length && <tr><td colSpan={6} className="dt-empty">No users</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card admin-card">
        <div className="card-head"><span className="card-title">Audit log</span></div>
        <div className="audit">
          {audit.map((a, i) => (
            <div key={i} className="audit-row">
              <span className="audit-ts">{a.ts.replace("T", " ").slice(0, 16)}</span>
              <span className={`audit-act ${a.action}`}>{a.action}</span>
              <span className="audit-actor">{a.actor}</span>
              <span className="audit-arrow">→</span>
              <span className="audit-target">{a.target}</span>
              {a.details && <span className="audit-det">{a.details}</span>}
            </div>
          ))}
          {!audit.length && <div className="dt-empty">No activity yet</div>}
        </div>
      </div>
      </>}

      <AnimatePresence>
        {editing && <UserModal user={editing} tree={tree} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} onErr={setErr} />}
      </AnimatePresence>
    </div>
  );
}

function UserModal({ user, tree, onClose, onSaved, onErr }) {
  const isNew = !user.id;
  const [email, setEmail] = useState(user.email || "");
  const [name, setName] = useState(user.name || "");
  const [role, setRole] = useState(user.role || "ops");
  const [brands, setBrands] = useState(() => (Array.isArray(user.scope?.brands) ? user.scope.brands : []));
  const [locs, setLocs] = useState(() => (user.scope && typeof user.scope.locations === "object" && user.scope.locations !== null ? user.scope.locations : {}));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const allBrands = useMemo(() => tree.map((t) => t.brand), [tree]);
  const locsOf = (b) => (tree.find((t) => t.brand === b)?.locations) || [];
  const needsBrands = ["gm", "opsmgr", "marketing", "area", "store"].includes(role);
  const needsLocs = role === "area" || role === "store";
  const singleStore = role === "store";   // store user = exactly one brand + one store

  const toggleBrand = (b) => setBrands((cur) => cur.includes(b) ? cur.filter((x) => x !== b) : [...cur, b]);
  const toggleLoc = (b, l) => setLocs((cur) => {
    const arr = cur[b] || []; const next = arr.includes(l) ? arr.filter((x) => x !== l) : [...arr, l];
    return { ...cur, [b]: next };
  });

  async function save() {
    setErr("");
    if (isNew && !/.+@.+\..+/.test(email)) return setErr("Enter a valid email");
    if (needsBrands && !brands.length) return setErr("Select at least one brand");
    if (singleStore && brands.length !== 1) return setErr("Store users must have exactly one brand");
    if (needsLocs && !brands.some((b) => (locs[b] || []).length)) return setErr("Select at least one location");
    if (singleStore && (locs[brands[0]] || []).length !== 1) return setErr("Store users must have exactly one store");
    const scope = { brands: needsBrands ? brands : "all", locations: needsLocs ? Object.fromEntries(brands.map((b) => [b, locs[b] || []])) : "all" };
    const body = { email, name, role, scope };
    setBusy(true);
    try {
      if (isNew) await api("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      else await api(`/api/admin/users/${user.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      onSaved();
    } catch (e) { setErr(e.message); onErr && onErr(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <motion.div className="modal-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div className="modal" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12 }} transition={{ duration: 0.18 }}>
        <div className="modal-head"><b>{isNew ? "Create user" : `Edit ${user.email}`}</b><button className="ic" onClick={onClose}><X size={16} /></button></div>
        <div className="modal-body">
          <div className="mform">
            <label className="mfield"><span>Email</span><input type="email" value={email} disabled={!isNew} onChange={(e) => setEmail(e.target.value)} placeholder="user@swishhh.net" /></label>
            <label className="mfield"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" /></label>
            <label className="mfield"><span>Role</span>
              <select value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
            </label>
            <div className="mfield" style={{ gridColumn: "1 / -1" }}>
              <span>Sign-in</span>
              <div className="mscope-all" style={{ margin: 0 }}>This user signs in with their company Microsoft (Outlook) account — no password to set. Their email must match their Microsoft account.</div>
            </div>
          </div>

          <div className="mscope">
            <div className="uplabel" style={{ marginBottom: 8 }}>Data scope</div>
            <div className="mscope-hint" style={{ margin: "0 0 10px" }}>{(ROLES.find((x) => x.id === role) || {}).hint}</div>
            {(role === "ceo" || role === "ops" || role === "admin" || role === "ops_director") && <div className="mscope-all">All brands, all locations — {roleLabel(role)}s see everything (cannot be narrowed).</div>}
            {needsBrands && (
              <div className="mscope-brands">
                {!allBrands.length && <div className="dt-empty">Loading brands…</div>}
                {allBrands.map((b) => (
                  <div key={b} className="mscope-brand">
                    <label className="mchk"><input type="checkbox" checked={brands.includes(b)} onChange={() => toggleBrand(b)} /><b>{b}</b></label>
                    {needsLocs && brands.includes(b) && (
                      <div className="mscope-locs">
                        {locsOf(b).map((l) => (
                          <label key={l} className="mchk sm"><input type="checkbox" checked={(locs[b] || []).includes(l)} onChange={() => toggleLoc(b, l)} />{l}</label>
                        ))}
                        {!locsOf(b).length && <span className="dt-empty" style={{ padding: 4 }}>no locations</span>}
                      </div>
                    )}
                  </div>
                ))}
                {needsBrands && <p className="mscope-hint">{singleStore ? "Pick the brand, then the single store this user runs." : needsLocs ? "Check the brand(s), then the specific locations this user can access." : "Check the brand(s) this user manages — they see all stores of those brands."}</p>}
              </div>
            )}
          </div>
        </div>
        {err && <div className="modal-err">{err}</div>}
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : isNew ? "Create user" : "Save changes"}</button>
        </div>
      </motion.div>
    </>
  );
}

// ---- Location Master: audit + map every raw branch value across the source tables ----
function LocationMaster({ onErr }) {
  const [data, setData] = useState(null);    // { master, sources, rows }
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("unmapped");   // all | unmapped | mapped
  const [table, setTable] = useState("all");          // "all" (deduped) | a source-table key
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(null);   // { count, mappings, datatable }
  const [dirty, setDirty] = useState(false);

  const load = () => { setLoading(true); api("/api/admin/locations/audit").then((j) => { setData(j); setLoading(false); }).catch((e) => { onErr && onErr(e.message); setLoading(false); }); };
  useEffect(load, []);

  // one row per distinct value (a value appearing in several tables is a single decision)
  const grouped = useMemo(() => {
    if (!data) return [];
    const by = new Map();
    for (const r of data.rows) {
      const k = r.type + "::" + r.value.toLowerCase();
      const g = by.get(k) || { type: r.type, value: r.value, count: 0, sources: [], mapped: r.mapped, overrideId: r.overrideId, modelMatch: r.modelMatch, mappedTo: r.mappedTo };
      g.count += r.count; g.sources.push(r.sourceLabel);
      by.set(k, g);
    }
    return [...by.values()];
  }, [data]);

  async function setMap(row, locationId) {
    try {
      await api("/api/admin/locations/map", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: row.type, value: row.value, locationId: locationId || null }) });
      const loc = (data.master.find((m) => m.id === locationId)) || null;
      setDirty(true);
      setData((d) => ({ ...d, rows: d.rows.map((r) => (r.type === row.type && r.value.toLowerCase() === row.value.toLowerCase() ? { ...r, overrideId: locationId || null, mapped: !!(locationId || r.modelMatch), mappedTo: locationId ? loc : (r.modelMatch ? r.mappedTo : null) } : r)) }));
    } catch (e) { onErr && onErr(e.message); }
  }

  async function apply() {
    setApplying(true);
    try { const j = await api("/api/admin/locations/apply", { method: "POST" }); setApplied(j); setDirty(false); }
    catch (e) { onErr && onErr(e.message); } finally { setApplying(false); }
  }

  // when a specific table is chosen, show every value in THAT table (not the deduped global view)
  const source = useMemo(() => {
    if (!data) return [];
    if (table === "all") return grouped.map((g) => ({ ...g, sources: [...new Set(g.sources)] }));
    return data.rows.filter((r) => r.source === table).map((r) => ({ ...r, sources: [r.sourceLabel] }));
  }, [data, grouped, table]);

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return source.filter((r) =>
      (status === "all" || (status === "unmapped" ? !r.mapped : r.mapped)) &&
      (!ql || r.value.toLowerCase().includes(ql) || (r.mappedTo?.loc || "").toLowerCase().includes(ql)));
  }, [source, status, q]);

  const total = source.length;
  const unmapped = source.filter((r) => !r.mapped).length;

  if (loading) return <div className="card admin-card"><div className="dt-empty">Loading locations from Power BI…</div></div>;
  if (!data) return null;

  return (
    <>
      <div className="lm-bar">
        <div className="lm-stats">
          <span className="lm-stat"><b>{total}</b> values</span>
          <span className="lm-stat bad"><b>{unmapped}</b> unmapped</span>
          <span className="lm-stat good"><b>{total - unmapped}</b> mapped</span>
        </div>
        <div className="lm-controls">
          <div className="lm-search"><Search size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search value or location…" /></div>
          <select className="ctl" value={table} onChange={(e) => setTable(e.target.value)}>
            <option value="all">All tables (deduped)</option>
            {data.sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <select className="ctl" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="unmapped">Unmapped only</option>
            <option value="mapped">Mapped only</option>
            <option value="all">All</option>
          </select>
          <button className="btn" onClick={() => setAdding(true)}><Plus size={15} /> Add location</button>
          <button className="btn primary" onClick={apply} disabled={applying}>{applying ? "Applying…" : dirty ? "Apply changes" : "Apply"}</button>
        </div>
      </div>

      {applied && (
        <div className="card admin-card lm-applied">
          <div className="lm-applied-head">✓ Applied {applied.count} mapping{applied.count === 1 ? "" : "s"} — the dashboard cache was cleared and your aliases are now active in this app. Nothing was written to LocationMaster.</div>
        </div>
      )}

      <div className="card admin-card">
        <table className="dt admin-table lm-table">
          <thead><tr>
            <th className="dt-th l">Raw value</th><th className="dt-th l">Appears in</th>
            <th className="dt-th r">Rows</th><th className="dt-th l">Status</th><th className="dt-th l">This actually means…</th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.type + "::" + r.value + i} className={!r.mapped ? "lm-unmapped" : ""}>
                <td className="l"><span style={{ fontWeight: 700 }}>{r.value}</span><span className="lm-type">{r.type === "id" ? "ID" : "name"}</span></td>
                <td className="l lm-srcs">{[...new Set(r.sources)].join(", ")}</td>
                <td className="r num">{r.count.toLocaleString()}</td>
                <td className="l">{r.mapped
                  ? <span className="lm-badge ok">{r.overrideId ? "Mapped" : "Matched"}</span>
                  : <span className="lm-badge no">No mapping found</span>}</td>
                <td className="l">
                  <select className="lm-select" value={r.mappedTo?.id || ""} onChange={(e) => setMap(r, e.target.value)}>
                    <option value="">— choose location —</option>
                    {data.master.map((m) => <option key={m.id} value={m.id}>{m.id} · {m.loc}</option>)}
                  </select>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="dt-empty">No values match this filter</td></tr>}
          </tbody>
        </table>
      </div>

      <AnimatePresence>
        {adding && <AddLocationModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} onErr={onErr} />}
      </AnimatePresence>
    </>
  );
}

// ---- Data Sources: view/update the Power BI dataset ID per semantic model ----
const MODEL_LABEL = { main: "Main (SWiSH Analytics)", productmix: "Product Mix — BBT", mm: "Mishmash", tabel: "Tabel", shakir: "Shawarma Shakir", yelo: "Yelo Pizza", shared: "Shared (ETC — Chilli/Just C/Pattie/Slice)" };
const isGuid = (s) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test((s || "").trim());

// ---- Business Events: occasion dates used to align comparisons (§7) --------
// Seeded dates are ESTIMATES. Nothing here is treated as authoritative by the
// Compare page until an admin confirms it, because a wrong Eid date silently
// skews every year-on-year read built on top of it.
function BusinessEvents({ onErr }) {
  const [events, setEvents] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState("");

  const load = () => api("/api/admin/events").then((j) => { setEvents(j.events || []); setDirty(false); }).catch((e) => onErr && onErr(e.message));
  useEffect(load, []);

  const patch = (id, k, v) => { setEvents((list) => list.map((e) => (e.id === id ? { ...e, [k]: v } : e))); setDirty(true); setOk(""); };
  const addRow = () => {
    const y = new Date().getFullYear();
    setEvents((l) => [{ id: `event-${Date.now()}`, name: "", type: "Campaign", country: "KW", year: y, start: "", end: "", status: "estimated", notes: "", active: true }, ...l]);
    setDirty(true);
  };
  const remove = (id) => { setEvents((l) => l.filter((e) => e.id !== id)); setDirty(true); setOk(""); };
  const save = async () => {
    setSaving(true); setOk("");
    try { await api("/api/admin/events", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events }) });
      setDirty(false); setOk("Saved — the Compare page will use these dates."); load();
    } catch (e) { onErr && onErr(e.message); } finally { setSaving(false); }
  };

  if (!events) return <div className="card admin-card"><div className="dt-empty">Loading events…</div></div>;
  const estimated = events.filter((e) => e.status !== "confirmed").length;

  return (
    <div className="card admin-card">
      <div className="card-head">
        <span className="card-title">Business event calendar</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn" onClick={addRow}><Plus size={14} /> Add event</button>
          <button className="btn primary" onClick={save} disabled={!dirty || saving}>{saving ? "Saving…" : "Save changes"}</button>
        </div>
      </div>
      {estimated > 0 && (
        <div className="admin-err" style={{ background: "#FFFAEB", color: "#93370D", borderColor: "#FEDF89" }}>
          <AlertTriangle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
          {estimated} event{estimated > 1 ? "s are" : " is"} still marked <b>Estimated</b>. Comparisons using them show a warning until confirmed.
        </div>
      )}
      {ok && <div className="admin-err" style={{ background: "var(--pos-soft)", color: "var(--pos-ink)", borderColor: "transparent" }}>{ok}</div>}
      <div className="dt-wrap">
        <table className="dt">
          <thead><tr>
            <th className="dt-th l">Event</th><th className="dt-th l">Type</th><th className="dt-th l">Year</th>
            <th className="dt-th l">Start</th><th className="dt-th l">End</th><th className="dt-th l">Days</th>
            <th className="dt-th l">Status</th><th className="dt-th l">Notes</th><th className="dt-th l"></th>
          </tr></thead>
          <tbody>
            {events.length === 0 ? <tr><td className="dt-empty" colSpan={9}>No events yet</td></tr> : events.map((e) => {
              const days = e.start && e.end ? Math.round((Date.parse(e.end) - Date.parse(e.start)) / 86400000) + 1 : "";
              const bad = e.start && e.end && Date.parse(e.end) < Date.parse(e.start);
              return (
                <tr key={e.id}>
                  <td><input className="ctl" value={e.name} placeholder="Eid Al Fitr" onChange={(ev) => patch(e.id, "name", ev.target.value)} style={{ minWidth: 150 }} /></td>
                  <td>
                    <select className="ctl" value={e.type} onChange={(ev) => patch(e.id, "type", ev.target.value)}>
                      {["Religious", "National", "Campaign", "Promotion", "Other"].map((t) => <option key={t}>{t}</option>)}
                    </select>
                  </td>
                  <td><input className="ctl" type="number" value={e.year} onChange={(ev) => patch(e.id, "year", Number(ev.target.value))} style={{ width: 84 }} /></td>
                  <td><input className="ctl" type="date" value={e.start} onChange={(ev) => patch(e.id, "start", ev.target.value)} /></td>
                  <td><input className="ctl" type="date" value={e.end} onChange={(ev) => patch(e.id, "end", ev.target.value)} style={bad ? { borderColor: "var(--red)" } : undefined} /></td>
                  <td className="num">{bad ? <span style={{ color: "var(--red-ink)" }}>invalid</span> : days}</td>
                  <td>
                    <select className="ctl" value={e.status} onChange={(ev) => patch(e.id, "status", ev.target.value)}
                      style={e.status === "confirmed" ? { borderColor: "var(--pos)", color: "var(--pos-ink)" } : { borderColor: "#FEDF89", color: "#B54708" }}>
                      <option value="estimated">Estimated</option>
                      <option value="confirmed">Confirmed</option>
                    </select>
                  </td>
                  <td><input className="ctl" value={e.notes || ""} placeholder="optional" onChange={(ev) => patch(e.id, "notes", ev.target.value)} style={{ minWidth: 130 }} /></td>
                  <td><button className="ic" title="Remove" onClick={() => remove(e.id)}><Trash2 size={14} /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="admin-sub" style={{ marginTop: 10 }}>
        Used by <b>Compare → Align to occasion</b>. Selecting an event snaps both periods to the same event-day sequence
        (Day 1 vs Day 1) and clips them to equal length, so Eid this year lines up with Eid last year regardless of the Gregorian dates.
      </p>
    </div>
  );
}

// ---- AOV Targets: monthly average-order-value target per brand -------------
// Orders Target = Sales Target (from the model) ÷ this AOV target. Channels of a
// brand inherit the brand's AOV target for their own Orders-vs-target read.
function AovTargets({ tree, onErr }) {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [month, setMonth] = useState(thisMonth);
  const [data, setData] = useState(null);     // { months }
  const [baseline, setBaseline] = useState({}); // brand / brand::channel -> 6-mo actual AOV
  const [channels, setChannels] = useState([]);
  const [draft, setDraft] = useState({});     // key -> string (in-progress edit)
  const [expanded, setExpanded] = useState({});
  const [savedFlash, setSavedFlash] = useState("");
  const brands = useMemo(() => (tree || []).map((t) => t.brand).filter(Boolean), [tree]);
  const keyOf = (brand, channel) => (channel ? `${brand}::${channel}` : brand);

  const load = () => api("/api/aov-targets").then((j) => setData(j)).catch((e) => onErr && onErr(e.message));
  useEffect(() => {
    load();
    api("/api/channels").then((j) => setChannels(j.channels || [])).catch(() => {});
    api("/api/aov-baseline").then((j) => setBaseline(j.map || {})).catch(() => {});
  }, []);
  const stored = (k) => (data && data.months && data.months[month] ? data.months[month][k] : undefined);
  const base = (k) => (baseline[k] != null ? Number(baseline[k]) : null);
  const curVal = (k) => (draft[k] !== undefined ? draft[k] : (stored(k) != null ? String(stored(k)) : ""));

  async function save(brand, channel, val) {
    const k = keyOf(brand, channel);
    const aov = val === "" ? null : Number(val);
    if (val !== "" && (!isFinite(aov) || aov <= 0)) return onErr && onErr("AOV must be a positive number");
    try {
      const j = await api("/api/aov-targets", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month, brand, channel: channel || undefined, aov }) });
      setData(j); setSavedFlash(k); setTimeout(() => setSavedFlash(""), 1200);
    } catch (e) { onErr && onErr(e.message); }
  }

  const cell = (brand, channel) => {
    const k = keyOf(brand, channel);
    const b = base(k);
    return (
      <input className="ctl" type="number" step="0.01" min="0" value={curVal(k)} placeholder={b != null ? b.toFixed(2) : (channel ? "(brand)" : "—")} style={{ width: 120, textAlign: "right" }}
        onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
        onBlur={(e) => { const v = e.target.value.trim(); const was = stored(k) != null ? String(stored(k)) : ""; if (v !== was) save(brand, channel, v); setDraft((d) => { const n = { ...d }; delete n[k]; return n; }); }}
        onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }} />
    );
  };
  const statusCell = (k) => (savedFlash === k ? <span className="st-on">Saved</span> : stored(k) != null ? <span className="lm-badge ok">Override</span> : base(k) != null ? <span className="lm-badge" style={{ background: "var(--chip)", color: "var(--muted)" }}>Auto {base(k).toFixed(2)}</span> : <span className="lm-badge no">—</span>);

  return (
    <div className="card admin-card">
      <div className="card-head">
        <span className="card-title">Monthly AOV targets</span>
        <label className="mfield" style={{ flexDirection: "row", alignItems: "center", gap: 8, margin: 0 }}>
          <span style={{ whiteSpace: "nowrap" }}>Month</span>
          <input className="ctl" type="month" value={month} onChange={(e) => { setMonth(e.target.value); setDraft({}); }} />
        </label>
      </div>
      {!data ? <div className="dt-empty">Loading targets…</div> : !brands.length ? <div className="dt-empty">No brands available</div> : (
        <table className="dt admin-table">
          <thead><tr>
            <th className="dt-th l">Brand / Channel</th>
            <th className="dt-th r">AOV Target (KD)</th>
            <th className="dt-th l">Status</th>
          </tr></thead>
          <tbody>
            {brands.map((b) => {
              const open = !!expanded[b];
              return (
                <React.Fragment key={b}>
                  <tr>
                    <td className="l" style={{ fontWeight: 700 }}>
                      {channels.length > 0 && <button className="ic" style={{ marginRight: 6 }} title={open ? "Hide channels" : "Set per-channel"} onClick={() => setExpanded((x) => ({ ...x, [b]: !x[b] }))}>{open ? "▾" : "▸"}</button>}
                      {b}
                    </td>
                    <td className="r">{cell(b, null)}</td>
                    <td className="l">{statusCell(b)}</td>
                  </tr>
                  {open && channels.map((c) => (
                    <tr key={b + "::" + c} className="aovt-chan">
                      <td className="l" style={{ paddingLeft: 34, color: "var(--muted)" }}>{c}</td>
                      <td className="r">{cell(b, c)}</td>
                      <td className="l">{statusCell(keyOf(b, c))}</td>
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="admin-sub" style={{ marginTop: 10 }}>
        Used on the landing page to compute <b>Orders Target</b> (Sales Target ÷ AOV Target) and the <b>Orders vs Target</b> / <b>AOV vs Target</b> KPIs.
        Targets default to each brand/channel's <b>last-6-month actual AOV</b> (shown as "Auto"); type a value to override. Expand a brand (▸) to set per-channel overrides. Channels with no override inherit the brand target.
      </p>
    </div>
  );
}

function DataSources({ onErr }) {
  const [models, setModels] = useState(null);
  const load = () => api("/api/admin/models").then((j) => setModels(j.models || {})).catch((e) => onErr && onErr(e.message));
  useEffect(load, []);
  if (!models) return <div className="card admin-card"><div className="dt-empty">Loading models…</div></div>;
  const keys = Object.keys(models);
  return (
    <div className="ds-grid">
      {keys.map((k) => <ModelCard key={k} mkey={k} m={models[k]} onErr={onErr} />)}
    </div>
  );
}

function ModelCard({ mkey, m, onErr }) {
  const [ds, setDs] = useState(m.datasetId || "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);   // { ok, error }
  const dirty = (ds || "").trim() !== (m.datasetId || "");
  async function save() {
    if (!isGuid(ds)) { setResult({ ok: false, error: "Not a valid GUID" }); return; }
    setBusy(true); setResult(null);
    try {
      const j = await api(`/api/admin/models/${mkey}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasetId: ds.trim() }) });
      m.datasetId = j.datasetId;
      setResult(j.test && j.test.ok ? { ok: true } : { ok: false, error: (j.test && j.test.error) || "Saved, but connection test failed" });
    } catch (e) { setResult({ ok: false, error: e.message }); onErr && onErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="card ds-card">
      <div className="ds-head">
        <div><b>{MODEL_LABEL[mkey] || mkey}</b>{m.brand && <span className="ds-brand">{m.brand}</span>}</div>
        <span className="ds-key">{mkey}</span>
      </div>
      <div className="ds-field">
        <span>Dataset ID</span>
        <input value={ds} onChange={(e) => { setDs(e.target.value); setResult(null); }} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" spellCheck={false} className={!ds || isGuid(ds) ? "" : "ds-bad"} />
      </div>
      {m.workspaceId && <div className="ds-meta">Workspace: <code>{m.workspaceId}</code></div>}
      <div className="ds-foot">
        {result && (result.ok ? <span className="ds-ok"><CheckIcon size={13} /> Connected</span> : <span className="ds-err">✕ {result.error}</span>)}
        <div style={{ flex: 1 }} />
        <button className="btn primary" onClick={save} disabled={busy || !dirty}>{busy ? "Testing…" : "Save & test"}</button>
      </div>
    </div>
  );
}

function AddLocationModal({ onClose, onSaved, onErr }) {
  const [id, setId] = useState("");
  const [loc, setLoc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function save() {
    setErr("");
    if (!id.trim() || !loc.trim()) return setErr("Both LocationID and name are required");
    setBusy(true);
    try {
      await api("/api/admin/locations/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locationId: id.trim(), location: loc.trim() }) });
      onSaved();
    } catch (e) { setErr(e.message); onErr && onErr(e.message); } finally { setBusy(false); }
  }
  return (
    <>
      <motion.div className="modal-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div className="modal" style={{ width: "min(420px,94vw)" }} initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12 }} transition={{ duration: 0.18 }}>
        <div className="modal-head"><b>Add location</b><button className="ic" onClick={onClose}><X size={16} /></button></div>
        <div className="modal-body">
          <div className="mform" style={{ gridTemplateColumns: "1fr" }}>
            <label className="mfield"><span>LocationID</span><input value={id} onChange={(e) => setId(e.target.value.toUpperCase())} placeholder="e.g. SAL" maxLength={12} /></label>
            <label className="mfield"><span>Location name</span><input value={loc} onChange={(e) => setLoc(e.target.value)} placeholder="e.g. Salmiya" /></label>
          </div>
          <p className="mscope-hint">This adds a location to the mapping dropdown. It lives in the app; add it to the Power BI LocationMaster too so it flows through the model.</p>
        </div>
        {err && <div className="modal-err">{err}</div>}
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Add location"}</button>
        </div>
      </motion.div>
    </>
  );
}

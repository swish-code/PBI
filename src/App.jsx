import React, { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { LayoutDashboard, Gauge, BarChart3, Activity, ShieldCheck, LogOut, ChevronDown, FlaskConical, GitCompareArrows, MessageSquare, Package, Sun, Moon, MapPin, AlertTriangle, X, Smartphone, SlidersHorizontal } from "lucide-react";
import { PageSwap, LiveDot, BrandSelect, SourceSelect, Skeleton, CompanyMark, Term } from "./ui.jsx";
import DateControl from "./DateControl.jsx";
import { selQuery, presetLabel, fmt, activeComparisons } from "./dates.js";
import LoginPage from "./LoginPage.jsx";
import VizMenu from "./VizMenu.jsx";
import { NotificationBell, RatingPromptHost, BrandFooter, usePageVisit, PeriodicFeedback } from "./engagement.jsx";
import LearnGuide from "./LearnGuide.jsx";
import AssistantPanel, { AssistantOrb } from "./AssistantPanel.jsx";
import VoiceModal from "./VoiceModal.jsx";
import NarrationModal, { NarrationButton } from "./NarrationModal.jsx";
import { DebugLayer, Inspector, DebugToggle } from "./DebugPanel.jsx";

// Pages are lazy-loaded so the initial bundle only carries the shell + the
// first page a user lands on. Navigating to another page fetches its chunk on
// demand (charts/grids come with it), which keeps first paint fast. The chunks
// are then preloaded during idle time (see App) so navigation feels instant.
const PAGE_IMPORTS = {
  landing: () => import("./LandingPage.jsx"),
  compare: () => import("./ComparePage.jsx"),
  runrate: () => import("./RunratePage.jsx"),
  operations: () => import("./OperationsPage.jsx"),
  productmix: () => import("./ProductMixPage.jsx"),
  yelomix: () => import("./YeloProductMix.jsx"),
  sharedmix: () => import("./SharedProductMix.jsx"),
  brandtiles: () => import("./BrandTiles.jsx"),
  analysislab: () => import("./AnalysisLab.jsx"),
  overview: () => import("./OverviewPage.jsx"),
  locations: () => import("./LocationsPage.jsx"),
  admin: () => import("./AdminPage.jsx"),
  engagement: () => import("./AdminEngagement.jsx"),
};
const LandingPage = lazy(PAGE_IMPORTS.landing);
const ComparePage = lazy(PAGE_IMPORTS.compare);
const RunratePage = lazy(PAGE_IMPORTS.runrate);
const OperationsPage = lazy(PAGE_IMPORTS.operations);
const ProductMixPage = lazy(PAGE_IMPORTS.productmix);
const YeloProductMix = lazy(PAGE_IMPORTS.yelomix);
const SharedProductMix = lazy(PAGE_IMPORTS.sharedmix);
const BrandTiles = lazy(PAGE_IMPORTS.brandtiles);
const StoreLanding = lazy(() => import("./StoreLanding.jsx"));
// brands served by the shared ETC PMIX model (HEADER[CHAINID]); each shown separately
const SHARED_BRANDS = { "Chilli Pepper": "CHP", "Just C": "BUR", "Pattie Pattie": "PAT", "Slice": "SLC" };
const AnalysisLab = lazy(PAGE_IMPORTS.analysislab);
const OverviewPage = lazy(PAGE_IMPORTS.overview);
const LocationsPage = lazy(PAGE_IMPORTS.locations);
const AdminPage = lazy(PAGE_IMPORTS.admin);
const AdminEngagement = lazy(PAGE_IMPORTS.engagement);
// preload every page's JS chunk when the browser is idle, so switching tabs
// never waits on a chunk download (asset prefetch only — no Power BI calls)
function preloadPages() {
  const run = () => Object.values(PAGE_IMPORTS).forEach((fn) => fn().catch(() => {}));
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1500);
}

// lightweight fallback while a page chunk loads
function PageFallback() {
  return (
    <div className="page" style={{ display: "grid", gap: 14 }}>
      <Skeleton h={72} /><Skeleton h={220} />
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14 }}><Skeleton h={300} /><Skeleton h={300} /></div>
    </div>
  );
}

const NAV = [
  { id: "landing", label: "Dashboard", icon: LayoutDashboard },
  { id: "overview", label: "Sales Analysis", icon: BarChart3 },
  { id: "runrate", label: "Sales Run Rate", icon: Activity },
  { id: "productmix", label: "Product Mix", icon: Package },
  { id: "operations", label: "Operations", icon: Gauge },
  { id: "compare", label: "Compare", icon: GitCompareArrows },
  { id: "locations", label: "Locations", icon: MapPin },
  { id: "analysislab", label: "Analysis Lab", icon: FlaskConical },
];
const ROLE_LABEL = { admin: "Admin", ceo: "CEO", gm: "General Manager", opsmgr: "Operations Manager", area: "Area Manager", store: "Store User", ops_director: "Ops Director", ops: "Operation Manager", marketing: "Marketing" };
// map the auth role to the page-behaviour role (attention dimension / scope picker)
// map the auth role → in-page behaviour role (scope picker / attention dimension)
const pageRole = (r) => (r === "area" ? "area" : (r === "ops" || r === "opsmgr") ? "ops" : r === "store" ? "store" : "gm");
// map the auth role → which landing layout to render
const roleView = (r) => (r === "store" ? "store" : (r === "ops" || r === "opsmgr" || r === "area") ? "area" : "ceo");

// Catches a page render crash so the app shows a readable error + Reload instead
// of a blank white screen (and surfaces the real cause). Resets on tab change.
class PageErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) {
    console.error("Page crash:", err, info);
    // AG Grid can throw while it tears itself down as you navigate AWAY from a grid
    // page; that error surfaces on the page you just opened but doesn't actually affect
    // it. Recover instead of showing the crash screen for these.
    const s = String((err && err.stack) || (err && err.message) || "");
    if (/aggrid|ag-grid|ag_grid/i.test(s)) this.setState({ err: null });
  }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: null }); }
  render() {
    if (this.state.err) {
      const e = this.state.err;
      return (
        <div className="page-error">
          <h2>This page hit an error</h2>
          <p>{String((e && e.message) || e)}</p>
          <pre>{String((e && e.stack) || "").slice(0, 1200)}</pre>
          <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [me, setMe] = useState(undefined);          // undefined=loading, null=logged out, obj=user
  const [tab, setTab] = useState("landing");
  // per-tab date memory with tab-specific defaults: Runrate → complete current month, everything else → yesterday
  const monthRange = useMemo(() => {
    const n = new Date(), y = n.getFullYear(), m = n.getMonth(), p2 = (x) => String(x).padStart(2, "0");
    const last = new Date(y, m + 1, 0).getDate();
    return { preset: "custom", start: `${y}-${p2(m + 1)}-01`, end: `${y}-${p2(m + 1)}-${p2(last)}` };
  }, []);
  const defaultSel = useCallback((t) => (t === "runrate" ? monthRange : { preset: "yesterday" }), [monthRange]);
  const [selMap, setSelMap] = useState({});
  // MUST be memoized: defaultSel() returns a fresh object each call, so an
  // unmemoized `sel` would change identity every render and put every
  // sel-keyed fetch effect (range, landing, sales…) into an infinite loop.
  const sel = useMemo(() => selMap[tab] || defaultSel(tab), [selMap, tab, defaultSel]);
  const setSel = useCallback((s) => setSelMap((mm) => ({ ...mm, [tab]: typeof s === "function" ? s(mm[tab] || defaultSel(tab)) : s })), [tab, defaultSel]);
  const [resolved, setResolved] = useState(null);
  const [source, setSource] = useState("");
  const [brand, setBrand] = useState("all");
  const [brands, setBrands] = useState([]);
  const [orderSource, setOrderSource] = useState("all");   // global Order Source filter (Dashboard + Sales Analysis)
  const [channels, setChannels] = useState([]);
  const [asOpen, setAsOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [narrationOpen, setNarrationOpen] = useState(false);
  // Mobile-preview: renders the whole app inside a phone-sized iframe so the real
  // mobile CSS (viewport media queries) applies. `inFrame` = we ARE the iframe.
  const inFrame = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("phoneframe");
  const [phonePreview, setPhonePreview] = useState(false);
  const [mFilters, setMFilters] = useState(false);   // mobile: filters collapsed behind a button
  // voice/text assistant command handler → returns a short spoken confirmation
  const handleAssistantCommand = useCallback((intent) => {
    if (intent.type === "nav") {
      const t = NAV.find((n) => n.id === intent.page);
      setTab(intent.page);
      return `Opening ${t ? t.label : intent.page}.`;
    }
    if (intent.type === "brand") {
      setBrand(intent.brand);
      return intent.brand === "all" ? "Showing all brands." : `Switched to ${intent.brand}.`;
    }
    if (intent.type === "date") {
      setSel({ preset: intent.preset });
      return `Showing ${presetLabel({ preset: intent.preset })}.`;
    }
    return null;
  }, [setTab, setBrand, setSel]);
  const [debug, setDebug] = useState(false);
  const [inspectViz, setInspectViz] = useState(null);
  const [previewRole, setPreviewRole] = useState("ceo");   // admin "preview as" role
  const [refreshKey, setRefreshKey] = useState(0);         // bump to re-fetch visuals after a save
  const [toast, setToast] = useState("");
  // saved choice wins; otherwise follow the OS. Read lazily so there's no flash of
  // the wrong theme on first paint.
  const [theme, setTheme] = useState(() => {
    try { const s = localStorage.getItem("bpa-theme"); if (s === "dark" || s === "light") return s; } catch {}
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [forcedRating, setForcedRating] = useState(null);   // {id,...} from a notification click
  const [expired, setExpired] = useState(false);            // session expired → show hint on login
  const [showNotice, setShowNotice] = useState(false);      // one-time testing-phase notice
  usePageVisit(tab);                                         // log page visits + dwell time

  useEffect(() => { fetch("/api/me", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => setMe(null)); }, []);
  // Expired-session handling: if any authed /api call 401s while we have a session,
  // drop to the login screen with a clear message (instead of silent broken pages).
  const meRef = useRef(me); useEffect(() => { meRef.current = me; }, [me]);
  useEffect(() => {
    const orig = window.fetch;
    window.fetch = async (...args) => {
      const res = await orig(...args);
      try {
        const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        if (res.status === 401 && url.includes("/api/") && !/\/api\/(login|auth)/.test(url) && meRef.current) {
          setExpired(true); setMe(null);
        }
      } catch { /* observe only */ }
      return res;
    };
    return () => { window.fetch = orig; };
  }, []);
  // show the testing-phase notice once per browser session, after login
  useEffect(() => {
    if (!me) return;
    try { if (!sessionStorage.getItem("bpa-testing-ack")) setShowNotice(true); } catch { setShowNotice(true); }
  }, [me]);
  const dismissNotice = () => { setShowNotice(false); try { sessionStorage.setItem("bpa-testing-ack", "1"); } catch {} };
  useEffect(() => { document.title = "SWiSH Analytics — Business Performance & Analytics"; }, []);
  // light/dark — the toggle lives in React state (not just the DOM attribute) so
  // flipping it re-renders the tree; chart options are rebuilt on render and read
  // the CSS vars live, which is how ECharts follows the theme.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("bpa-theme", theme); } catch { /* private mode */ }
  }, [theme]);
  // follow the OS only while the user hasn't chosen for themselves
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e) => { try { if (!localStorage.getItem("bpa-theme")) setTheme(e.matches ? "dark" : "light"); } catch {} };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  // per-brand accent theme — recolours the whole app via CSS vars (SWiSH green by default)
  useEffect(() => {
    const map = { "Yelo Pizza": "yelo", "BBT": "red", "Shawarma Shakir": "red", "Slice": "red", "Mishmash": "mishmash", "Tabel": "tabel", "Chilli Pepper": "chilli", "Just C": "justc" };
    const t = map[brand];
    if (t) document.documentElement.setAttribute("data-brand", t);
    else document.documentElement.removeAttribute("data-brand");
  }, [brand]);
  useEffect(() => { if (me) preloadPages(); }, [me]);   // warm page chunks on idle for instant navigation
  useEffect(() => { if (!me) return; fetch("/api/status").then((r) => r.json()).then((j) => setSource(j.source)).catch(() => {}); }, [me]);
  useEffect(() => {
    if (!me) return;
    fetch("/api/brands", { credentials: "include" }).then((r) => r.json()).then((j) => {
      const bs = j.brands || [];
      setBrands(bs);
      // single-brand access → no "All Brands"; land directly on that brand
      setBrand(bs.length === 1 ? bs[0] : "all");
    }).catch(() => setBrand("all"));
  }, [me]);
  // order sources that actually traded in the selected period (+ brand) — nothing "stupid"
  useEffect(() => {
    if (!me) return;
    const qs = selQuery(sel) + (brand && brand !== "all" ? "&brand=" + encodeURIComponent(brand) : "");
    fetch(`/api/viz/landing_channels?${qs}`, { credentials: "include" }).then((r) => r.json())
      .then((j) => { const list = (j.rows || []).map((x) => x.label).filter(Boolean); setChannels(list); if (orderSource !== "all" && !list.includes(orderSource)) setOrderSource("all"); })
      .catch(() => {});
  }, [me, sel, brand]);
  useEffect(() => {
    if (!me) return;
    let live = true;
    fetch(`/api/range?${selQuery(sel)}`).then((r) => r.json()).then((j) => live && setResolved(j)).catch(() => {});
    return () => { live = false; };
  }, [sel, me]);

  if (me === undefined) return <div className="boot"><span className="side-mark">◆</span></div>;
  if (!me) return <LoginPage onLogin={(u) => { setExpired(false); setMe(u); }} expired={expired} />;

  const nav = me.isAdmin ? [...NAV, { id: "engagement", label: "Engagement", icon: MessageSquare }, { id: "admin", label: "Admin", icon: ShieldCheck }] : NAV;
  const active = nav.find((t) => t.id === tab) || NAV[0];
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const role = pageRole(me.role);
  // Landing has just two layouts:
  //   CEO view   → admin/CEO, GM, Marketing (portfolio, brand-centric)
  //   Area view  → Operations, Area Manager, Store Manager (branch-centric)
  const view = roleView(me.role);

  async function logout() { await fetch("/api/logout", { method: "POST", credentials: "include" }).catch(() => {}); setMe(null); }

  const greetWord = (() => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; })();
  return (
    <div className="app">
    <div className="shell">
      <aside className="rail">
        <div className="rail-mark"><CompanyMark size={36} /></div>
        <nav className="rail-nav">
          {nav.map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.id} className={`rail-item ${tab === t.id ? "on" : ""}`} title={t.label} onClick={() => setTab(t.id)}>
                <Icon size={19} />
              </button>
            );
          })}
        </nav>
        <div style={{ flex: 1 }} />
        <div className="rail-foot"><LiveDot beat={source === "live"} /></div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="brand-id"><CompanyMark size={32} /><div className="brand-name"><b>SWiSH Analytics</b><span>Business Performance &amp; Analytics</span></div></div>
          <div className="spacer" />
          <ComparisonLegend sel={sel} resolved={resolved} />
          {/* mobile-only: a single Filters button toggles the panel below */}
          <button className={`ctl filters-toggle${mFilters ? " on" : ""}`} onClick={() => setMFilters((v) => !v)} title="Filters">
            <SlidersHorizontal size={15} /> <span>Filters</span>
          </button>
          <div className={`topbar-filters${mFilters ? " open" : ""}`}>
            <DateControl sel={sel} resolved={resolved} onChange={setSel} />
            <BrandSelect value={brand} brands={brands} onChange={setBrand} />
            {(tab === "landing" || tab === "overview") && (
              <SourceSelect value={orderSource} sources={channels} onChange={setOrderSource} />
            )}
            {me.isAdmin && <DebugToggle on={debug} onToggle={() => setDebug((d) => !d)} />}
            {me.isAdmin && debug && (
              <select className="ctl dbg-preview" value={previewRole} onChange={(e) => setPreviewRole(e.target.value)} title="Preview the dashboard as a role">
                <option value="ceo">Preview as: CEO / GM view</option>
                <option value="area">Preview as: Ops / Area view</option>
                <option value="store">Preview as: Store view</option>
              </select>
            )}
          </div>
          <ThemeToggle theme={theme} onToggle={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} />
          {!inFrame && <button className="ctl icon-ctl phone-preview-btn" onClick={() => setPhonePreview(true)} title="Preview the mobile / iPhone layout"><Smartphone size={16} /></button>}
          <NotificationBell onRate={(id, page) => { if (page) setTab(page); setForcedRating({ id }); }} />
          <UserMenu me={me} onLogout={logout} />
        </header>
        {/* mobile: tap the dimmed backdrop to close the Filters panel */}
        {mFilters && <div className="mfilters-scrim" onClick={() => setMFilters(false)} />}

        <div className="main-scroll">
        <AnimatePresence>
          {showNotice && (
            <motion.div className="test-notice" role="status"
              initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }}>
              <AlertTriangle size={16} className="test-notice-ic" />
              <span className="test-notice-txt"><b>Testing phase.</b> Some data, calculations, or features may contain errors. Please verify critical information before taking action.</span>
              <button className="test-notice-x" onClick={dismissNotice} aria-label="Dismiss"><X size={15} /></button>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="pagehead">
          <div className="pagehead-txt">
            {tab === "landing"
              ? <><h1>{greetWord}, {me.name.split(" ")[0]}</h1><p>Stay on top of your brands — monitor performance, sales &amp; product mix.</p></>
              : <><h1>{active.label}</h1><p>{today}</p></>}
          </div>
          <div className="pagehead-actions">
            {tab === "landing" && <NarrationButton onClick={() => setNarrationOpen(true)} />}
            <span className={`live ${source === "live" ? "" : "mock"}`}>
              <LiveDot beat={source === "live"} /> {source === "live" ? "Live Power BI" : source === "mock" ? "Sample data" : "Connecting…"}
            </span>
          </div>
        </div>

        <PageSwap id={tab}>
          <PageErrorBoundary resetKey={tab}>
          <Suspense fallback={<PageFallback />}>
            {tab === "landing" ? ((me.isAdmin && debug ? previewRole : view) === "store"
                ? <StoreLanding sel={sel} resolved={resolved} brand={(Array.isArray(me.scope?.brands) && me.scope.brands[0]) || brand} userName={me.name} store={(Object.values(me.scope?.locations || {})[0] || [])[0] || ""} />
                : <LandingPage sel={sel} resolved={resolved} role={role} brand={brand} view={me.isAdmin && debug ? previewRole : view} asRole={me.isAdmin && debug ? previewRole : undefined} refreshKey={refreshKey} userName={me.name} source={orderSource} onOpenPage={(pg, br) => { if (br && br !== "all") setBrand(br); setTab(pg); }} />)
              : tab === "operations" ? <OperationsPage sel={sel} role={role} brand={brand} canSetTargets={(me.role === "admin" || me.role === "ops_director") && !debug} />
              : tab === "compare" ? <ComparePage brand={brand} />
              : tab === "runrate" ? <RunratePage sel={sel} brand={brand} role={role} />
              : tab === "productmix" ? (!brand || brand === "all" ? <BrandTiles sel={sel} onPick={setBrand} /> : brand === "Yelo Pizza" ? <YeloProductMix sel={sel} isAdmin={me.isAdmin} role={me.role} /> : SHARED_BRANDS[brand] ? <SharedProductMix sel={sel} chain={SHARED_BRANDS[brand]} isAdmin={me.isAdmin} role={me.role} /> : <ProductMixPage sel={sel} brand={brand} isAdmin={me.isAdmin} role={me.role} />)
              : tab === "locations" ? <LocationsPage brand={brand} sel={sel} />
              : tab === "analysislab" ? <AnalysisLab sel={sel} brand={brand} userName={me.name} />
              : tab === "engagement" ? <AdminEngagement />
              : tab === "admin" ? <AdminPage />
              : <OverviewPage sel={sel} brand={brand} source={orderSource} />}
          </Suspense>
          </PageErrorBoundary>
        </PageSwap>
        <BrandFooter />
        </div>
      </main>

      <AssistantOrb onOpen={() => setAsOpen(true)} onVoice={() => setVoiceOpen(true)} />
      <AssistantPanel open={asOpen} onClose={() => setAsOpen(false)}
        context={{ page: tab, sel, brand, brands, role }}
        onCommand={handleAssistantCommand} />
      <VoiceModal open={voiceOpen} onClose={() => setVoiceOpen(false)}
        context={{ page: tab, sel, brand, brands, role }}
        onCommand={handleAssistantCommand} />
      <NarrationModal open={narrationOpen} onClose={() => setNarrationOpen(false)}
        context={{ page: tab, sel, brand, brands, role, userName: me.name }} />
      <RatingPromptHost page={tab} sel={sel} forcedId={forcedRating?.id} onDone={() => setForcedRating(null)} />
      <LearnGuide page={tab} />
      <PeriodicFeedback />

      {phonePreview && !inFrame && (
        <div className="phone-preview-overlay" onClick={() => setPhonePreview(false)}>
          <div className="phone-preview-inner" onClick={(e) => e.stopPropagation()}>
            <div className="phone-preview-bar">
              <Smartphone size={15} /> <span>iPhone preview</span>
              <button className="phone-preview-x" onClick={() => setPhonePreview(false)} aria-label="Close"><X size={16} /></button>
            </div>
            <div className="phone-frame">
              <iframe title="Mobile preview" className="phone-frame-iframe"
                src={(window.location.pathname || "/") + "?phoneframe=1"} />
            </div>
          </div>
        </div>
      )}
      <VizMenu sel={sel} brand={brand} page={tab} />
      {me.isAdmin && <DebugLayer active={debug} onInspect={setInspectViz} />}
      {me.isAdmin && inspectViz && (
        <Inspector viz={inspectViz} role={previewRole} onClose={() => setInspectViz(null)}
          onSaved={(r) => { setRefreshKey((k) => k + 1); setToast("Saved for " + ({ ceo: "CEO", gm: "GM", area: "Area Manager" }[r] || r)); setTimeout(() => setToast(""), 2600); }}
          params={{ ...(sel.preset === "custom" ? { start: sel.start, end: sel.end } : { preset: sel.preset || "today" }), brand: brand !== "all" ? brand : undefined }} />
      )}
      <AnimatePresence>
        {toast && <motion.div className="dbg-toast" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}>✓ {toast}</motion.div>}
      </AnimatePresence>
    </div>
    </div>
  );
}

// persistent legend: shows the exact comparison windows for the current date selection
function ComparisonLegend({ sel, resolved }) {
  const [open, setOpen] = useState(false);
  const comps = activeComparisons(resolved || {});
  const curText = resolved ? (resolved.start === resolved.end ? fmt(resolved.start) : `${fmt(resolved.start)} – ${fmt(resolved.end)}`) : "";
  return (
    <div className="cmp-legend" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button className="cmp-legend-btn" onClick={() => setOpen((o) => !o)}>
        <GitCompareArrows size={16} /> <span>Comparison periods</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="cmp-legend-pop" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.14 }}>
            <div className="cmp-legend-h">Comparisons · {presetLabel(sel)}</div>
            <div className="cmp-legend-row">
              <span className="cmp-dot cur" /><b>This period</b><span className="cmp-legend-dates">{curText}</span>
            </div>
            {comps.map((c) => (
              <div key={c.key} className={`cmp-legend-row ${c.key}`}>
                <span className={`cmp-dot ${c.key}`} /><b><Term k={c.short}>{c.short}</Term></b>
                <span className="cmp-legend-lbl">{c.label.replace(/^vs /, "")}</span>
                <span className="cmp-legend-dates">{c.rangeText}</span>
              </div>
            ))}
            <div className="cmp-legend-foot">Weekday-aligned · adapts to the selected range</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Light/dark switch. The icon shows what you'd GET, not the current state —
// a sun in dark mode means "click for light".
function ThemeToggle({ theme, onToggle }) {
  const dark = theme === "dark";
  return (
    <button
      className="ctl theme-tgl"
      onClick={onToggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-pressed={dark}
    >
      <span className="theme-tgl-ico">
        {dark ? <Sun size={15} /> : <Moon size={15} />}
      </span>
    </button>
  );
}

function UserMenu({ me, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, []);
  const initials = me.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return (
    <div className="usermenu" ref={ref}>
      <button className="usermenu-btn" onClick={() => setOpen((o) => !o)}>
        <span className="usermenu-av">{initials}</span>
        <span className="usermenu-name">{me.name}</span>
        <ChevronDown size={13} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="usermenu-pop" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.14 }}>
            <div className="usermenu-head"><b>{me.name}</b><span>{me.email}</span><span className="role-tag sm">{ROLE_LABEL[me.role]}</span></div>
            <button className="usermenu-item" onClick={onLogout}><LogOut size={14} /> Log out</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

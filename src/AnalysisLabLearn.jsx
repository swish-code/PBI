import React, { useState, useMemo, useRef } from "react";
import { ChevronLeft, Search, BarChart3, LineChart, PieChart, Table as TableIcon, Hash, Grid3x3 } from "lucide-react";

/* A figure callout — describes a UI area (no binary screenshots in-repo) */
const Fig = ({ label, children }) => (
  <div className="learn-fig"><div className="learn-fig-cap">{label}</div><div className="learn-fig-body">{children}</div></div>
);

const MEASURES = [
  ["💰", "Net Sales", "Total revenue in KD"],
  ["📦", "Orders", "Number of orders placed"],
  ["💵", "AOV", "Average order value (KD per order)"],
  ["🎯", "Target", "Sales goal for the period"],
  ["⏱️", "Avg Prep Time", "Minutes from order to ready"],
  ["🛵", "Avg Delivery Time", "Minutes from order to delivered"],
  ["⚠️", "Complaint Ratio", "% of orders with a complaint"],
  ["🚫", "Offline Rate", "% of time the store was offline"],
  ["⭐", "Avg Rating", "Average customer rating"],
];
const DIMS = [
  ["🏪", "Brand", "Group by restaurant brand"],
  ["📍", "Location", "Group by branch"],
  ["📱", "Channel", "Group by order source (Talabat, Keeta…)"],
  ["📅", "Date", "Group by day / trend over time"],
  ["🍕", "Complaint Category", "Group by complaint type"],
];
const CHARTS = [
  { icon: Hash, name: "Big Number", when: "Show ONE important metric clearly.", pick: "1 measure, no dimension", ex: "“Total Sales This Month”" },
  { icon: BarChart3, name: "Bar Chart", when: "Compare values across categories.", pick: "1 measure, 1 dimension", ex: "“Which brand has the most sales?”" },
  { icon: LineChart, name: "Line Chart", when: "Show a trend over time.", pick: "1 measure, dimension = Date", ex: "“Are sales going up or down?”" },
  { icon: PieChart, name: "Donut", when: "Show part-of-whole share.", pick: "1 measure, 1 dimension", ex: "“What % comes from each channel?”" },
  { icon: TableIcon, name: "Table", when: "See detailed numbers; sort & export.", pick: "1+ measures, 1 dimension", ex: "“All branches with sales & orders”" },
  { icon: LineChart, name: "Stacked Area", when: "Several measures over time.", pick: "2+ measures, dimension = Date", ex: "“Prep vs delivery time trend”" },
  { icon: Grid3x3, name: "Heatmap", when: "Two dimensions × one measure.", pick: "2 dimensions, 1 measure", ex: "“Prep time by location × hour”" },
];
const GLOSSARY = [
  ["Net Sales (KD)", "Total revenue in Kuwaiti Dinar.", "KD 287,000 = 287 thousand dinar"],
  ["Share %", "What percentage of the total this represents.", "20% = one-fifth of company sales"],
  ["Target (KD)", "The sales goal for the period.", "Target KD 300,000 vs actual KD 287,000"],
  ["Gap %", "Distance from target (+ ahead, − behind).", "−4.3% = 4.3% below target"],
  ["Runrate %", "% of the forecast daily run-rate achieved.", "91% = on track for 91% of forecast"],
  ["WoW", "Week-over-week: change vs last week.", "↑ 5.2% = up 5.2% from last week"],
  ["MoM", "Month-over-month: change vs last month.", "↓ 3.1% = down 3.1% from last month"],
  ["YoY", "Year-over-year: change vs same period last year.", "↑ 12.5% = up vs same month last year"],
  ["Orders", "Number of orders placed.", "1,234 individual orders"],
  ["AOV", "Average order value — spend per order.", "KD 5.55 per order on average"],
  ["Complaint Ratio", "% of orders that had a complaint.", "1.31% ≈ 1 complaint per 100 orders"],
  ["Avg Prep Time", "Average minutes from order to ready.", "9.5 min to prepare"],
  ["Avg Delivery Time", "Average minutes from order to delivered.", "34.7 min door-to-door"],
];
const FAQ = [
  ["Can I use multiple measures in one chart?", "Yes — pick up to 3. e.g. Net Sales + Orders + AOV in a grouped bar."],
  ["What if I don't see the measure I need?", "The analytics team controls the catalog — ask them to add it."],
  ["Can I delete a visual?", "Yes. In the editor, click the ✕ on the visual card, or open it and remove."],
  ["What's the difference between Save and Export?", "Save keeps it in Analysis Lab to edit later. Export downloads a CSV you can't edit in the Lab."],
  ["How often does data update?", "It's live from Power BI — it reflects the selected date range each time you run it."],
  ["Can I compare two periods on one chart?", "Add two visuals side-by-side (e.g. one filtered to June, one to May)."],
  ["What does a red number mean?", "Red = below target or declining. Green = above target or growing."],
];

const SECTIONS = [
  { id: "start", title: "Getting Started", keywords: "what is analysis lab overview intro" },
  { id: "first", title: "Create Your First Analysis", keywords: "step by step first tutorial create new add visual save" },
  { id: "understand", title: "Understanding the Builder", keywords: "measure dimension filter what is meaning" },
  { id: "charts", title: "Chart Types & When to Use", keywords: "bar line donut table big number heatmap scatter area when" },
  { id: "columns", title: "Column Reference (Glossary)", keywords: "net sales gap wow mom yoy aov runrate target share complaint definition glossary" },
  { id: "manage", title: "Save & Manage", keywords: "save rename delete reopen edit manage" },
  { id: "export", title: "Export & Share", keywords: "export csv excel pdf share link" },
  { id: "faq", title: "FAQ", keywords: "questions faq help red number" },
  { id: "tips", title: "Tips & Tricks", keywords: "tips best practice naming" },
  { id: "examples", title: "Example Analyses", keywords: "template examples dashboard brand operations pulse" },
];

export default function LearnPage({ onBack, onStartTour }) {
  const [q, setQ] = useState("");
  const refs = useRef({});
  const jump = (id) => refs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
  const ql = q.trim().toLowerCase();
  const match = (s) => !ql || (s.title + " " + s.keywords).toLowerCase().includes(ql);
  const visible = useMemo(() => SECTIONS.filter(match), [ql]);
  const show = (id) => visible.some((s) => s.id === id);

  return (
    <div className="learn">
      <div className="alab-toolbar">
        <button className="btn" onClick={onBack}><ChevronLeft size={15} /> Back</button>
        <div className="alab-brand">Analysis Lab <span className="alab-sub">Learn & User Manual</span></div>
        <div className="spacer" />
        {onStartTour && <button className="btn primary" onClick={onStartTour}>▶ Start Interactive Tour</button>}
        <div className="alab-search learn-search"><Search size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search guides (e.g. “how to save”)" /></div>
      </div>

      <div className="learn-grid">
        <nav className="learn-toc">
          <div className="learn-toc-h">Contents</div>
          {SECTIONS.map((s) => <button key={s.id} className={`learn-toc-i ${match(s) ? "" : "dim"}`} onClick={() => jump(s.id)}>{s.title}</button>)}
        </nav>

        <div className="learn-main">
          {visible.length === 0 && <div className="learn-empty">No guides match “{q}”.</div>}

          {show("start") && <section ref={(el) => (refs.current.start = el)} className="learn-sec">
            <h2>Getting Started</h2>
            <h3>What is Analysis Lab?</h3>
            <p>Analysis Lab is a self-service builder for creating your own charts and dashboards — <b>no coding needed</b>. You pick a <b>measure</b> (a number), optionally a <b>dimension</b> (a way to group it), and the chart builds <b>live</b>. Save it, reopen it any time, and export the data.</p>
            <Fig label="Landing page">A grid of your saved analyses as cards, with a prominent <b>“+ New Analysis”</b> button top-right and a <b>Learn</b> link. Each card shows the name, the chart types inside, how many visuals, and the date.</Fig>
            <Fig label="Editor">Left: <b>Add Visual</b> + the list of visuals. Center: the <b>canvas</b> where your charts live. Top bar: analysis <b>name</b> (click to rename), <b>1/2/3-column</b> layout presets, and <b>Save</b>.</Fig>
          </section>}

          {show("first") && <section ref={(el) => (refs.current.first = el)} className="learn-sec">
            <h2>Create Your First Analysis</h2>
            <ol className="learn-steps">
              <li><b>Click “+ New Analysis”</b> on the landing page — the editor opens with an empty canvas.</li>
              <li><b>Click “Add Visual.”</b> A modal opens with the query builder.</li>
              <li><b>Pick a measure</b> — type “Net Sales” in the search box and click it. It appears as a pill.</li>
              <li><b>Add a dimension</b> — click the <b>Brand</b> chip under “Group / Filter by.”</li>
              <li><b>(Optional) filters</b> — narrow to specific brands, locations, or channels; the date range comes from the top date picker.</li>
              <li><b>Check the chart type</b> — the builder recommends one (“Bar Chart”); override it from the dropdown if you like. The <b>live preview</b> updates as you go.</li>
              <li><b>Click “Add to Analysis”</b> — the chart drops onto the canvas.</li>
              <li><b>Add more visuals</b> and arrange them — drag cards to reorder, use the width buttons (▏ ◧ ▭) to resize.</li>
              <li><b>Click “Save,”</b> name it (e.g. “Brand Performance Dashboard”), and it appears on the landing page.</li>
            </ol>
          </section>}

          {show("understand") && <section ref={(el) => (refs.current.understand = el)} className="learn-sec">
            <h2>Understanding the Builder</h2>
            <h3>What is a Measure?</h3>
            <p>A <b>number you want to analyze</b>. Pick measures that answer your question.</p>
            <div className="learn-iconlist">{MEASURES.map(([e, n, d]) => <div key={n} className="learn-il"><span className="learn-il-ic">{e}</span><span><b>{n}</b> — {d}</span></div>)}</div>
            <h3>What is a Dimension?</h3>
            <p>A <b>way to group or categorize</b> the data. Pick dimensions that help you understand it.</p>
            <div className="learn-iconlist">{DIMS.map(([e, n, d]) => <div key={n} className="learn-il"><span className="learn-il-ic">{e}</span><span><b>{n}</b> — {d}</span></div>)}</div>
            <h3>What are Filters?</h3>
            <p>Filters <b>narrow down</b> the data — e.g. “only Yelo Pizza,” “only Salmiya,” “only Talabat,” or a specific date range. Everything defaults to <b>All</b>; tick the boxes to focus.</p>
          </section>}

          {show("charts") && <section ref={(el) => (refs.current.charts = el)} className="learn-sec">
            <h2>Chart Types & When to Use Them</h2>
            <div className="learn-charts">{CHARTS.map((c) => { const Icon = c.icon; return (
              <div key={c.name} className="learn-chart"><div className="learn-chart-h"><Icon size={18} /><b>{c.name}</b></div>
                <div className="learn-chart-r"><span className="learn-k">When</span>{c.when}</div>
                <div className="learn-chart-r"><span className="learn-k">You pick</span>{c.pick}</div>
                <div className="learn-chart-r"><span className="learn-k">Example</span>{c.ex}</div>
              </div>); })}</div>
          </section>}

          {show("columns") && <section ref={(el) => (refs.current.columns = el)} className="learn-sec">
            <h2>Column Reference (Glossary)</h2>
            <table className="learn-table"><thead><tr><th>Column</th><th>What it means</th><th>Example</th></tr></thead>
              <tbody>{GLOSSARY.map(([c, m, e]) => <tr key={c}><td><b>{c}</b></td><td>{m}</td><td className="learn-ex">{e}</td></tr>)}</tbody></table>
          </section>}

          {show("manage") && <section ref={(el) => (refs.current.manage = el)} className="learn-sec">
            <h2>Save & Manage</h2>
            <p><b>Save:</b> click Save in the editor, give it a name, and it appears as a card on the landing page.</p>
            <p><b>Re-open:</b> click any card on the landing page — it opens in the editor with all its visuals.</p>
            <p><b>Rename:</b> in the editor, click the analysis name at the top, type a new one, press Enter, then Save.</p>
            <p><b>Edit a visual:</b> click a visual (in the sidebar list or its ✎ icon) to reopen the builder; Update Visual applies the change.</p>
            <p><b>Delete:</b> hover a card on the landing page and click the trash icon (confirm the prompt).</p>
          </section>}

          {show("export") && <section ref={(el) => (refs.current.export = el)} className="learn-sec">
            <h2>Export & Share</h2>
            <p><b>Export:</b> a visual’s Table view has an “Export to Excel” button that downloads the underlying rows as CSV.</p>
            <p><b>Share:</b> Admin/Marketing users can mark an analysis as <i>shared</i> so teammates see it (read-only) on their landing page, tagged “shared by [name].”</p>
          </section>}

          {show("faq") && <section ref={(el) => (refs.current.faq = el)} className="learn-sec">
            <h2>Frequently Asked Questions</h2>
            {FAQ.map(([q2, a]) => <div key={q2} className="learn-faq"><div className="learn-faq-q">{q2}</div><div className="learn-faq-a">{a}</div></div>)}
          </section>}

          {show("tips") && <section ref={(el) => (refs.current.tips = el)} className="learn-sec">
            <h2>Tips & Tricks</h2>
            <ul className="learn-tips">
              <li>Name analyses clearly — “Daily Sales Check,” not “Analysis 1.”</li>
              <li>Start simple — 1–2 visuals, then expand.</li>
              <li>Keep filters consistent — use the same period across visuals for a fair comparison.</li>
              <li>Arrange logically — big-number KPIs at top, detail tables at the bottom.</li>
              <li>Save often — a quick Save protects your layout.</li>
            </ul>
          </section>}

          {show("examples") && <section ref={(el) => (refs.current.examples = el)} className="learn-sec">
            <h2>Example Analyses</h2>
            <div className="learn-examples">
              <div className="learn-ex-card"><b>Brand Performance Dashboard</b><ul><li>Net Sales by Brand (Bar)</li><li>Sales Trend (Line, by Date)</li><li>Orders by Channel (Donut)</li></ul></div>
              <div className="learn-ex-card"><b>Operations Health Check</b><ul><li>Avg Prep Time by Location (Bar)</li><li>Complaint Rate by Date (Line)</li><li>Orders by Location (Table)</li></ul></div>
              <div className="learn-ex-card"><b>Daily Sales Pulse</b><ul><li>Net Sales (Big Number)</li><li>Orders (Big Number)</li><li>Sales by Channel (Donut)</li></ul></div>
            </div>
          </section>}
        </div>
      </div>
    </div>
  );
}

import React, { useMemo, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { Download } from "lucide-react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

// AG Grid styled to match the shared design system (green accent, Manrope, soft lines)
const agTheme = themeQuartz.withParams({
  accentColor: "#12B76A",
  fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif",
  fontSize: 12,
  headerFontWeight: 700,
  headerTextColor: "#6B7280",
  headerBackgroundColor: "#FAFBFC",
  borderColor: "#EDEFF2",
  rowHoverColor: "#FAFBFC",
  selectedRowBackgroundColor: "#E7F7EF",
  foregroundColor: "#1F2937",
  oddRowBackgroundColor: "#FFFFFF",
});

// Resolve a cell value + formatted text the same way AG Grid would (used by the
// plain-table fallback so it still shows real data if the grid ever throws).
function cellText(col, row) {
  let value = col.valueGetter ? (() => { try { return col.valueGetter({ data: row, node: { data: row } }); } catch { return row[col.field]; } })() : row[col.field];
  if (col.valueFormatter) { try { const t = col.valueFormatter({ value, data: row }); if (t != null) return t; } catch { /* fall through */ } }
  return value == null ? "" : String(value);
}

// If AG Grid itself throws on some edge-case data, don't take the whole page down —
// render a simple, styled HTML table with the same rows/columns instead.
class GridBoundary extends React.Component {
  constructor(p) { super(p); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { try { console.error("[AgTable] grid render failed, using fallback table:", err); } catch { /* ignore */ } }
  render() {
    if (!this.state.failed) return this.props.children;
    const { columns = [], rows = [] } = this.props;
    return (
      <div className="ag-fallback" style={{ overflow: "auto", height: "100%" }}>
        <table className="dt">
          <thead><tr>{columns.map((c, i) => <th key={i} className={/right/i.test(c.type || "") ? "r" : "l"}>{c.headerName || c.field}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{columns.map((c, ci) => <td key={ci} className={/right/i.test(c.type || "") ? "r" : "l"}>{cellText(c, r)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
}

export default function AgTable({ title, columns, rows, onRowClick, height = 340, filename = "export", activeKey, rowKey, rowHeight = 32, headerHeight = 36, pinnedBottomRows }) {
  const ref = useRef(null);
  const defaultColDef = useMemo(() => ({ sortable: true, resizable: true, flex: 1, minWidth: 88 }), []);
  const exportCsv = useCallback(() => ref.current?.api?.exportDataAsCsv({ fileName: `${filename}.csv` }), [filename]);
  const rowClass = useCallback((p) => (activeKey && rowKey && p.data && p.data[rowKey] === activeKey ? "ag-row-active" : ""), [activeKey, rowKey]);
  return (
    <div className="ag-card">
      <div className="card-head">
        <span className="card-title">{title}</span>
        <motion.button className="btn" whileTap={{ scale: 0.96 }} onClick={exportCsv} disabled={!rows?.length}>
          <Download size={13} /> Export to Excel
        </motion.button>
      </div>
      <div style={{ height, width: "100%" }}>
        <GridBoundary columns={columns} rows={rows}>
          <AgGridReact ref={ref} theme={agTheme} rowData={rows} columnDefs={columns} defaultColDef={defaultColDef}
            rowHeight={rowHeight} headerHeight={headerHeight} pinnedBottomRowData={pinnedBottomRows} suppressCellFocus getRowClass={rowClass}
            onRowClicked={onRowClick ? (e) => onRowClick(e.data) : undefined} />
        </GridBoundary>
      </div>
    </div>
  );
}

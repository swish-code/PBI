// Customizable "Home" — the landing acts as a per-user home screen. Users add
// any widget from the catalog (Customize → Hidden tray), move, resize, hide and
// save; everything persists per-user via WidgetGrid (dash="home").
import React, { useMemo } from "react";
import WidgetGrid from "./WidgetGrid.jsx";
import { HOME_WIDGETS } from "./homeWidgets.jsx";

export default function HomeScreen({ sel, brand, isAdmin = false, role = "" }) {
  const widgets = useMemo(() => HOME_WIDGETS.map((w) => ({
    id: w.id, title: w.title, defaultW: w.defaultW, sizes: w.sizes, defaultHidden: w.defaultHidden,
    meta: { viz: w.viz, page: w.page }, component: <w.Comp sel={sel} brand={brand} />,
  })), [sel, brand]);
  return (
    <div className="page wgw-home">
      <WidgetGrid dash="home" widgets={widgets} isAdmin={isAdmin} role={role} />
    </div>
  );
}

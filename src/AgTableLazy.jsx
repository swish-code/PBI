import React, { lazy, Suspense } from "react";
import { Skeleton } from "./ui.jsx";

// AG Grid is ~1.2 MB. Loading it lazily keeps it out of the initial page chunk
// (Landing / Operations / Analysis Lab) so KPIs and charts paint first; the grid
// streams in a moment later. Drop-in replacement for `import AgTable`.
const AgTable = lazy(() => import("./AgTable.jsx"));

export default function AgTableLazy(props) {
  return (
    <Suspense fallback={<Skeleton h={props.height || 340} />}>
      <AgTable {...props} />
    </Suspense>
  );
}

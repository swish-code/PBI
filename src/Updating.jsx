// ============================================================================
//  STALE-DATA GUARD
//  While a new filter/date selection is in flight, every page keeps the PREVIOUS
//  selection's rows in state (so the layout doesn't collapse). Rendering those
//  numbers unchanged is misleading — they read as current data for the new
//  filter. This blurs + locks the content and shows the brand mark until the
//  fresh payload lands.
//
//  Usage on a page root:
//    <div className={cls("page pmix", loading)}>
//      <UpdatingBar show={loading} brand={gbrand} />
//      ...
//
//  Anything that must stay interactive while loading (the filter bar itself)
//  gets `className="stays-live"` so the veil skips it.
// ============================================================================
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { BrandMark, CompanyMark } from "./ui.jsx";
import { brandColorOf } from "./logos.js";

// append the veil class to a page root's existing className
export const cls = (base, loading) => base + (loading ? " is-updating" : "");

const isAll = (b) => !b || b === "all";

// Clean, iOS-style loader: pulsing brand mark + a single quiet label. (The old
// rotating joke lines — "Counting the pennies" etc. — were removed on request.)
export function UpdatingBar({ show, label, brand = "all" }) {
  const text = label || "Loading";
  // the name shown in the SWiSH-Analytics gradient — brand name, or the app itself for all-brands
  const name = isAll(brand) ? "SWiSH Analytics" : brand;
  // the halo picks up the active brand's colour ("all" => SWiSH green)
  const glow = isAll(brand) ? "#12B76A" : brandColorOf(brand);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="upd-bar"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {/* same look as the startup splash: mark + gradient name + sweep bar */}
          <motion.div
            className="upd-card"
            style={{ "--upd-glow": glow }}
            initial={{ opacity: 0, y: 14, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.94 }}
            transition={{ type: "spring", stiffness: 420, damping: 28, mass: 0.8 }}
          >
            {/* the brand being loaded — pulsing halo in its own colour */}
            <span className="upd-logo">
              <span className="upd-ring" />
              <span className="upd-ring upd-ring-2" />
              {isAll(brand) ? <CompanyMark size={70} /> : <BrandMark name={brand} size={70} />}
            </span>

            <div className="upd-copy">
              {/* key => each new brand name cross-fades in rather than snapping */}
              <AnimatePresence mode="wait">
                <motion.h2
                  key={name}
                  className="upd-name"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.2 }}
                >
                  {name}
                </motion.h2>
              </AnimatePresence>
              <span className="upd-sub">{text}</span>
            </div>

            <span className="upd-track"><span className="upd-fill" /></span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

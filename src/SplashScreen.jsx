import React, { useEffect } from "react";
import { motion } from "framer-motion";
import { CompanyMark } from "./ui.jsx";

// Apple-style startup interface: the mark springs in, "Welcome to SWiSH Analytics"
// resolves from a blur, a hairline progress sweep runs, then the whole thing scales
// + blurs away to reveal the app. Shows once per page open.
export default function SplashScreen({ onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 2500); return () => clearTimeout(t); }, [onDone]);
  const ease = [0.22, 0.61, 0.24, 1];
  return (
    <motion.div className="splash" initial={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.08, filter: "blur(10px)" }} transition={{ duration: 0.65, ease }}>
      <motion.div className="splash-glow"
        initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 0.9, scale: 1 }} transition={{ duration: 1.6, ease }} />
      <div className="splash-inner">
        <motion.div className="splash-mark"
          initial={{ scale: 0.65, opacity: 0, y: 6 }} animate={{ scale: 1, opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 170, damping: 17, delay: 0.15 }}>
          <CompanyMark size={78} />
        </motion.div>
        <motion.div className="splash-copy"
          initial={{ opacity: 0, y: 12, filter: "blur(12px)", letterSpacing: "0.32em" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)", letterSpacing: "normal" }}
          transition={{ duration: 0.95, delay: 0.55, ease }}>
          <span className="splash-hi">Welcome to</span>
          <h1>SWiSH Analytics</h1>
          <span className="splash-sub">Business Performance &amp; Analytics</span>
        </motion.div>
        <motion.div className="splash-track"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.7, duration: 0.4 }}>
          <motion.span className="splash-fill"
            initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 1.7, delay: 0.7, ease: "easeInOut" }} />
        </motion.div>
      </div>
    </motion.div>
  );
}

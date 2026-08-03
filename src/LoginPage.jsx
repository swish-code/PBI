import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { LogIn, Lock, ChevronDown } from "lucide-react";
import { BrandMark, CompanyMark } from "./ui.jsx";

// SWiSH brand portfolio — shown as a logo strip at the bottom (like swishhh.net)
const BRANDS = ["Shawarma Shakir", "BBT", "Yelo Pizza", "Slice", "Just C", "Chilli Pepper", "Mishmash", "Tabel", "Pattie Pattie", "ForeverMore"];

// Original black basketball — inline SVG (self-contained), classic seam pattern + shading
function Basketball({ size = 190 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" aria-hidden>
      <defs>
        <radialGradient id="bbfill" cx="36%" cy="28%" r="82%">
          <stop offset="0%" stopColor="#3d3d3d" /><stop offset="42%" stopColor="#191919" /><stop offset="100%" stopColor="#000" />
        </radialGradient>
      </defs>
      <circle cx="100" cy="100" r="98" fill="url(#bbfill)" stroke="#000" strokeWidth="1" />
      {/* classic basketball seams */}
      <g fill="none" stroke="#4d4d4d" strokeWidth="2.6" strokeLinecap="round">
        <line x1="100" y1="3" x2="100" y2="197" />
        <line x1="4" y1="100" x2="196" y2="100" />
        <path d="M100 3 C 42 52, 42 148, 100 197" />
        <path d="M100 3 C 158 52, 158 148, 100 197" />
      </g>
      {/* soft top-left highlight for the sphere look */}
      <ellipse cx="70" cy="60" rx="36" ry="24" fill="#ffffff" opacity="0.07" transform="rotate(-25 70 60)" />
    </svg>
  );
}

// Microsoft logo (4-square) — inline so it works offline / under CSP
function MsLogo({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 21 21" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

export default function LoginPage({ onLogin, expired = false }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState(null);        // { microsoft: bool }
  const [showPw, setShowPw] = useState(false);  // reveal password form when MS is primary
  const [ballImg, setBallImg] = useState(true); // use the real photo if present, else SVG fallback

  useEffect(() => {
    fetch("/api/auth/config").then((r) => r.json()).then(setCfg).catch(() => setCfg({ microsoft: false }));
    // surface an error passed back from the Microsoft redirect (?authError=…)
    const p = new URLSearchParams(window.location.search);
    if (p.get("authError")) {
      setErr(p.get("authError"));
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ email, password: pw }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Login failed");
      onLogin(j.user);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const ms = cfg?.microsoft;

  return (
    <div className="login">
      {/* black basketball — enters from the left corner, big first bounce across, exits right.
          Uses the real photo at /logos/basketball.png if present, else a self-contained SVG. */}
      <motion.div className="login-bball" aria-hidden
        animate={{
          x: ["-16vw", "106vw"],
          y: ["6vh", "72vh", "4vh", "72vh", "34vh", "72vh", "54vh", "72vh"],
          rotate: [0, 1040],
        }}
        transition={{
          duration: 5.4, repeat: Infinity, repeatDelay: 0.4,
          x: { duration: 5.4, repeat: Infinity, repeatDelay: 0.4, ease: "linear" },
          rotate: { duration: 5.4, repeat: Infinity, repeatDelay: 0.4, ease: "linear" },
          y: {
            duration: 5.4, repeat: Infinity, repeatDelay: 0.4,
            times: [0, 0.16, 0.44, 0.6, 0.73, 0.83, 0.92, 1],
            ease: ["easeIn", "easeOut", "easeIn", "easeOut", "easeIn", "easeOut", "easeIn"],
          },
        }}>
        <div className="bball-inner">
          {ballImg
            ? <img src="/logos/basketball.png" alt="" className="bball-photo" onError={() => setBallImg(false)} draggable={false} />
            : <Basketball size={300} />}
        </div>
      </motion.div>

      {/* title / tagline — the real SWiSH logo + tagline, as on swishhh.net */}
      <motion.div className="login-hero" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <div className="login-wordmark">
          <CompanyMark size={52} />
          <div className="login-namecol">
            <b className="login-name">SWiSH Analytics</b>
            <span className="login-sub">Business Performance &amp; Analytics</span>
          </div>
        </div>
      </motion.div>

      <motion.div className="login-card"
        initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.5, ease: [0.22, 0.61, 0.24, 1] }}>
        <h1 className="login-title">Sign in</h1>
        <p className="login-hint">{ms ? "Use your company Microsoft account." : "Use your work email and password."}</p>

        {expired && !err && <div className="login-note">Your session expired. Please sign in again.</div>}
        {err && <div className="login-err">{err}</div>}

        {ms && (
          <>
            <button className="login-ms" onClick={() => { window.location.href = "/api/auth/microsoft/start"; }}>
              <MsLogo /> Sign in with Microsoft
            </button>
            <button className="login-altlink" onClick={() => setShowPw((s) => !s)}>
              <ChevronDown size={13} style={{ transform: showPw ? "rotate(180deg)" : "none", transition: "transform .15s" }} /> Administrator sign-in
            </button>
          </>
        )}

        {(!ms || showPw) && (
          <form className="login-pwform" onSubmit={submit}>
            <label className="login-field">
              <span>Email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@swishhh.net" autoFocus={!ms} required />
            </label>
            <label className="login-field">
              <span>Password</span>
              <div className="login-pw"><Lock size={14} /><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" required /></div>
            </label>
            <button className="login-btn" type="submit" disabled={busy}>
              <LogIn size={16} /> {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}

        <div className="login-foot">Secure session · your access is scoped to your role.</div>
      </motion.div>

      {/* brand portfolio strip at the bottom */}
      <motion.div className="login-brands" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25, duration: 0.5 }}>
        <span className="login-brands-lbl">Our brands</span>
        <div className="login-brandstrip">
          {BRANDS.map((b) => <span key={b} className="login-brandlogo" title={b}><BrandMark name={b} size={40} /></span>)}
        </div>
      </motion.div>
    </div>
  );
}

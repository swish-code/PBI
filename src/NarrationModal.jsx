import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, X, Volume2, VolumeX, RotateCcw } from "lucide-react";
import { presetLabel } from "./dates.js";
import { speak, stopSpeaking, ttsSupported, listVoices, setPreferredVoice, getPreferredVoice, primeSpeech } from "./voice.js";

// live list of the browser's English voices (Chrome loads them async)
function useVoiceList() {
  const [voices, setVoices] = useState(() => listVoices());
  useEffect(() => {
    const load = () => setVoices(listVoices());
    load();
    if ("speechSynthesis" in window) { window.speechSynthesis.onvoiceschanged = load; const t = setTimeout(load, 400); return () => clearTimeout(t); }
  }, []);
  return voices;
}

// SWiSH AI Narration — a full morning executive brief, read aloud. Opens on demand
// from the "SWiSH AI Narration" button; not a permanent dashboard section.
export default function NarrationModal({ open, onClose, context }) {
  const [state, setState] = useState({ phase: "idle" }); // idle | loading | ready | empty | error
  const [reading, setReading] = useState(true);
  const voices = useVoiceList();
  const [voiceUri, setVoiceUri] = useState(() => getPreferredVoice() || "");
  const reqId = useRef(0);
  const pickVoiceUri = (uri) => {
    setVoiceUri(uri); setPreferredVoice(uri);
    // preview: re-read the greeting (or a sample) in the new voice
    stopSpeaking();
    const sample = state.data?.greeting || "Good morning. This is how I sound.";
    speak(sample);
    setReading(true);
  };

  // Close = stop the voice immediately AND invalidate any in-flight fetch, so a
  // briefing that finishes loading after you've closed can't start talking.
  const stopAndClose = () => { reqId.current++; stopSpeaking(); onClose(); };

  useEffect(() => {
    if (!open) { reqId.current++; stopSpeaking(); setState({ phase: "idle" }); return; }
    const id = ++reqId.current;
    setState({ phase: "loading" });
    fetch("/api/narration", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ context: { ...context, periodLabel: presetLabel(context.sel) } }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (id !== reqId.current) return;
        if (j.error) { setState({ phase: "error", msg: j.error }); return; }
        if (j.empty) { setState({ phase: "empty", data: j }); if (reading && ttsSupported) speak(j.text); return; }
        setState({ phase: "ready", data: j });
        if (reading && ttsSupported) speak(j.text);
      })
      .catch(() => { if (id === reqId.current) setState({ phase: "error", msg: "I couldn't reach the briefing service. Is the server running?" }); });
    return () => stopSpeaking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") stopAndClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  // hard stop if the component ever unmounts while talking
  useEffect(() => () => stopSpeaking(), []);

  const data = state.data;
  const toggleRead = () => {
    if (reading) { stopSpeaking(); setReading(false); }
    else { setReading(true); if (data?.text) speak(data.text); }
  };
  const replay = () => { setReading(true); if (data?.text) speak(data.text); };

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="nrx-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={stopAndClose}>
          <motion.div className="nrx" role="dialog" aria-label="SWiSH AI Narration" onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}>
            <div className="nrx-head">
              <div className="nrx-title"><span className="nrx-logo"><Sparkles size={16} /></span>
                <div><b>SWiSH AI Narration <span className="beta-badge">BETA</span></b><span>{data ? `${data.brandLabel} · ${data.periodLabel}` : "Executive morning brief"}</span></div>
              </div>
              <div className="nrx-tools">
                {ttsSupported && state.phase === "ready" && <>
                  <button className="nrx-tool" onClick={toggleRead} title={reading ? "Mute" : "Read aloud"}>{reading ? <Volume2 size={15} /> : <VolumeX size={15} />}</button>
                  <button className="nrx-tool" onClick={replay} title="Replay"><RotateCcw size={15} /></button>
                </>}
                <button className="nrx-tool" onClick={stopAndClose} aria-label="Close"><X size={17} /></button>
              </div>
            </div>

            <div className="nrx-body">
              {ttsSupported && voices.length > 0 && (
                <div className="nrx-voicebar">
                  <span>Voice</span>
                  <select value={voiceUri} onChange={(e) => pickVoiceUri(e.target.value)}>
                    <option value="">Auto (softest available)</option>
                    {voices.map((v) => <option key={v.uri} value={v.uri}>{v.name} — {v.lang}</option>)}
                  </select>
                  <button className="nrx-voicetest" onClick={() => { stopSpeaking(); speak("Good morning. This is how I sound."); }}>Test</button>
                </div>
              )}
              {state.phase === "loading" && (
                <div className="nrx-loading">
                  <span className="nrx-orb"><Sparkles size={22} /></span>
                  <p>SWiSH AI is analysing yesterday’s business performance…</p>
                  <div className="nrx-bars"><i /><i /><i /><i /><i /></div>
                </div>
              )}
              {state.phase === "error" && <div className="nrx-msg nrx-err">{state.msg}</div>}
              {state.phase === "empty" && <div className="nrx-msg">{data?.text}</div>}
              {state.phase === "ready" && data && (
                <>
                  <div className="nrx-greeting">{data.greeting}</div>
                  <div className="nrx-sections">
                    {data.sections.map((s, i) => (
                      <motion.div key={i} className="nrx-sec" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
                        <div className="nrx-sec-t">{s.title}</div>
                        <div className="nrx-sec-x">{s.text}</div>
                      </motion.div>
                    ))}
                  </div>
                  <div className="nrx-foot">Composed live from your Power BI model, within your access scope. Figures are real; the narrative is generated.</div>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// the single top-of-page trigger button
export function NarrationButton({ onClick }) {
  return (
    <button className="nrx-trigger" onClick={() => { primeSpeech(); onClick && onClick(); }} title="Full AI executive briefing (beta)">
      <Sparkles size={15} /> <span>SWiSH AI Narration</span><span className="beta-badge beta-on-accent">BETA</span>
    </button>
  );
}

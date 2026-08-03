import React, { useState, useEffect, useRef, useMemo } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Sparkles, X, Send, Database, Mic, Volume2, VolumeX } from "lucide-react";
import { EChart, barOption, lineOption, donutOption } from "./ui.jsx";
import { kd, num, T } from "./theme.js";
import { presetLabel } from "./dates.js";
import { parseCommand, speak, stopSpeaking, ttsSupported, sttSupported, createRecognizer } from "./voice.js";

// suggested questions per page (contextual chips shown when the panel opens)
const CHIPS = {
  landing: ["How are we doing?", "Are we on target?", "Top brands", "What are my top complaint categories?", "What issues are we facing?", "Where should I focus today?", "Why are sales down?"],
  overview: ["How are we doing?", "Channel mix", "Which source is dropping?", "Are we on target?", "Top brands", "Where should I focus?"],
  operations: ["What are my top complaint categories?", "What issues are we facing?", "What's our prep & delivery time?", "What's our offline rate?", "Which items are hidden most?", "Where should I focus?"],
  runrate: ["Are we on target?", "How are we doing?", "Sales vs forecast", "Where should I focus?"],
  scorecard: ["Top brands", "How are we doing?", "Which branches are below target?", "Where should I focus?"],
};
const PAGE_NAME = { landing: "Command Center (landing)", overview: "Sales Analysis", runrate: "Run-rate", scorecard: "Brand Scorecard" };

// reveal text word-by-word (smooth streaming feel); instant under reduced-motion
function Streamed({ text, reduce, onTick }) {
  const words = useMemo(() => text.split(/(\s+)/), [text]);
  const [n, setN] = useState(reduce ? words.length : 0);
  useEffect(() => {
    if (reduce) { setN(words.length); return; }
    setN(0);
    let i = 0;
    const id = setInterval(() => {
      i += 2; setN(i); onTick && onTick();
      if (i >= words.length) clearInterval(id);
    }, 16);
    return () => clearInterval(id);
  }, [text, reduce, words.length]);
  return <>{words.slice(0, n).join("")}</>;
}

function MiniChart({ chart }) {
  const fmt = chart.unit === "KD" ? kd : chart.unit === "%" ? (v) => v + "%" : num;
  const data = chart.data.map((d, i) => ({ label: d.label, value: d.value, x: d.label, color: T.cat[i % T.cat.length] }));
  const opt = chart.type === "line" ? lineOption({ data, fmt, color: T.green })
    : chart.type === "donut" ? donutOption({ data, fmt, colors: data.map((d) => d.color) })
    : barOption({ data, horizontal: true, fmt, colors: data.map((d) => d.color) });
  return (
    <div className="as-chart">
      {chart.title && <div className="as-chart-title">{chart.title}</div>}
      <EChart height={Math.max(150, Math.min(240, data.length * 30 + 40))} option={opt} />
    </div>
  );
}

function Bubble({ m, reduce, onTick }) {
  if (m.role === "user") return <div className="as-msg user"><div className="as-b">{m.content}</div></div>;
  return (
    <div className="as-msg bot">
      <div className="as-avatar"><Sparkles size={13} /></div>
      <div className="as-b">
        {m.pending ? <span className="as-typing"><i /><i /><i /></span>
          : <><div className="as-text">{m.streamed ? <Streamed text={m.content} reduce={reduce} onTick={onTick} /> : m.content}</div>
            {m.chart && <MiniChart chart={m.chart} />}
            {m.sources?.length > 0 && (
              <div className="as-sources"><Database size={11} /><span>from</span>{m.sources.slice(0, 4).map((s) => <span key={s} className="as-src">{s.replace(/^SUM\(|\)$/g, "").replace(/'/g, "")}</span>)}</div>
            )}</>}
      </div>
    </div>
  );
}

export default function AssistantPanel({ open, onClose, context, onCommand, autoListen, onAutoListenConsumed }) {
  const reduce = useReducedMotion();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [ttsOn, setTtsOn] = useState(() => { try { return localStorage.getItem("voiceTts") !== "0"; } catch { return true; } });
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [proactive, setProactive] = useState(null);   // auto "where to focus" on open
  const recRef = useRef(null);
  const scroller = useRef(null);
  const chips = CHIPS[context.page] || CHIPS.landing;

  const toBottom = () => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; };
  useEffect(() => { toBottom(); }, [messages, open]);
  useEffect(() => { try { localStorage.setItem("voiceTts", ttsOn ? "1" : "0"); } catch { /* ignore */ } }, [ttsOn]);
  // stop any voice when the panel closes
  useEffect(() => { if (!open) { stopSpeaking(); recRef.current?.stop?.(); setListening(false); setInterim(""); } }, [open]);
  // proactive: on open (blank chat), quietly fetch "where should I focus" and show it
  useEffect(() => {
    if (!open) return;
    let live = true; setProactive(null);
    fetch("/api/voice-brief", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ message: "Where should I focus today?", context: { ...context, periodLabel: presetLabel(context.sel) } }) })
      .then((r) => r.json()).then((j) => { if (live && j.text) setProactive(j.text); }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, context.page, context.brand]);

  const say = (text) => { if (ttsOn && text) speak(text); };

  // speak an assistant answer only when it came from a voice turn (or replayed)
  async function askServer(question, { fromVoice } = {}) {
    setMessages((ms) => [...ms, { role: "assistant", pending: true }]);
    setBusy(true);
    try {
      // free, local endpoint — reads your live Power BI numbers with NO AI / no Claude
      const res = await fetch("/api/voice-brief", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ message: question, context: { ...context, periodLabel: presetLabel(context.sel) } }),
      });
      const j = await res.json();
      const text = j.text || "…";
      setMessages((ms) => ms.map((m) => m.pending ? { role: "assistant", content: text, streamed: true } : m));
      if (fromVoice) say(text);
    } catch (e) {
      const text = "I couldn't reach the data service. Is the server running?";
      setMessages((ms) => ms.map((m) => m.pending ? { role: "assistant", content: text } : m));
      if (fromVoice) say(text);
    } finally { setBusy(false); }
  }

  // route a user utterance: local commands act instantly; questions/read go to the model
  async function ask(q, opts = {}) {
    const question = (q ?? input).trim();
    if (!question || busy) return;
    const fromVoice = !!opts.fromVoice;
    setInput("");
    const intent = parseCommand(question, { brands: context.brands || [] });

    if (intent.type === "stop") { stopSpeaking(); return; }

    // navigate / brand / date — execute via parent, confirm by voice
    if (intent.type === "nav" || intent.type === "brand" || intent.type === "date") {
      setMessages((ms) => [...ms, { role: "user", content: question }]);
      const reply = (onCommand && onCommand(intent)) || "Done.";
      setMessages((ms) => [...ms, { role: "assistant", content: reply }]);
      if (fromVoice) say(reply);
      return;
    }

    // read this page → grounded spoken summary
    if (intent.type === "read") {
      setMessages((ms) => [...ms, { role: "user", content: question }]);
      await askServer("Give me a short spoken summary of this page's key numbers for the current filters — 2 to 3 sentences, plain English, no chart.", { fromVoice: true });
      return;
    }

    // free-form question
    setMessages((ms) => [...ms, { role: "user", content: question }]);
    await askServer(question, { fromVoice });
  }

  // ---- voice input ----
  function toggleListen() {
    if (!sttSupported) return;
    stopSpeaking();
    if (listening) { recRef.current?.stop?.(); return; }
    const rec = createRecognizer({
      onResult: ({ interim: iv, final }) => setInterim(final || iv),
      onEnd: (finalText) => { setListening(false); setInterim(""); if (finalText) ask(finalText, { fromVoice: true }); },
      onError: () => { setListening(false); setInterim(""); },
    });
    if (!rec) return;
    recRef.current = rec; setInterim(""); setListening(true);
    try { rec.start(); } catch { setListening(false); }
  }
  // auto-start listening when opened via the mic orb
  useEffect(() => {
    if (open && autoListen && sttSupported && !listening) { toggleListen(); onAutoListenConsumed && onAutoListenConsumed(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoListen]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="as-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside className="as-panel" role="dialog" aria-label="AI assistant"
            initial={reduce ? { opacity: 0 } : { x: "100%" }} animate={reduce ? { opacity: 1 } : { x: 0 }} exit={reduce ? { opacity: 0 } : { x: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 36 }}>
            <div className="as-head">
              <div className="as-title"><span className="as-logo"><Sparkles size={15} /></span><div><b>Ask the data <span className="beta-badge">BETA</span></b><span>{PAGE_NAME[context.page] || "Platform"} · {presetLabel(context.sel)}{context.brand !== "all" ? " · " + context.brand : ""}</span></div></div>
              {ttsSupported && (
                <button className={"as-x as-voice" + (ttsOn ? " on" : "")} onClick={() => { if (ttsOn) stopSpeaking(); setTtsOn((v) => !v); }} aria-label={ttsOn ? "Voice replies on" : "Voice replies off"} title={ttsOn ? "Voice replies on — tap to mute" : "Voice replies off — tap to unmute"}>
                  {ttsOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
                </button>
              )}
              <button className="as-x" onClick={onClose} aria-label="Close"><X size={16} /></button>
            </div>

            <div className="as-scroll" ref={scroller}>
              {messages.length === 0 && (
                <div className="as-empty">
                  <div className="as-empty-logo"><Sparkles size={20} /></div>
                  <h4>Ask anything about your numbers</h4>
                  <p>I answer from your live Power BI model — real measures, your security scope. Try:</p>
                  {proactive && (
                    <div className="as-proactive"><div className="as-proactive-h"><Sparkles size={12} /> Where I'd focus</div><p>{proactive}</p></div>
                  )}
                  <div className="as-chips">{chips.map((c) => <button key={c} className="as-chip" onClick={() => ask(c)}>{c}</button>)}</div>
                </div>
              )}
              {messages.map((m, i) => <Bubble key={i} m={m} reduce={reduce} onTick={toBottom} />)}
            </div>

            <div className="as-foot">
              {listening && <div className="as-listening"><span className="as-wave"><i /><i /><i /><i /></span>{interim ? <em>{interim}</em> : <em>Listening… try "go to run rate" or "how are we doing?"</em>}</div>}
              <div className="as-inputrow">
                {sttSupported && (
                  <button className={"as-mic" + (listening ? " live" : "")} onClick={toggleListen} aria-label={listening ? "Stop listening" : "Speak"} title={listening ? "Stop" : "Speak your question or command"}><Mic size={16} /></button>
                )}
                <input className="as-input" placeholder="Ask, or say it — sales, targets, brands, branches…" value={input}
                  onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()} disabled={busy} />
                <button className="as-send" onClick={() => ask()} disabled={busy || !input.trim()} aria-label="Send"><Send size={15} /></button>
              </div>
              <div className="as-disc">Free on-device voice · answers read live from your Power BI model — no external AI.</div>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

// header trigger button
export function AssistantButton({ onClick }) {
  return (
    <button className="as-trigger" onClick={onClick} title="Ask the data — AI assistant">
      <Sparkles size={15} /><span>Ask AI</span>
    </button>
  );
}

// floating orb (bottom-right, all pages): tap to chat, tap mic to speak
export function AssistantOrb({ onOpen, onVoice }) {
  return (
    <div className="as-orb-wrap">
      {sttSupported && (
        <motion.button className="as-orb as-orb-mic" whileTap={{ scale: 0.92 }} onClick={onVoice} aria-label="Ask by voice" title="Ask by voice">
          <Mic size={20} />
        </motion.button>
      )}
      <motion.button className="as-orb as-orb-main" whileTap={{ scale: 0.92 }} onClick={onOpen} aria-label="Open AI assistant" title="Ask the data — AI assistant">
        <Sparkles size={20} />
      </motion.button>
    </div>
  );
}

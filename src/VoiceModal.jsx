import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Mic } from "lucide-react";
import { presetLabel } from "./dates.js";
import { parseCommand, speak, stopSpeaking, ttsSupported, sttSupported, createRecognizer, chime } from "./voice.js";

const INTRO = "Hi, I'm SWiSH A.I. Robot. This is my testing phase, so I can only answer a few questions for now — but I'm learning, and soon I'll answer all your questions. How can I assist you today?";
const PROMPTS = ["How can I assist you today?", "Hi! How can I help?", "What would you like to know?", "I'm listening — how can I help?"];

// ChatGPT-style centered voice experience. Tap-to-talk, animated orb, live
// transcript, spoken + written answers. First launch plays the intro greeting.
export default function VoiceModal({ open, onClose, context, onCommand }) {
  const [phase, setPhase] = useState("idle");   // idle | greeting | listening | thinking | answer
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const recRef = useRef(null);
  const busyRef = useRef(false);

  const stopAll = useCallback(() => { stopSpeaking(); try { recRef.current?.stop?.(); } catch { /* ignore */ } }, []);

  // ---- speak helper ----
  const say = useCallback((text, after) => {
    if (!ttsSupported) { after && after(); return; }
    speak(text, { onEnd: () => after && after() });
  }, []);

  // ---- listen ----
  const startListening = useCallback(() => {
    if (!sttSupported || busyRef.current) return;
    stopSpeaking();
    setTranscript(""); setAnswer(""); setPhase("listening");
    const rec = createRecognizer({
      onResult: ({ interim, final }) => setTranscript(final || interim),
      onEnd: (finalText) => { if (finalText) handle(finalText); else setPhase("idle"); },
      onError: () => setPhase("idle"),
    });
    if (!rec) { setPhase("idle"); return; }
    recRef.current = rec;
    try { rec.start(); } catch { setPhase("idle"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- route an utterance ----
  async function handle(text) {
    busyRef.current = true;
    setTranscript(text);
    const intent = parseCommand(text, { brands: context.brands || [] });

    if (intent.type === "stop") { busyRef.current = false; setPhase("idle"); return; }

    if (intent.type === "nav" || intent.type === "brand" || intent.type === "date") {
      const reply = (onCommand && onCommand(intent)) || "Done.";
      setAnswer(reply); setPhase("answer");
      say(reply, () => { busyRef.current = false; });
      return;
    }

    // read / question / anything else → free grounded endpoint
    setPhase("thinking");
    const question = intent.type === "read"
      ? "Give me a short spoken summary of this page's key numbers for the current filters."
      : text;
    try {
      const res = await fetch("/api/voice-brief", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ message: question, context: { ...context, periodLabel: presetLabel(context.sel) } }),
      });
      const j = await res.json();
      const t = j.text || "Oops, I don't know that one yet.";
      setAnswer(t); setPhase("answer");
      say(t, () => { busyRef.current = false; });
    } catch {
      const t = "I couldn't reach the data service. Is the server running?";
      setAnswer(t); setPhase("answer");
      say(t, () => { busyRef.current = false; });
    }
  }

  // ---- open / close lifecycle ----
  useEffect(() => {
    if (!open) { stopAll(); busyRef.current = false; setPhase("idle"); setTranscript(""); setAnswer(""); return; }
    let firstTime = false;
    try { firstTime = localStorage.getItem("swishVoiceIntro") !== "1"; } catch { /* ignore */ }
    const greetText = firstTime ? INTRO : PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
    if (firstTime) { try { localStorage.setItem("swishVoiceIntro", "1"); } catch { /* ignore */ } }
    // Siri-style activation chime, then the spoken greeting, then start listening
    chime();
    setAnswer(greetText); setPhase("greeting");
    const t = setTimeout(() => say(greetText, () => startListening()), 380);
    return () => { clearTimeout(t); stopAll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const listening = phase === "listening";
  const thinking = phase === "thinking";
  const status = phase === "greeting" ? "Introducing myself…"
    : listening ? "Listening…"
    : thinking ? "Thinking…"
    : phase === "answer" ? "Tap the orb to ask again" : "Tap the orb to speak";

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="vm-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div className="vm-card" initial={{ scale: 0.94, opacity: 0, y: 16 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0, y: 10 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}>
            <span className="vm-beta beta-badge">SWiSH AI · BETA</span>
            <button className="vm-close" onClick={onClose} aria-label="Close"><X size={20} /></button>

            <div className={"vm-orb-stage " + phase}>
              <span className="vm-ring r1" /><span className="vm-ring r2" /><span className="vm-ring r3" />
              <motion.button className="vm-orb" onClick={startListening} disabled={busyRef.current || thinking}
                whileTap={{ scale: 0.94 }} aria-label="Tap to speak">
                <Mic size={30} />
              </motion.button>
            </div>

            <div className="vm-status">{status}</div>

            {transcript && phase !== "greeting" && <div className="vm-transcript">"{transcript}"</div>}
            {answer && <div className="vm-answer">{answer}</div>}

            <div className="vm-hint">Free · on-device voice · answers read live from your Power BI model — no external AI.</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

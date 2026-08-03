// ============================================================================
//  VOICE LAYER — free, browser-native "Siri-style" narration + commands
//  Uses the Web Speech API (speechSynthesis + SpeechRecognition). No server,
//  no external/paid API. Voice commands (navigate / brand / date / read) are
//  matched by rules here; anything else is sent to the grounded /api/assistant.
// ============================================================================

export const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;
export const sttSupported =
  typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);

// ---- Text-to-speech (narration) --------------------------------------------
let voicesCache = null;
function allVoices() {
  if (!ttsSupported) return [];
  const v = window.speechSynthesis.getVoices();
  if (v && v.length) voicesCache = v;
  return voicesCache || [];
}
// warm the voice list (Chrome loads it async)
if (ttsSupported) {
  try { window.speechSynthesis.getVoices(); window.speechSynthesis.onvoiceschanged = allVoices; } catch { /* ignore */ }
}
// Prefer the richest, most musical female voice the device/browser offers. Real
// "singer" voices aren't exposed by the free Web Speech API, but modern
// Neural/Natural voices (Aria, Jenny, Libby, Sonia, Samantha, Google …) sound
// warm and expressive. We rank by quality tier, then by a pleasant-name shortlist.
let voiceOverride = null;   // optional exact voiceURI/name the user pinned
export function setPreferredVoice(nameOrUri) { voiceOverride = nameOrUri || null; try { localStorage.setItem("voicePref", voiceOverride || ""); } catch { /* ignore */ } }
export function getPreferredVoice() { return voiceOverride; }
try { if (typeof localStorage !== "undefined") voiceOverride = localStorage.getItem("voicePref") || null; } catch { /* ignore */ }

function pickVoice() {
  const vs = allVoices();
  if (!vs.length) return null;
  if (voiceOverride) { const m = vs.find((v) => v.voiceURI === voiceOverride || v.name === voiceOverride); if (m) return m; }
  // 1) An Arabic-accented ENGLISH female voice, if the device has one. Edge/Azure
  // ship Gulf-region bilingual neural voices (e.g. "Microsoft Hala/Amina/Fatima")
  // that read English with a soft Gulf accent — closest to a Kuwaiti lady.
  const gulf = /hala|amina|amira|fatima|noura|layla|salma|zariyah|hamda|sara|hind/i;
  const enArab = vs.find((v) => /^en[-_](AE|SA|KW|QA|BH|OM|EG|JO|LB)/i.test(v.lang) && /female|woman/i.test(v.name))
    || vs.find((v) => /^en[-_](AE|SA|KW|QA|BH|OM|EG|JO|LB)/i.test(v.lang))
    || vs.find((v) => gulf.test(v.name) && /english|^en/i.test(v.lang));
  if (enArab) return enArab;
  const en = vs.filter((v) => /^en[-_]/i.test(v.lang));
  const pool = en.length ? en : vs;
  // 2) else a soft, warm female English voice (best-first shortlist)
  const preferred = [
    "samantha", "ava (enhanced)", "ava", "allison", "susan", "microsoft aria online (natural)", "aria",
    "microsoft jenny", "jenny", "michelle", "google uk english female", "google us english",
    "serena", "karen", "moira", "tessa", "zira", "libby", "sonia", "emma", "nova",
  ];
  for (const nm of preferred) { const m = pool.find((v) => v.name.toLowerCase().includes(nm)); if (m) return m; }
  const fem = pool.find((v) => /female|woman/i.test(v.name)) || pool.find((v) => !/male|david|mark|george|daniel|fred|alex|guy|tom|james|paul/i.test(v.name));
  return fem || pool[0];
}
// expose the available English voices so a settings UI could let users pick
export function listVoices() { return allVoices().filter((v) => /^en/i.test(v.lang)).map((v) => ({ name: v.name, uri: v.voiceURI, lang: v.lang })); }

// turn dashboard shorthand into speakable words before we read it aloud
function speakable(text) {
  return String(text)
    .replace(/[#*_`>|]/g, " ")
    .replace(/\bKD\b/g, "dinars")
    .replace(/\bAOV\b/gi, "average order value")
    .replace(/\bWoW\b/gi, "week over week")
    .replace(/\bMoM\b/gi, "month over month")
    .replace(/\bYoY\b/gi, "year over year")
    .replace(/\bvs\.?\b/gi, "versus")
    .replace(/```chart[\s\S]*?```/g, " ")
    // phonetic hints so the built-in voices pronounce these naturally
    .replace(/\bAlhamdulillah\b/gi, "Al hamdu lillah")
    .replace(/\bIn Sha Allah\b/gi, "In shaa Allah")
    .replace(/\bInshaAllah\b/gi, "In shaa Allah")
    .replace(/\s+/g, " ")
    .trim();
}

let _keepAlive = null;   // Chrome silently pauses utterances > ~15s; nudge resume()
function clearKeepAlive() { if (_keepAlive) { clearInterval(_keepAlive); _keepAlive = null; } }

function speakNow(text, onStart, onEnd) {
  try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  const u = new SpeechSynthesisUtterance(speakable(text));
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = "en-US"; }
  u.rate = 0.9; u.pitch = 1.06; u.volume = 1;   // softer, gentle, unhurried (full volume)
  u.onstart = () => onStart && onStart();
  const finish = () => { clearKeepAlive(); onEnd && onEnd(); };
  u.onend = finish;
  u.onerror = finish;
  try { window.speechSynthesis.resume(); } catch { /* ignore */ }
  window.speechSynthesis.speak(u);
  // keep-alive: Chrome pauses long speech unless resume() is pinged periodically
  clearKeepAlive();
  _keepAlive = setInterval(() => {
    if (!window.speechSynthesis.speaking) { clearKeepAlive(); return; }
    try { window.speechSynthesis.pause(); window.speechSynthesis.resume(); } catch { /* ignore */ }
  }, 8000);
}

export function speak(text, { onStart, onEnd } = {}) {
  if (!ttsSupported || !text) { onEnd && onEnd(); return; }
  // Chrome loads voices asynchronously — if the list is empty, wait for it (or a
  // short timeout) so we don't fire into a browser that isn't ready to speak.
  if (!allVoices().length) {
    let fired = false;
    const go = () => { if (fired) return; fired = true; speakNow(text, onStart, onEnd); };
    try { window.speechSynthesis.onvoiceschanged = () => { allVoices(); go(); }; } catch { /* ignore */ }
    setTimeout(go, 350);
    return;
  }
  speakNow(text, onStart, onEnd);
}
export function stopSpeaking() {
  clearKeepAlive();
  if (!ttsSupported) return;
  // Chrome won't cancel a *paused* synth, and the keep-alive may have just paused it —
  // resume first so cancel() actually takes effect, then cancel (twice, belt-and-braces).
  try { window.speechSynthesis.resume(); } catch { /* ignore */ }
  try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
}
// Call inside a user gesture (button click) to "unlock" TTS, so speech that starts
// LATER (after an async fetch) isn't blocked by the browser's autoplay policy.
export function primeSpeech() {
  if (!ttsSupported) return;
  try { window.speechSynthesis.resume(); const u = new SpeechSynthesisUtterance(" "); u.volume = 0; window.speechSynthesis.speak(u); } catch { /* ignore */ }
}
export function speaking() { return ttsSupported && window.speechSynthesis.speaking; }

// ---- activation chime (Siri-style, synthesized — no audio file) ------------
let audioCtx = null;
export function chime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = audioCtx || new AC();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const now = audioCtx.currentTime;
    // two soft rising sine tones with a quick shimmer — a gentle "ready" cue
    const notes = [{ f: 587.33, t: 0 }, { f: 880.0, t: 0.11 }, { f: 1174.66, t: 0.22 }];
    notes.forEach(({ f, t }) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = f;
      const s = now + t;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.22, s + 0.025);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.26);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(s); o.stop(s + 0.28);
    });
  } catch { /* ignore */ }
}

// ---- Speech recognition (voice commands) -----------------------------------
export function createRecognizer({ onResult, onEnd, onError } = {}) {
  const SR = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!SR) return null;
  const r = new SR();
  r.lang = "en-US";
  r.interimResults = true;
  r.continuous = false;
  r.maxAlternatives = 1;
  let finalText = "";
  r.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const seg = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += seg; else interim += seg;
    }
    onResult && onResult({ interim: interim.trim(), final: finalText.trim() });
  };
  r.onend = () => onEnd && onEnd(finalText.trim());
  r.onerror = (e) => onError && onError(e.error || "error");
  return r;
}

// ---- Command grammar -------------------------------------------------------
const PAGE_WORDS = [
  { id: "landing", re: /\b(dashboard|home page|landing|command cent(?:er|re)|go home)\b/ },
  { id: "operations", re: /\b(operations?|prep time|kitchen|ops page)\b/ },
  { id: "overview", re: /\b(sales analysis|analysis page|sales page|deep dive)\b/ },
  { id: "compare", re: /\b(compare|comparison)\b/ },
  { id: "productmix", re: /\b(product mix|pmix|menu mix|product menu)\b/ },
  { id: "runrate", re: /\b(run.?rate|forecast page|target pace|live runrate)\b/ },
  { id: "analysislab", re: /\b(analysis lab|the lab)\b/ },
];
const DATE_WORDS = [
  { preset: "today", re: /\btoday\b/ },
  { preset: "yesterday", re: /\byesterday\b/ },
  { preset: "last7", re: /\b(last 7|last seven|past 7|trailing (?:7|seven)|rolling week)\b/ },
  { preset: "lastWeek", re: /\blast week\b/ },
  { preset: "thisWeek", re: /\bthis week\b/ },
  { preset: "lastMonth", re: /\blast month\b/ },
  { preset: "thisMonth", re: /\b(this month|month to date|current month)\b/ },
];

// Return an intent. Only clear imperatives become actions; everything else is a
// question routed to the grounded assistant (which can itself scope by brand).
export function parseCommand(text, { brands = [] } = {}) {
  const raw = String(text || "").trim();
  const t = " " + raw.toLowerCase().replace(/[?.!,]/g, " ").replace(/\s+/g, " ") + " ";
  const has = (re) => re.test(t);
  const words = raw.split(/\s+/).filter(Boolean).length;

  if (!raw) return { type: "ask", text: raw };
  if (has(/\b(stop|be quiet|quiet|shut up|silence|never mind|cancel that?)\b/)) return { type: "stop" };

  const wantsNav = has(/\b(go to|open|show me|take me to|navigate|switch to|jump to|bring up)\b/);
  const wantsFilter = has(/\b(switch|change|filter|set|show|only|just)\b/);
  const looksLikeQuestion = has(/\b(why|how|what|which|when|who|is|are|was|were|do|does|compare|explain|versus|tell me|reason)\b/);

  // page navigation
  if (wantsNav) {
    for (const p of PAGE_WORDS) if (p.re.test(t)) return { type: "nav", page: p.id };
  }
  // brand switch — needs a brand name plus a filter/nav verb, and not phrased as a question
  const bsorted = [...brands].sort((a, b) => b.length - a.length);
  for (const b of bsorted) {
    if (t.includes(" " + b.toLowerCase() + " ") && (wantsFilter || wantsNav) && !looksLikeQuestion) {
      return { type: "brand", brand: b };
    }
  }
  if ((wantsFilter || wantsNav) && has(/\ball brands?\b|\ball of them\b|\beverything\b/)) return { type: "brand", brand: "all" };

  // date preset — only when clearly a filter directive or a short phrase
  if (wantsFilter || wantsNav || words <= 3) {
    for (const d of DATE_WORDS) if (d.re.test(t)) return { type: "date", preset: d.preset };
  }

  // narration
  if (has(/\b(read (?:this|the|it|out|aloud)|read this page|narrate|summari[sz]e|brief me|catch me up|give me (?:a|the) (?:summary|rundown|brief))\b/)) {
    return { type: "read" };
  }

  return { type: "ask", text: raw };
}

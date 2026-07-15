import { useState, useRef, useEffect } from 'react';
import api from '../api';
import { FiX, FiSend, FiAlertCircle, FiVolume2, FiVolumeX } from 'react-icons/fi';
import useDraggableFab from '../hooks/useDraggableFab';

// ─── Text-to-Speech helpers (browser Web Speech API) ─────────────────
// Free, offline-capable, supports Hindi via the OS-provided voice list
// (Chrome / Edge: Microsoft Heera or Google हिन्दी; Android: Google
// Hindi; iOS / macOS: Lekha or Rishi). We strip markdown, detect
// Devanagari to pick a Hindi voice, fall back to en-IN, then en-US.
const hasDevanagari = (s) => /[ऀ-ॿ]/.test(String(s || ''));
// Best Hindi-ish voice we can find on this device. Picked once per
// speak() call so we honour any voices added after the page loaded.
function pickVoice(forHindi) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  if (!voices.length) return null;
  if (forHindi) {
    // Prefer exact hi-IN, then any voice whose lang starts with "hi".
    return voices.find(v => v.lang === 'hi-IN')
      || voices.find(v => /^hi/i.test(v.lang))
      || voices.find(v => /hindi/i.test(v.name))
      // Indian-English fallback so foreign-language English voices don't read Hinglish weirdly.
      || voices.find(v => v.lang === 'en-IN')
      || voices.find(v => /^en/i.test(v.lang))
      || voices[0];
  }
  return voices.find(v => v.lang === 'en-IN')
    || voices.find(v => /^en/i.test(v.lang))
    || voices[0];
}
// Strip markdown so the TTS doesn't say "double asterisk" etc. Keeps
// the prose readable when spoken.
function plainTextForSpeech(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')        // code fences
    .replace(/`([^`]+)`/g, '$1')             // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')       // bold
    .replace(/__([^_]+)__/g, '$1')           // alt bold
    .replace(/(^|\s)\*([^*\s][^*]*?)\*/g, '$1$2')  // italics
    .replace(/^#{1,6}\s+/gm, '')             // headings
    .replace(/^\s*[-*+]\s+/gm, '• ')         // bullets
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/\n{2,}/g, '. ')                // paragraph breaks → pause
    .replace(/\s+/g, ' ')                    // collapse whitespace
    .trim();
}

// Tiny robot-head SVG used for the floating chat bubble. Steel head,
// glowing antenna, cyan eyes that blink, and a subtle smile. Sized via
// the parent button — width/height = 100%.
function RobotHead() {
  return (
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" className="w-9 h-9">
      {/* Antenna stem + glowing tip */}
      <line x1="32" y1="4" x2="32" y2="12" stroke="#cbd5e1" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="32" cy="4" r="2.4" fill="#22d3ee">
        <animate attributeName="opacity" values="1;0.35;1" dur="1.6s" repeatCount="indefinite" />
      </circle>
      {/* Head — rounded square */}
      <rect x="10" y="14" width="44" height="38" rx="9" fill="url(#robotHeadGrad)" stroke="#1e293b" strokeWidth="1.2" />
      {/* Side "ears" (audio receptors) */}
      <rect x="6" y="26" width="4" height="12" rx="1.2" fill="#94a3b8" />
      <rect x="54" y="26" width="4" height="12" rx="1.2" fill="#94a3b8" />
      {/* Visor / screen panel */}
      <rect x="15" y="22" width="34" height="18" rx="3" fill="#0f172a" stroke="#334155" strokeWidth="0.6" />
      {/* Eyes — cyan, blinking */}
      <circle cx="24" cy="31" r="3" fill="#22d3ee">
        <animate attributeName="r" values="3;3;0.6;3;3" keyTimes="0;0.45;0.5;0.55;1" dur="3.4s" repeatCount="indefinite" />
      </circle>
      <circle cx="40" cy="31" r="3" fill="#22d3ee">
        <animate attributeName="r" values="3;3;0.6;3;3" keyTimes="0;0.45;0.5;0.55;1" dur="3.4s" repeatCount="indefinite" />
      </circle>
      {/* Eye glow */}
      <circle cx="24" cy="31" r="4.5" fill="#22d3ee" opacity="0.18" />
      <circle cx="40" cy="31" r="4.5" fill="#22d3ee" opacity="0.18" />
      {/* Smile */}
      <path d="M22 46 Q32 50 42 46" stroke="#cbd5e1" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <defs>
        <linearGradient id="robotHeadGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#475569" />
          <stop offset="100%" stopColor="#1e293b" />
        </linearGradient>
      </defs>
    </svg>
  );
}

// Floating chat bubble + expandable panel. Renders on every page via
// Layout.jsx. Hidden entirely if the API key isn't configured (so
// non-admin users don't see a broken feature).
//
// Chat is stateless on the server — we keep the last ~10 turns in
// client state and send them as `history` on each /ask call so Claude
// has context for follow-up questions.
export default function AIAgentChat() {
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState(null); // null = unknown
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState([]); // { role, content, sql_runs? }
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  // TTS state — index of the message currently being spoken (-1 = none).
  // autoSpeak persists in localStorage so mam's preference survives reloads.
  const [speakingIdx, setSpeakingIdx] = useState(-1);
  const [autoSpeak, setAutoSpeak] = useState(() => {
    try { return localStorage.getItem('ai_chat_autospeak') === '1'; } catch { return false; }
  });
  const ttsSupported = typeof window !== 'undefined' && !!window.speechSynthesis;

  // Draggable FAB — mam's request 2026-05-16. Persists position under
  // 'fab-ai-robot' so the robot stays wherever she parks it. Default
  // sits 80 px above the Help button (matches the old bottom-24
  // anchor relative to a 56 px Help button + 24 px gap).
  const aiFab = useDraggableFab('fab-ai-robot', { offsetRight: 24, offsetBottom: 104 });

  // Speak (or stop) a specific message. Picks a Hindi voice when the
  // text contains Devanagari, so a Hindi training answer comes out in
  // the right accent. Stops any in-flight utterance first.
  const speak = (idx, text) => {
    if (!ttsSupported) return;
    const synth = window.speechSynthesis;
    if (speakingIdx === idx) { synth.cancel(); setSpeakingIdx(-1); return; }
    synth.cancel();
    const plain = plainTextForSpeech(text);
    if (!plain) return;
    const utt = new SpeechSynthesisUtterance(plain);
    const hindi = hasDevanagari(plain);
    const v = pickVoice(hindi);
    if (v) utt.voice = v;
    utt.lang = hindi ? 'hi-IN' : 'en-IN';
    utt.rate = 0.95;
    utt.pitch = 1;
    utt.onend = () => setSpeakingIdx(s => (s === idx ? -1 : s));
    utt.onerror = () => setSpeakingIdx(s => (s === idx ? -1 : s));
    setSpeakingIdx(idx);
    synth.speak(utt);
  };

  // Persist auto-speak toggle.
  useEffect(() => {
    try { localStorage.setItem('ai_chat_autospeak', autoSpeak ? '1' : '0'); } catch (_) {}
  }, [autoSpeak]);

  // Stop any in-flight speech when the panel closes or component unmounts.
  useEffect(() => {
    if (!open && ttsSupported) { try { window.speechSynthesis.cancel(); } catch (_) {} setSpeakingIdx(-1); }
  }, [open, ttsSupported]);
  useEffect(() => () => {
    if (ttsSupported) { try { window.speechSynthesis.cancel(); } catch (_) {} }
  }, [ttsSupported]);

  // Some browsers (Chrome) lazy-load the voice list — touch it once so
  // the first speak() doesn't fall back to the OS default.
  useEffect(() => {
    if (!ttsSupported) return;
    const synth = window.speechSynthesis;
    const prime = () => synth.getVoices();
    prime();
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', prime);
      return () => synth.removeEventListener('voiceschanged', prime);
    }
  }, [ttsSupported]);

  // Poll status on mount + when opening (so admin enabling it shows up
  // without a full page reload).
  useEffect(() => {
    let cancelled = false;
    api.get('/ai-agent/status').then(r => { if (!cancelled) setConfigured(!!r.data.configured); })
      .catch(() => { if (!cancelled) setConfigured(false); });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  // Hide the bubble entirely until we know the chatbot is configured.
  // This keeps the UI clean before mam pastes her API key, and avoids
  // every user seeing a "Not configured" error on first click.
  if (configured === null || configured === false) return null;

  const send = async () => {
    const q = input.trim();
    if (!q || busy) return;
    const next = [...messages, { role: 'user', content: q }];
    setMessages(next);
    setInput('');
    setBusy(true);
    try {
      const history = messages.slice(-10).map(m => ({ role: m.role, content: m.content }));
      const { data } = await api.post('/ai-agent/ask', { question: q, history });
      // Backend now streams keep-alive whitespace before the JSON body
      // so nginx doesn't kill long Anthropic calls at its 60s timeout.
      // The status is always 200 once the stream starts, so true errors
      // ride in `data.error`. Honour that before falling through to a
      // successful answer.
      if (data?.error) {
        setMessages([...next, { role: 'assistant', content: `⚠️ ${data.error}`, error: true }]);
      } else {
        const answer = data.answer || '(no answer)';
        const newMessages = [...next, { role: 'assistant', content: answer, sql_runs: data.sql_runs || [] }];
        setMessages(newMessages);
        // Auto-speak: if mam turned on the speaker icon in the header,
        // immediately read the new answer aloud (Hindi voice if it's
        // Devanagari, else en-IN).
        if (autoSpeak && ttsSupported && !data.error) {
          // setTimeout so DOM has rendered the bubble (better UX).
          setTimeout(() => speak(newMessages.length - 1, answer), 50);
        }
      }
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Request failed';
      setMessages([...next, { role: 'assistant', content: `⚠️ ${msg}`, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <>
      {/* Floating robot — bottom-right. The Help & Support button uses
          bottom-6 right-6, so we sit just above it. Style: steel/dark
          chassis, glowing cyan antenna + eyes, hovers with a slow bob
          and pulses an outer ring to look "alive". */}
      {!open && (
        <button
          {...aiFab.handlers}
          onClick={aiFab.onClickGuard(() => setOpen(true))}
          title="Ask Sotyn — AI Assistant (drag to move)"
          style={{ ...aiFab.style, zIndex: 30 }}
          className="ai-robot-btn w-16 h-16 rounded-2xl bg-gradient-to-b from-slate-700 via-slate-800 to-slate-900 text-white shadow-xl shadow-cyan-900/30 ring-1 ring-cyan-400/30 flex items-center justify-center hover:scale-110 transition-transform cursor-grab active:cursor-grabbing"
        >
          {/* Outer glow ring — slow pulse */}
          <span aria-hidden="true" className="ai-robot-ring absolute inset-0 rounded-2xl ring-2 ring-cyan-400/40" />
          <RobotHead />
          <style>{`
            @keyframes ai-robot-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
            @keyframes ai-robot-pulse { 0%, 100% { opacity: 0.35; transform: scale(1); } 50% { opacity: 0; transform: scale(1.18); } }
            .ai-robot-btn { animation: ai-robot-bob 3.2s ease-in-out infinite; }
            .ai-robot-ring { animation: ai-robot-pulse 2.2s ease-out infinite; }
          `}</style>
        </button>
      )}

      {open && (
        <div className="fixed bottom-6 right-6 z-40 w-[min(90vw,400px)] h-[min(80vh,560px)] bg-white border border-gray-200 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-blue-800 to-blue-950 text-white">
            <div>
              <div className="font-semibold text-sm">Ask Sotyn</div>
              <div className="text-[10px] text-blue-100 -mt-0.5">AI assistant · reads your data</div>
            </div>
            <div className="flex items-center gap-1">
              {/* Auto-speak toggle — when on, every new AI reply is read
                  aloud in Hindi or English depending on the answer text. */}
              {ttsSupported && (
                <button
                  onClick={() => setAutoSpeak(v => !v)}
                  className={`rounded p-1.5 ${autoSpeak ? 'bg-white/20' : 'hover:bg-white/10'}`}
                  title={autoSpeak ? 'Auto-speak ON — new replies will be read aloud' : 'Auto-speak OFF — click to enable'}
                >
                  {autoSpeak ? <FiVolume2 size={16} /> : <FiVolumeX size={16} />}
                </button>
              )}
              <button onClick={() => setOpen(false)} className="hover:bg-white/10 rounded p-1"><FiX size={18} /></button>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3 bg-gray-50">
            {messages.length === 0 && (
              <div className="text-xs text-gray-500 space-y-2">
                <p className="font-medium text-gray-700">Try asking:</p>
                <div className="grid gap-1.5">
                  {[
                    'What rate did we give L&T for 1.5T AC last time?',
                    'Which customers haven\'t paid in 60 days?',
                    'DPR kaise submit kare? Hindi me batao',
                    'How to create Sales Bill?',
                    'Today\'s DPR submissions by site',
                  ].map((s, i) => (
                    <button key={i} onClick={() => setInput(s)}
                      className="text-left bg-white border border-gray-200 hover:border-red-300 hover:bg-red-50 rounded px-2 py-1.5 text-xs text-gray-700">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-blue-800 text-white'
                    : m.error
                      ? 'bg-yellow-50 text-yellow-900 border border-yellow-200'
                      : 'bg-white border border-gray-200 text-gray-800'
                }`}>
                  {m.error && <FiAlertCircle className="inline mr-1 -mt-0.5" size={14} />}
                  {m.content}
                  {/* Per-message speak / stop button. Only on assistant
                      replies, only when TTS is supported. Highlights
                      while playing so mam can tell which message is
                      being read. */}
                  {m.role === 'assistant' && !m.error && ttsSupported && (
                    <div className="mt-1.5 flex items-center gap-1">
                      <button
                        onClick={() => speak(i, m.content)}
                        className={`text-[10px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ${
                          speakingIdx === i
                            ? 'bg-red-100 border-red-300 text-red-700'
                            : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-red-50 hover:border-red-200 hover:text-red-700'
                        }`}
                        title={speakingIdx === i ? 'Stop' : (hasDevanagari(m.content) ? 'Hindi me suno' : 'Read aloud')}
                      >
                        {speakingIdx === i ? <FiVolumeX size={11} /> : <FiVolume2 size={11} />}
                        {speakingIdx === i ? 'Stop' : (hasDevanagari(m.content) ? 'Hindi me suno' : 'Speak')}
                      </button>
                    </div>
                  )}
                  {m.sql_runs?.length > 0 && (
                    <details className="mt-2 text-[10px] text-gray-500">
                      <summary className="cursor-pointer hover:text-gray-700">
                        {m.sql_runs.length} {m.sql_runs.length === 1 ? 'query' : 'queries'} run
                      </summary>
                      <div className="mt-1 space-y-1">
                        {m.sql_runs.map((r, j) => (
                          <div key={j} className="font-mono break-all bg-gray-50 rounded p-1.5 border border-gray-100">
                            <div className="text-gray-700">{r.query}</div>
                            <div className="text-gray-400 mt-0.5">
                              {r.error ? `error: ${r.error}` : `${r.row_count} row${r.row_count === 1 ? '' : 's'}`}
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            ))}

            {busy && (
              <div className="flex justify-start">
                <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-500">
                  <span className="inline-flex gap-1">
                    <span className="animate-pulse">•</span>
                    <span className="animate-pulse" style={{ animationDelay: '0.2s' }}>•</span>
                    <span className="animate-pulse" style={{ animationDelay: '0.4s' }}>•</span>
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-gray-200 p-2 bg-white">
            <div className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                rows={1}
                className="input flex-1 text-sm resize-none"
                placeholder="Ask anything about your Headmasters data…"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={busy}
              />
              <button
                onClick={send}
                disabled={busy || !input.trim()}
                className="btn btn-primary px-3 py-2 flex-shrink-0 disabled:opacity-40"
              >
                <FiSend size={14} />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

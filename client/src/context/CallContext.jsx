// 1-on-1 voice & video calling for the internal WhatsApp (mam 2026-06-19).
// WebRTC carries the audio/video peer-to-peer; the existing chat Socket.IO
// only relays the tiny offer/answer/ICE control messages. A single global
// provider holds the call + renders the call overlay, so an incoming call
// rings anywhere in the app.
import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import api from '../api';
import { useAuth } from './AuthContext';
import { useAppSocket } from './SocketProvider';
import { FiPhone, FiPhoneOff, FiVideo, FiVideoOff, FiMic, FiMicOff, FiX } from 'react-icons/fi';

const CallContext = createContext(null);
export const useCall = () => useContext(CallContext) || { startCall: () => {} };

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }];
const initials = (s) => String(s || '?').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 2).toUpperCase() || '#';

export function CallProvider({ children }) {
  const { user } = useAuth();
  const { subscribe, emit } = useAppSocket();   // shared shell socket (SocketProvider)
  // call: null | { phase:'incoming'|'calling'|'active', peerId, peerName, video, callId }
  const [call, setCall] = useState(null);
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);

  const pcRef = useRef(null);
  const localRef = useRef(null);            // local MediaStream
  const localVidRef = useRef(null);         // <video> for self
  const remoteVidRef = useRef(null);        // <video> for the other person
  const remoteAudRef = useRef(null);        // <audio> fallback for voice calls
  const iceServersRef = useRef(DEFAULT_ICE);
  const pendingIce = useRef([]);            // ICE candidates that arrive before remoteDescription
  const incomingOffer = useRef(null);       // stored SDP offer for an incoming call
  const callRef = useRef(null);
  const ringOsc = useRef(null);
  callRef.current = call;

  // ── ringtone (Web Audio beep loop — no asset needed) ──────────────────
  const startRing = () => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ac = new Ctx();
      const tick = () => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = 480; o.connect(g); g.connect(ac.destination);
        g.gain.setValueAtTime(0.0001, ac.currentTime);
        g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.5);
        o.start(); o.stop(ac.currentTime + 0.5);
      };
      tick();
      ringOsc.current = { ac, timer: setInterval(tick, 1500) };
    } catch (_) { /* ignore */ }
  };
  const stopRing = () => { try { clearInterval(ringOsc.current?.timer); ringOsc.current?.ac?.close(); } catch (_) {} ringOsc.current = null; };

  // ── cleanup ──────────────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    stopRing();
    try { pcRef.current?.close(); } catch (_) {}
    pcRef.current = null;
    try { localRef.current?.getTracks().forEach(t => t.stop()); } catch (_) {}
    localRef.current = null;
    pendingIce.current = []; incomingOffer.current = null;
    setMuted(false); setCamOff(false);
    setCall(null);
  }, []);

  const newPc = useCallback((peerId, callId) => {
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
    pc.onicecandidate = (e) => {
      if (e.candidate) emit('call:ice', { to: peerId, callId, candidate: e.candidate });
    };
    pc.ontrack = (e) => {
      const [stream] = e.streams;
      if (remoteVidRef.current) remoteVidRef.current.srcObject = stream;
      if (remoteAudRef.current) remoteAudRef.current.srcObject = stream;
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        if (callRef.current) cleanup();
      }
    };
    pcRef.current = pc;
    return pc;
  }, [cleanup, emit]);

  const drainIce = async () => {
    const pc = pcRef.current; if (!pc) return;
    for (const c of pendingIce.current) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {} }
    pendingIce.current = [];
  };

  // ── start an outgoing call ─────────────────────────────────────────────
  const startCall = useCallback(async (peerId, peerName, video) => {
    if (!peerId || callRef.current) return;
    const callId = (window.crypto?.randomUUID?.() || String(peerId) + '-' + performance.now());
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!video });
      localRef.current = stream;
      const pc = newPc(peerId, callId);
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      emit('call:offer', { to: peerId, callId, sdp: offer, video: !!video });
      setCall({ phase: 'calling', peerId, peerName, video: !!video, callId });
    } catch (e) {
      cleanup();
      alert('Could not start the call — allow microphone' + (video ? ' / camera' : '') + ' access.');
    }
  }, [newPc, cleanup, emit]);

  // ── accept an incoming call ─────────────────────────────────────────────
  const acceptCall = useCallback(async () => {
    const c = callRef.current; const offer = incomingOffer.current;
    if (!c || !offer) return;
    stopRing();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!c.video });
      localRef.current = stream;
      const pc = newPc(c.peerId, c.callId);
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await drainIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      emit('call:answer', { to: c.peerId, callId: c.callId, sdp: answer });
      setCall({ ...c, phase: 'active' });
    } catch (e) {
      emit('call:reject', { to: c.peerId, callId: c.callId });
      cleanup();
      alert('Could not join the call — allow microphone' + (c.video ? ' / camera' : '') + ' access.');
    }
  }, [newPc, cleanup, emit]);

  const rejectCall = useCallback(() => {
    const c = callRef.current; if (c) emit('call:reject', { to: c.peerId, callId: c.callId });
    cleanup();
  }, [cleanup, emit]);

  const endCall = useCallback(() => {
    const c = callRef.current;
    if (c) emit(c.phase === 'calling' ? 'call:cancel' : 'call:end', { to: c.peerId, callId: c.callId });
    cleanup();
  }, [cleanup, emit]);

  const toggleMute = () => {
    const s = localRef.current; if (!s) return;
    const on = !muted; s.getAudioTracks().forEach(t => { t.enabled = !on; }); setMuted(on);
  };
  const toggleCam = () => {
    const s = localRef.current; if (!s) return;
    const on = !camOff; s.getVideoTracks().forEach(t => { t.enabled = !on; }); setCamOff(on);
  };

  // ── call signalling (rides the shared shell socket — SocketProvider) ──────
  useEffect(() => {
    if (!user?.id) return;
    api.get('/site-chat/ice').then(r => { if (Array.isArray(r.data?.iceServers)) iceServersRef.current = r.data.iceServers; }).catch(() => {});
    // subscribe() attaches now (or when the deferred connect fires) and stays
    // attached across reconnects, so an incoming call rings on any page. Auth /
    // transports / storage-blocked handling live once in the shared socket.
    const onBye = (d) => { const c = callRef.current; if (c && c.callId === d.callId) cleanup(); };
    const offs = [
      subscribe('call:offer', (d) => {
        if (callRef.current) { emit('call:reject', { to: d.from, callId: d.callId }); return; } // busy
        incomingOffer.current = d.sdp;
        setCall({ phase: 'incoming', peerId: d.from, peerName: d.fromName, video: !!d.video, callId: d.callId });
        startRing();
      }),
      subscribe('call:answer', async (d) => {
        const c = callRef.current; if (!c || c.callId !== d.callId) return;
        try { await pcRef.current?.setRemoteDescription(new RTCSessionDescription(d.sdp)); await drainIce(); setCall({ ...c, phase: 'active' }); } catch (_) {}
      }),
      subscribe('call:ice', async (d) => {
        const c = callRef.current; if (!c || c.callId !== d.callId || !d.candidate) return;
        if (pcRef.current?.remoteDescription) { try { await pcRef.current.addIceCandidate(new RTCIceCandidate(d.candidate)); } catch (_) {} }
        else pendingIce.current.push(d.candidate);
      }),
      subscribe('call:end', onBye),
      subscribe('call:reject', onBye),
      subscribe('call:cancel', onBye),
    ];
    return () => { offs.forEach(off => off()); };
  }, [user?.id, cleanup, subscribe, emit]);

  // attach local preview stream to the <video> when it mounts / call changes
  useEffect(() => {
    if (call?.phase === 'active' && call.video && localVidRef.current && localRef.current) {
      localVidRef.current.srcObject = localRef.current;
    }
  }, [call?.phase, call?.video]);

  // Stable context value — only changes when startCall (memoised) or the call
  // state changes, so useCall consumers (e.g. SiteChat) don't re-render on
  // unrelated CallProvider re-renders, e.g. when Layout re-renders around it.
  const ctx = useMemo(() => ({ startCall, inCall: !!call }), [startCall, call]);

  return (
    <CallContext.Provider value={ctx}>
      {children}
      {call && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 text-white select-none" style={{ height: '100dvh' }}>
          {/* hidden remote audio so voice calls have sound even with no video element shown */}
          <audio ref={remoteAudRef} autoPlay playsInline className="hidden" />

          {call.phase === 'active' && call.video ? (
            <div className="relative w-full h-full">
              <video ref={remoteVidRef} autoPlay playsInline className="absolute inset-0 w-full h-full object-cover bg-black" />
              <video ref={localVidRef} autoPlay playsInline muted className="absolute right-3 w-24 h-32 sm:w-32 sm:h-44 object-cover rounded-lg border-2 border-white/40 bg-black" style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 6rem)' }} />
              <div className="absolute left-0 right-0 text-center text-lg font-semibold drop-shadow" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}>{call.peerName}</div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4">
              <div className="w-28 h-28 rounded-full bg-emerald-600 flex items-center justify-center text-4xl font-bold">{initials(call.peerName)}</div>
              <div className="text-2xl font-semibold">{call.peerName}</div>
              <div className="text-sm text-white/70">
                {call.phase === 'incoming' ? `Incoming ${call.video ? 'video' : 'voice'} call…`
                  : call.phase === 'calling' ? `Calling… (${call.video ? 'video' : 'voice'})`
                    : `${call.video ? 'Video' : 'Voice'} call`}
              </div>
            </div>
          )}

          {/* controls */}
          <div className="absolute left-0 right-0 flex items-center justify-center gap-4" style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 2rem)' }}>
            {call.phase === 'incoming' ? (
              <>
                <button onClick={rejectCall} className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-700 flex items-center justify-center" title="Decline"><FiPhoneOff size={26} /></button>
                <button onClick={acceptCall} className="w-16 h-16 rounded-full bg-emerald-500 hover:bg-emerald-600 flex items-center justify-center" title="Accept"><FiPhone size={26} /></button>
              </>
            ) : (
              <>
                <button onClick={toggleMute} className={`w-12 h-12 rounded-full flex items-center justify-center ${muted ? 'bg-white text-gray-800' : 'bg-white/20 hover:bg-white/30'}`} title={muted ? 'Unmute' : 'Mute'}>{muted ? <FiMicOff size={20} /> : <FiMic size={20} />}</button>
                {call.video && (
                  <button onClick={toggleCam} className={`w-12 h-12 rounded-full flex items-center justify-center ${camOff ? 'bg-white text-gray-800' : 'bg-white/20 hover:bg-white/30'}`} title={camOff ? 'Camera on' : 'Camera off'}>{camOff ? <FiVideoOff size={20} /> : <FiVideo size={20} />}</button>
                )}
                <button onClick={endCall} className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-700 flex items-center justify-center" title="Hang up"><FiPhoneOff size={26} /></button>
              </>
            )}
          </div>
        </div>
      )}
    </CallContext.Provider>
  );
}

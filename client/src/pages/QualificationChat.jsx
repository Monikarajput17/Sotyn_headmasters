import { useMemo, useState } from 'react';
import { FiX, FiPhoneCall, FiChevronLeft, FiZap } from 'react-icons/fi';
import { num as fmt } from '../lib/solar/format';
import { QUAL_SECTIONS, recommend, qualProgress } from '../lib/solar/qualification';

// A guided call-script "chatbot" the sales coordinator runs on the phone.
// Flattened list of questions; engineer hint shown to the coordinator; selects
// auto-advance; ends on a recommended system that makes the lead quote-ready.
export default function QualificationChat({ deal, onClose, onDone }) {
  const flat = useMemo(() => QUAL_SECTIONS.flatMap((s) => s.questions.map((q) => ({ ...q, section: s.title }))), []);
  const [ans, setAns] = useState({ ...(deal?.qualification || {}) });
  const [i, setI] = useState(0);
  const atEnd = i >= flat.length;
  const q = flat[i];
  const set = (k, v) => setAns((p) => ({ ...p, [k]: v }));
  const prog = qualProgress(ans);
  const rec = useMemo(() => recommend(ans), [ans]);
  // Suggested size is editable — the rep can override the auto-recommendation
  // before saving (mam 2026-06-27). '' = use the recommended kW.
  const [kwOverride, setKwOverride] = useState('');
  const finalKw = kwOverride !== '' ? (+kwOverride || 0) : rec.kw;

  const next = () => setI((x) => Math.min(flat.length, x + 1));
  const back = () => setI((x) => Math.max(0, x - 1));
  const finish = () => onDone(ans, { ...rec, kw: finalKw });

  const showSectionHead = i === 0 || flat[i - 1]?.section !== q?.section;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-xl my-8">
        <div className="px-5 py-3 border-b flex items-center justify-between bg-blue-900 text-white rounded-t-xl">
          <h3 className="font-bold flex items-center gap-2"><FiPhoneCall /> Qualify on call — {deal?.client_name || 'Lead'}</h3>
          <button onClick={onClose}><FiX /></button>
        </div>
        <div className="h-1.5 bg-gray-100"><div className="h-1.5 bg-emerald-500 transition-all" style={{ width: `${prog.pct}%` }} /></div>

        <div className="p-5 min-h-[280px]">
          {!atEnd ? (
            <div>
              {showSectionHead && <p className="text-[11px] font-bold uppercase tracking-wide text-blue-700 mb-3">{q.section}</p>}
              <p className="text-[10px] text-gray-400 mb-1">Question {i + 1} of {flat.length}</p>
              <p className="text-lg font-semibold mb-1">{q.label}</p>
              {q.hint && <p className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1 mb-4">🎧 {q.hint}</p>}

              {q.type === 'select' ? (
                <div className="flex flex-col gap-2">
                  {q.options.map((o) => (
                    <button key={o} onClick={() => { set(q.key, o); next(); }}
                      className={`text-left px-3 py-2 rounded-lg border text-sm ${ans[q.key] === o ? 'bg-blue-700 text-white border-blue-700' : 'bg-white hover:bg-blue-50 border-gray-200'}`}>{o}</button>))}
                </div>
              ) : (
                <div className="flex gap-2">
                  <input autoFocus type={q.type} value={ans[q.key] ?? ''} onChange={(e) => set(q.key, e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && next()} placeholder="Type the answer…" className="input-compact flex-1" />
                  <button onClick={next} className="btn btn-primary text-sm">Next</button>
                </div>
              )}
            </div>
          ) : (
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-700 mb-2">✓ Lead qualified — recommended system</p>
              <div className="grid grid-cols-3 gap-2 mb-3">
                <div className="border rounded-lg p-3"><p className="text-[10px] text-gray-400 uppercase">Suggested size <span className="text-blue-500 normal-case">(editable)</span></p>
                  <div className="flex items-baseline gap-1">
                    <input type="number" min="0" step="0.5"
                      value={kwOverride !== '' ? kwOverride : (rec.kw ?? '')}
                      onChange={(e) => setKwOverride(e.target.value)}
                      className="text-xl font-bold w-16 border-b border-gray-300 focus:border-blue-500 outline-none bg-transparent" />
                    <span className="text-sm font-bold">kW</span>
                  </div>
                  {kwOverride !== '' && +kwOverride !== rec.kw && <p className="text-[9px] text-gray-400 mt-0.5">suggested {fmt(rec.kw)} kW</p>}
                </div>
                <div className="border rounded-lg p-3"><p className="text-[10px] text-gray-400 uppercase">System type</p><p className="text-xl font-bold capitalize">{rec.conn}</p></div>
                <div className="border rounded-lg p-3"><p className="text-[10px] text-gray-400 uppercase">Est. units/mo</p><p className="text-xl font-bold">{fmt(rec.est_units)}</p></div>
              </div>
              {rec.flags.length > 0 && (
                <ul className="text-xs space-y-1 mb-3">{rec.flags.map((f, k) => <li key={k} className="text-gray-700">{f}</li>)}</ul>)}
              <p className="text-xs text-gray-500">Saving will store the answers on the lead, mark it <b>Qualified</b>, and pre-fill a quotation with this system.</p>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t flex items-center justify-between">
          <button onClick={back} disabled={i === 0} className="text-sm text-gray-500 flex items-center gap-1 disabled:opacity-30"><FiChevronLeft /> Back</button>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">{prog.done}/{prog.total} answered</span>
            {!atEnd
              ? <button onClick={() => setI(flat.length)} className="btn btn-secondary text-sm">Skip to summary</button>
              : <button onClick={finish} className="btn btn-primary text-sm flex items-center gap-1"><FiZap size={14} /> Save &amp; mark qualified</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

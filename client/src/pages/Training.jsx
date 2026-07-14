// My Training — employee-facing list of assigned videos.
//
// Mam (2026-05-22 Phase 1 Batch E, module #12): each employee sees
// their assigned training, in order (mandatory first), with the
// embedded video player and a Mark Complete button.

import { useEffect, useState } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import {
  FiPlayCircle, FiCheckCircle, FiClock, FiAlertCircle,
} from 'react-icons/fi';

const TYPE_COLOR = {
  product:        'bg-purple-100 text-purple-700',
  process:        'bg-blue-100 text-blue-700',
  communication:  'bg-emerald-100 text-emerald-700',
  sop:            'bg-amber-100 text-amber-700',
  other:          'bg-gray-100 text-gray-700',
};

function toEmbedUrl(url) {
  if (!url) return null;
  let m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([\w-]{11})/);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  m = url.match(/vimeo\.com\/(\d+)/);
  if (m) return `https://player.vimeo.com/video/${m[1]}`;
  return url;
}

export default function Training() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/hr/training/mine');
      setItems(r.data || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const startWatching = async (a) => {
    setOpenId(a.id);
    if (!a.started_at) {
      try { await api.post(`/hr/training/assignments/${a.id}/start`); load(); } catch (_) {}
    }
  };
  const markComplete = async (a) => {
    try {
      await api.post(`/hr/training/assignments/${a.id}/complete`, { note: null });
      toast.success(`Completed: ${a.title}`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  if (loading) return <div className="p-6 text-gray-500">Loading your training…</div>;

  const total = items.length;
  const done  = items.filter(i => i.completed_at).length;
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="bg-gradient-to-r from-indigo-700 to-purple-700 text-white rounded-xl p-6 shadow-md">
        <h2 className="text-2xl font-bold flex items-center gap-2"><FiPlayCircle/> My Training</h2>
        <p className="opacity-90 mt-1 text-sm">{total > 0 ? `${done} of ${total} completed · ${pct}%` : 'No training assigned yet.'}</p>
        {total > 0 && (
          <div className="bg-white/20 rounded-full h-2 overflow-hidden mt-3">
            <div className="h-full bg-white" style={{ width: `${pct}%` }}/>
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <div className="bg-white rounded-lg p-12 text-center shadow-sm">
          <div className="text-5xl mb-3">🎓</div>
          <h3 className="text-lg font-semibold text-gray-800 mb-1">No training assigned yet</h3>
          <p className="text-gray-500 text-sm">Your manager will assign training videos as needed.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(a => {
            const isOpen = openId === a.id;
            const isDone = !!a.completed_at;
            const embed = toEmbedUrl(a.video_url);
            return (
              <div key={a.id} className="bg-white rounded-lg shadow-sm overflow-hidden border border-gray-200">
                <div className="p-4 flex items-start justify-between flex-wrap gap-3">
                  <div className="flex-1 min-w-[200px]">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <h3 className="font-semibold text-gray-900">{a.title}</h3>
                      {!!a.is_mandatory && !isDone && (
                        <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-100 text-red-700 flex items-center gap-1"><FiAlertCircle size={10}/>Mandatory</span>
                      )}
                      <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${TYPE_COLOR[a.training_type] || 'bg-gray-100 text-gray-700'}`}>
                        {a.training_type}
                      </span>
                      {a.duration_minutes && (
                        <span className="text-[10px] text-gray-500 flex items-center gap-0.5"><FiClock size={10}/>{a.duration_minutes} min</span>
                      )}
                    </div>
                    {a.description && <p className="text-[13px] text-gray-600">{a.description}</p>}
                    {isDone && (
                      <div className="text-[11px] text-emerald-700 mt-1 flex items-center gap-1">
                        <FiCheckCircle size={12}/> Completed on {a.completed_at?.slice(0, 10)}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {!isOpen && (
                      <button onClick={() => startWatching(a)} className="btn btn-primary text-[12px] py-1.5 px-3 flex items-center gap-1">
                        <FiPlayCircle size={14}/> {isDone ? 'Re-watch' : a.started_at ? 'Continue' : 'Start'}
                      </button>
                    )}
                    {!isDone && (
                      <button onClick={() => markComplete(a)} className="btn btn-secondary text-[12px] py-1.5 px-3 flex items-center gap-1 text-emerald-700">
                        <FiCheckCircle size={14}/> Mark Complete
                      </button>
                    )}
                  </div>
                </div>
                {isOpen && (
                  <div className="border-t border-gray-200 bg-black">
                    <div className="aspect-video">
                      <iframe src={embed} className="w-full h-full" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen/>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

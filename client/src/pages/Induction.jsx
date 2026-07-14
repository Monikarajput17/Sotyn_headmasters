// Induction — employee-facing welcome dashboard.
//
// Mam (2026-05-22 Phase 1 Batch E, module #11): new employees land
// here on their first day.  Reads from induction_items (admin-managed
// at /hr → Induction tab) and renders the 5 spec sections inline.
//
// Route: /induction (sidebar entry, available to everyone — no module
// gate so even employees with limited permissions can read company
// policies).

import { useEffect, useState } from 'react';
import api from '../api';
import {
  FiAward, FiVideo, FiFileText, FiAlignLeft, FiLink, FiUsers,
  FiShield, FiBookOpen, FiHeart, FiTarget,
} from 'react-icons/fi';

const SECTIONS = [
  { id: 'founder',     label: 'Founder Message',    icon: FiAward,    color: 'from-purple-500 to-purple-700' },
  { id: 'culture',     label: 'Company Culture',    icon: FiHeart,    color: 'from-blue-500 to-blue-700' },
  { id: 'hr_policies', label: 'HR Policies',        icon: FiUsers,    color: 'from-emerald-500 to-emerald-700' },
  { id: 'it_security', label: 'IT &amp; Security',  icon: FiShield,   color: 'from-amber-500 to-amber-700' },
  { id: 'sop',         label: 'SOPs',                icon: FiBookOpen, color: 'from-rose-500 to-rose-700' },
];

// YouTube/Vimeo URL → embed URL
function toEmbedUrl(url) {
  if (!url) return null;
  // YouTube
  let m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([\w-]{11})/);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  // Vimeo
  m = url.match(/vimeo\.com\/(\d+)/);
  if (m) return `https://player.vimeo.com/video/${m[1]}`;
  return url;
}

export default function Induction() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/hr/induction?active=1')
      .then(r => setItems(r.data || []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-6 text-gray-500">Loading induction…</div>;

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-blue-700 to-blue-900 text-white rounded-xl p-6 shadow-md">
        <div className="text-3xl font-bold flex items-center gap-3">
          <FiTarget size={28}/> Welcome to Sotyn.Headmasters
        </div>
        <p className="opacity-90 mt-2 text-sm">
          A short induction so you know the company, our culture, our policies and how we work.
          Watch the videos, read the policies, ask questions in your first 1:1.
        </p>
      </div>

      {SECTIONS.map(sec => {
        const sectionItems = items.filter(it => it.section === sec.id);
        if (sectionItems.length === 0) return null;
        const Icon = sec.icon;
        return (
          <div key={sec.id} className="space-y-3">
            <div className={`bg-gradient-to-r ${sec.color} text-white rounded-lg p-4 flex items-center gap-3`}>
              <Icon size={24}/>
              <h2 className="text-xl font-bold" dangerouslySetInnerHTML={{ __html: sec.label }}/>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {sectionItems.map(it => <InductionItemCard key={it.id} item={it} />)}
            </div>
          </div>
        );
      })}

      {items.length === 0 && (
        <div className="bg-white rounded-lg p-12 text-center shadow-sm">
          <div className="text-5xl mb-3">📚</div>
          <h3 className="text-lg font-semibold text-gray-800 mb-1">No induction content yet</h3>
          <p className="text-gray-500 text-sm">HR is still putting this together. Check back tomorrow.</p>
        </div>
      )}
    </div>
  );
}

function InductionItemCard({ item }) {
  const TypeIcon = { text: FiAlignLeft, video: FiVideo, pdf: FiFileText, link: FiLink }[item.content_type] || FiAlignLeft;
  if (item.content_type === 'video') {
    const embed = toEmbedUrl(item.content_url);
    return (
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="aspect-video bg-black">
          <iframe src={embed} className="w-full h-full" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen/>
        </div>
        <div className="p-3">
          <h4 className="font-semibold text-gray-900 flex items-center gap-1.5"><TypeIcon size={14}/>{item.title}</h4>
        </div>
      </div>
    );
  }
  if (item.content_type === 'pdf') {
    return (
      <div className="bg-white rounded-lg shadow-sm p-4">
        <h4 className="font-semibold text-gray-900 flex items-center gap-1.5 mb-2"><TypeIcon size={14}/>{item.title}</h4>
        <a href={item.content_url} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline text-sm flex items-center gap-1.5">
          <FiFileText/> Open PDF →
        </a>
      </div>
    );
  }
  if (item.content_type === 'link') {
    return (
      <div className="bg-white rounded-lg shadow-sm p-4">
        <h4 className="font-semibold text-gray-900 flex items-center gap-1.5 mb-2"><TypeIcon size={14}/>{item.title}</h4>
        <a href={item.content_url} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline text-sm flex items-center gap-1.5 break-all">
          <FiLink/> {item.content_url}
        </a>
      </div>
    );
  }
  // text
  return (
    <div className="bg-white rounded-lg shadow-sm p-4">
      <h4 className="font-semibold text-gray-900 flex items-center gap-1.5 mb-2"><TypeIcon size={14}/>{item.title}</h4>
      <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{item.content_text}</div>
    </div>
  );
}

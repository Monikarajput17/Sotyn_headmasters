// Sotyn.Headmasters Mantra Banner — SEPL's permanent rule, shown at the top of the
// Dashboard. Mam: 'if it is not in erp, it will not happen' is THE
// rule, not a rotating quote of the day. Keep it big, keep it bold,
// keep it always.

import { FiZap } from 'react-icons/fi';

export default function ErpMantraBanner() {
  return (
    <div className="rounded-xl px-5 py-4 bg-gradient-to-r from-orange-100 via-amber-50 to-blue-100 border-2 border-orange-300 flex items-center gap-4 shadow-sm">
      <div className="shrink-0 p-3 rounded-xl bg-gradient-to-br from-orange-500 to-red-600 text-white">
        <FiZap size={22} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-widest text-orange-700">SEPL Rule</p>
        <p className="text-lg sm:text-xl font-extrabold text-gray-900 mt-0.5 leading-snug uppercase tracking-wide">
          🚨 &ldquo;IF IT IS NOT IN THE Sotyn.Headmasters, IT DID NOT HAPPEN.&rdquo; 🚨
        </p>
      </div>
    </div>
  );
}

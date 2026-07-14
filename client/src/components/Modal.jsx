import { FiX } from 'react-icons/fi';

export default function Modal({ isOpen, onClose, title, children, wide }) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className={`bg-white rounded-xl shadow-xl w-[95vw] ${wide ? 'sm:max-w-[640px] md:max-w-[800px]' : 'sm:max-w-[500px]'} max-h-[90vh] overflow-y-auto mx-2`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-3 sm:p-5 border-b sticky top-0 bg-white z-10">
          <h3 className="text-base sm:text-lg font-semibold truncate pr-2">{title}</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg flex-shrink-0"><FiX size={20} /></button>
        </div>
        <div className="p-3 sm:p-5">{children}</div>
      </div>
    </div>
  );
}

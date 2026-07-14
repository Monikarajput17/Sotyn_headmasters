import { useState, useEffect, useRef } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiTrash2, FiDownload, FiUpload, FiSearch, FiUsers, FiLink, FiLink2 } from 'react-icons/fi';

export default function Employees() {
  const { canDelete, isAdmin, userRoles, user } = useAuth();
  // Salary is confidential — only admins and HR-role users see it
  const canSeeSalary = isAdmin() || (userRoles || []).some(r => String(r).toLowerCase().includes('hr'))
    || String(user?.department || '').toLowerCase().includes('hr');
  const [employees, setEmployees] = useState([]);
  const [users, setUsers] = useState([]);
  const [modal, setModal] = useState(false);
  const [bulkModal, setBulkModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [search, setSearch] = useState('');
  const [bulkData, setBulkData] = useState('');
  const [bulkPreview, setBulkPreview] = useState([]);
  const fileRef = useRef(null);

  const load = () => {
    api.get('/hr/employees').then(r => setEmployees(r.data));
    api.get('/auth/users').then(r => setUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  // Delete an employee — surfaces WHY it's blocked instead of a bare "Delete
  // failed" (mam 2026-07-06). Payroll history → server 400 tells her to
  // deactivate; interview/hiring links → 409 offers Force Delete. Shared by the
  // desktop row AND the mobile card so both behave the same.
  const deleteEmployee = async (e) => {
    if (!confirm(
      `Delete employee "${e.name}"?\n\n` +
      'Tip: if they have left, setting Status to "inactive" / "terminated" (Edit) keeps their ' +
      'salary history and drops them off the active list — that is usually what you want.'
    )) return;
    try {
      await api.delete(`/hr/employees/${e.id}`);
      toast.success('Deleted');
      load();
    } catch (err) {
      if (err.response?.status === 409) {
        const refCount = err.response?.data?.reference_count;
        if (!confirm(
          `Delete blocked — "${e.name}" is still linked to ${refCount || 'some'} interview/hiring record(s).\n\n` +
          'FORCE DELETE will unlink those (interviewer / reporting-manager links) and delete the ' +
          'employee permanently.\n\nProceed with force delete?'
        )) return;
        try {
          await api.delete(`/hr/employees/${e.id}?force=1`);
          toast.success(`Employee "${e.name}" force-deleted`);
          load();
        } catch (err2) {
          toast.error(err2.response?.data?.error || 'Force delete failed');
        }
        return;
      }
      // 400 payroll guard (or anything else) → show the server's reason verbatim
      toast.error(err.response?.data?.error || 'Delete failed');
    }
  };

  // Auto-link employees to users by matching email — for existing records
  const autoLink = async () => {
    try {
      const res = await api.post('/hr/employees/auto-link');
      toast.success(`Linked ${res.data.linked} employee${res.data.linked === 1 ? '' : 's'} by email`);
      load();
    } catch { toast.error('Auto-link failed'); }
  };

  const [uploading, setUploading] = useState(false);

  // Generic file uploader — same pattern as HR.jsx / Inventory.jsx. Posts to
  // /upload, returns the served URL we can stash on the form.
  const uploadFile = async (file) => {
    if (!file) return null;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      return r.data?.url || null;
    } catch {
      toast.error('Upload failed');
      return null;
    } finally { setUploading(false); }
  };

  const save = async (e) => {
    e.preventDefault();
    // Upload any newly-attached document files first, then save the URLs
    // alongside the rest of the employee fields. Existing URLs (when
    // editing) stay untouched if no new file is picked.
    const payload = { ...form };
    delete payload._aadhar_file;
    delete payload._pan_file;
    delete payload._qualification_file;
    if (form._aadhar_file) {
      const url = await uploadFile(form._aadhar_file); if (!url) return;
      payload.aadhar_file = url;
    }
    if (form._pan_file) {
      const url = await uploadFile(form._pan_file); if (!url) return;
      payload.pan_file = url;
    }
    if (form._qualification_file) {
      const url = await uploadFile(form._qualification_file); if (!url) return;
      payload.qualification_file = url;
    }
    // Required-on-create — backend will also reject, but checking here lets
    // mam see the error before the upload spinner spins.
    if (!editing) {
      if (!payload.aadhar_file)        return toast.error('Upload Aadhar card');
      if (!payload.pan_file)           return toast.error('Upload PAN card');
      if (!payload.qualification_file) return toast.error('Upload Highest qualification certificate');
    }
    try {
      if (editing) { await api.put(`/hr/employees/${editing.id}`, payload); }
      else { await api.post('/hr/employees', payload); }
      toast.success(editing ? 'Updated' : 'Created');
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Export CSV — never include salary for non-HR/non-admin users
  const exportCSV = () => {
    if (employees.length === 0) return toast.error('No data');
    const headers = canSeeSalary
      ? ['Name', 'Phone', 'Email', 'Designation', 'Department', 'Join Date', 'Salary', 'Status']
      : ['Name', 'Phone', 'Email', 'Designation', 'Department', 'Join Date', 'Status'];
    const rows = employees.map(e => canSeeSalary
      ? [e.name, e.phone, e.email, e.designation, e.department, e.join_date, e.salary, e.status]
      : [e.name, e.phone, e.email, e.designation, e.department, e.join_date, e.status]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${(c ?? '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `employees-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    toast.success('Exported to CSV');
  };

  // Download template
  const downloadTemplate = () => {
    const csv = 'Name,Phone,Email,Designation,Department,Join Date (YYYY-MM-DD),Salary\nJohn Doe,9876543210,john@example.com,Engineer,Engineering,2024-01-15,50000\nJane Smith,9123456789,jane@example.com,Manager,HR,2024-02-01,60000';
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'employee-bulk-template.csv';
    a.click();
    toast.success('Template downloaded');
  };

  // Parse CSV
  const parseCSV = (text) => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
      if (cols[0]) {
        rows.push({
          name: cols[0] || '',
          phone: cols[1] || '',
          email: cols[2] || '',
          designation: cols[3] || '',
          department: cols[4] || '',
          join_date: cols[5] || '',
          salary: parseFloat(cols[6]) || 0,
        });
      }
    }
    return rows;
  };

  // Handle file upload
  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      setBulkData(text);
      const parsed = parseCSV(text);
      setBulkPreview(parsed);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // Handle paste data
  const handlePaste = (text) => {
    setBulkData(text);
    if (text.trim()) {
      const parsed = parseCSV(text);
      setBulkPreview(parsed);
    } else {
      setBulkPreview([]);
    }
  };

  // Bulk import
  const bulkImport = async () => {
    if (bulkPreview.length === 0) return toast.error('No valid data to import');
    try {
      const res = await api.post('/hr/employees/bulk', { employees: bulkPreview });
      toast.success(`Added ${res.data.added} of ${res.data.total} employees`);
      if (res.data.errors.length > 0) {
        toast.error(`${res.data.errors.length} errors: ${res.data.errors[0]}`);
      }
      setBulkModal(false); setBulkData(''); setBulkPreview([]); load();
    } catch (err) { toast.error('Import failed'); }
  };

  const filtered = employees.filter(e =>
    !search || [e.name, e.phone, e.email, e.designation, e.department].some(f => (f || '').toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold flex items-center gap-2"><FiUsers className="text-red-600" /> Employee Directory</h3>
          <p className="text-sm text-gray-500">{employees.length} total employees</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={exportCSV} className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload size={15} /> Export CSV</button>
          <button onClick={autoLink} className="btn btn-secondary flex items-center gap-2 text-sm" title="Link unlinked employees to users by matching email"><FiLink2 size={15} /> Auto-Link by Email</button>
          <button onClick={() => { setBulkData(''); setBulkPreview([]); setBulkModal(true); }} className="btn btn-secondary flex items-center gap-2 text-sm"><FiUpload size={15} /> Bulk Import</button>
          <button onClick={() => { setEditing(null); setForm({ name: '', phone: '', email: '', designation: '', department: '', join_date: '', salary: 0, user_id: null }); setModal(true); }} className="btn btn-primary flex items-center gap-2"><FiPlus size={15} /> Add Employee</button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
        <input className="input pl-10" placeholder="Search by name, phone, email, designation, department..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {/* Table */}
      <div className="card p-0 hidden md:block"><table className="freeze-head">
        <thead><tr>
          <th>Name</th><th>Phone</th><th>Email</th><th>Designation</th><th>Department</th><th>Join Date</th>
          <th title="Linked user login — needed for DPR Staff Cost auto-calc">Linked User</th>
          {canSeeSalary && <th>Salary</th>}
          <th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody>
          {filtered.map(e => (
            <tr key={e.id}>
              <td className="font-medium">{e.name}</td><td>{e.phone}</td><td>{e.email}</td>
              <td>{e.designation}</td><td>{e.department}</td><td>{e.join_date}</td>
              <td>
                {e.linked_user_name
                  ? <span className="badge badge-green text-[10px] flex items-center gap-1 w-fit"><FiLink size={10} /> {e.linked_user_name}</span>
                  : <span className="badge badge-red text-[10px]">Not linked</span>}
              </td>
              {canSeeSalary && <td className="font-medium">Rs {(e.salary || 0).toLocaleString('en-IN')}</td>}
              <td><StatusBadge status={e.status} /></td>
              <td><div className="flex gap-1">
                <button onClick={() => { setEditing(e); setForm(e); setModal(true); }} className="p-1.5 hover:bg-red-50 rounded text-red-600"><FiEdit2 size={15} /></button>
                {canDelete('employees') && <button onClick={() => deleteEmployee(e)} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
              </div></td>
            </tr>
          ))}
          {filtered.length === 0 && <tr><td colSpan={canSeeSalary ? 10 : 9} className="text-center py-8 text-gray-400">No employees found</td></tr>}
        </tbody>
      </table></div>

      {/* Mobile cards (mam 2026-06-02) — polished employee card list */}
      <div className="md:hidden space-y-3">
        {filtered.length === 0 && (
          <div className="card p-6 text-center text-gray-400 text-sm">No employees found</div>
        )}
        {filtered.map(e => (
          <div key={e.id} className="card p-3 space-y-2">
            <div className="flex justify-between items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Employee</div>
                <div className="text-lg font-bold text-gray-900 truncate">{e.name}</div>
                {e.designation && <div className="text-[11px] text-gray-600">{e.designation}</div>}
                {e.department && <div className="text-[10px] text-gray-400">{e.department}</div>}
              </div>
              <StatusBadge status={e.status} />
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1 border-t border-gray-100 text-[11px]">
              {e.phone && (
                <a href={`tel:${e.phone}`} className="text-blue-600 hover:underline">
                  <div className="text-[9px] uppercase text-gray-400">Phone</div>
                  <div className="font-semibold">📞 {e.phone}</div>
                </a>
              )}
              {e.email && (
                <a href={`mailto:${e.email}`} className="text-blue-600 hover:underline truncate" title={e.email}>
                  <div className="text-[9px] uppercase text-gray-400">Email</div>
                  <div className="font-semibold truncate">✉ {e.email}</div>
                </a>
              )}
              {e.join_date && (
                <div>
                  <div className="text-[9px] uppercase text-gray-400">Join Date</div>
                  <div className="font-semibold text-gray-700">{e.join_date}</div>
                </div>
              )}
              {canSeeSalary && (
                <div>
                  <div className="text-[9px] uppercase text-gray-400">Salary</div>
                  <div className="font-semibold text-emerald-700">Rs {(e.salary || 0).toLocaleString('en-IN')}</div>
                </div>
              )}
            </div>
            <div className="pt-1 border-t border-gray-100">
              <div className="text-[9px] uppercase text-gray-400">Linked User</div>
              {e.linked_user_name
                ? <span className="text-[11px] font-semibold text-emerald-700 flex items-center gap-1"><FiLink size={10} /> {e.linked_user_name}</span>
                : <span className="text-[11px] font-semibold text-red-600">Not linked — DPR Staff Cost won't include this employee</span>}
            </div>
            <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-100 text-xs">
              <button onClick={() => { setEditing(e); setForm(e); setModal(true); }} className="text-blue-600 hover:underline flex items-center gap-1 font-semibold">
                <FiEdit2 size={11} /> Edit
              </button>
              {canDelete('employees') && (
                <button onClick={() => deleteEmployee(e)} className="text-red-600 hover:underline flex items-center gap-1 font-semibold">
                  <FiTrash2 size={11} /> Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Add/Edit Modal */}
      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? 'Edit Employee' : 'Add Employee'}>
        <form onSubmit={save} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label">Name *</label><input className="input" value={form.name || ''} onChange={e => setForm({...form, name: e.target.value})} required /></div>
            <div><label className="label">Phone</label><input className="input" value={form.phone || ''} onChange={e => setForm({...form, phone: e.target.value})} /></div>
            <div><label className="label">Email</label><input className="input" value={form.email || ''} onChange={e => setForm({...form, email: e.target.value})} /></div>
            <div><label className="label">Designation</label><input className="input" list="empDesigDL" value={form.designation || ''} onChange={e => setForm({...form, designation: e.target.value})} placeholder="Pick or type" /><datalist id="empDesigDL">{[...new Set(employees.map(e => e.designation).filter(Boolean))].map(d => <option key={d} value={d} />)}</datalist></div>
            <div><label className="label">Department</label><input className="input" list="empDeptDL" value={form.department || ''} onChange={e => setForm({...form, department: e.target.value})} placeholder="Pick or type" /><datalist id="empDeptDL">{[...new Set(employees.map(e => e.department).filter(Boolean))].map(d => <option key={d} value={d} />)}</datalist></div>
            <div><label className="label">Join Date</label><input className="input" type="date" value={form.join_date || ''} onChange={e => setForm({...form, join_date: e.target.value})} /></div>
            {canSeeSalary && <div><label className="label">Salary (Rs)</label><input className="input" type="number" value={form.salary || 0} onChange={e => setForm({...form, salary: +e.target.value})} /></div>}
            {editing && <div><label className="label">Status</label><select className="select" value={form.status || ''} onChange={e => setForm({...form, status: e.target.value})}>{['active','training','inactive','terminated'].map(s => <option key={s} value={s}>{s}</option>)}</select></div>}
            <div className="col-span-2">
              <label className="label flex items-center gap-1"><FiLink size={12} /> Linked Login User <span className="text-gray-400 font-normal">(required for DPR Staff Cost auto-calc)</span></label>
              <SearchableSelect
                options={users.map(u => ({ ...u, label: `${u.name} (${u.username || u.email})` }))}
                value={form.user_id || null}
                valueKey="id"
                displayKey="label"
                placeholder="Search by name, username or email…"
                onChange={(u) => setForm({ ...form, user_id: u?.id || null })}
              />
              <p className="text-[10px] text-gray-500 mt-0.5">If left blank and email matches a user, it will auto-link on save.</p>
            </div>
          </div>

          {/* Mandatory KYC docs for new employees. When editing, the inputs
              show "Existing: view file" if a doc URL is already on file —
              uploading a new one replaces it. Three docs: Aadhar, PAN,
              Highest qualification certificate. */}
          <div className="card p-3 bg-amber-50/40 border-l-4 border-amber-400 space-y-3">
            <div className="text-xs font-semibold text-amber-800 uppercase tracking-wide">Mandatory documents{editing ? '' : ' *'}</div>
            {[
              { key: 'aadhar_file',        slot: '_aadhar_file',        label: 'Aadhar Card *' },
              { key: 'pan_file',           slot: '_pan_file',           label: 'PAN Card *' },
              { key: 'qualification_file', slot: '_qualification_file', label: 'Highest Qualification Certificate *' },
            ].map(({ key, slot, label }) => (
              <div key={key}>
                <label className="label">{label} <span className="text-gray-400 font-normal text-[10px]">(PDF / JPG / PNG, max 10 MB)</span></label>
                <input
                  className="input"
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  required={!editing && !form[key]}
                  onChange={e => setForm({ ...form, [slot]: e.target.files?.[0] || null })}
                />
                {/* Existing URL link when editing */}
                {editing && form[key] && !form[slot] && (
                  <p className="text-[10px] text-emerald-600 mt-0.5">
                    Existing: <a href={form[key]} target="_blank" rel="noreferrer" className="underline">view file</a> · upload to replace
                  </p>
                )}
                {form[slot] && <p className="text-[10px] text-blue-600 mt-0.5">Selected: {form[slot].name}</p>}
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={uploading} className="btn btn-primary">
              {uploading ? 'Uploading…' : (editing ? 'Update' : 'Create')}
            </button>
          </div>
        </form>
      </Modal>

      {/* Bulk Import Modal */}
      <Modal isOpen={bulkModal} onClose={() => setBulkModal(false)} title="Bulk Import Employees" wide>
        <div className="space-y-4">
          <div className="bg-red-50 p-3 rounded-lg text-sm text-red-700">
            <p className="font-semibold mb-1">How to bulk import:</p>
            <ol className="list-decimal ml-4 space-y-1">
              <li>Download the CSV template below</li>
              <li>Fill in your employee data (keep the header row)</li>
              <li>Upload the CSV file or paste the data below</li>
              <li>Review the preview and click Import</li>
            </ol>
          </div>

          <button onClick={downloadTemplate} className="btn btn-secondary text-sm flex items-center gap-2"><FiDownload size={14} /> Download CSV Template</button>

          <div>
            <label className="label">Upload CSV File</label>
            <input ref={fileRef} type="file" accept=".csv,.txt" onChange={handleFile}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" />
          </div>

          <div>
            <label className="label">Or Paste CSV Data</label>
            <textarea className="input font-mono text-xs" rows="6" placeholder="Name,Phone,Email,Designation,Department,Join Date,Salary&#10;John Doe,9876543210,john@example.com,Engineer,Engineering,2024-01-15,50000"
              value={bulkData} onChange={e => handlePaste(e.target.value)} />
          </div>

          {/* Preview */}
          {bulkPreview.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-gray-700 mb-2">Preview: {bulkPreview.length} employees to import</p>
              <div className="max-h-60 overflow-y-auto border rounded-lg">
                <table className="min-w-full text-xs">
                  <thead><tr className="bg-gray-50"><th className="px-2 py-1.5">Name</th><th className="px-2 py-1.5">Phone</th><th className="px-2 py-1.5">Email</th><th className="px-2 py-1.5">Designation</th><th className="px-2 py-1.5">Department</th><th className="px-2 py-1.5">Join Date</th><th className="px-2 py-1.5">Salary</th></tr></thead>
                  <tbody>
                    {bulkPreview.map((e, i) => (
                      <tr key={i} className={!e.name ? 'bg-red-50' : ''}>
                        <td className="px-2 py-1.5 font-medium">{e.name || '(empty)'}</td>
                        <td className="px-2 py-1.5">{e.phone}</td><td className="px-2 py-1.5">{e.email}</td>
                        <td className="px-2 py-1.5">{e.designation}</td><td className="px-2 py-1.5">{e.department}</td>
                        <td className="px-2 py-1.5">{e.join_date}</td><td className="px-2 py-1.5">{e.salary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2 border-t">
            <button onClick={() => setBulkModal(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={bulkImport} disabled={bulkPreview.length === 0} className="btn btn-primary flex items-center gap-2 disabled:opacity-50">
              <FiUpload size={14} /> Import {bulkPreview.length} Employees
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

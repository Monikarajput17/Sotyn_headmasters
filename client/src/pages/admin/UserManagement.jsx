import { useState, useEffect } from 'react';
import api from '../../api';
import Modal from '../../components/Modal';
import StatusBadge from '../../components/StatusBadge';
import Pagination, { usePagination } from '../../components/Pagination';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiUserX, FiUserCheck, FiKey, FiUpload, FiDownload, FiMapPin, FiEyeOff, FiTrash2, FiArchive, FiRotateCcw, FiSearch, FiX } from 'react-icons/fi';

export default function UserManagement() {
  const [users, setUsers] = useState([]);
  const [filter, setFilter] = useState('all');   // all | active | inactive | admin — status filter tabs
  const [search, setSearch]   = useState('');    // search by username or email
  const [page, setPage]       = useState(1);
  const [perPage, setPerPage] = useState(15);     // 15 entries per page
  const [roles, setRoles] = useState([]);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [selectedRoles, setSelectedRoles] = useState([]);
  const [bulkModal, setBulkModal] = useState(false);
  const [bulkData, setBulkData] = useState('');
  const [bulkPreview, setBulkPreview] = useState([]);
  // Admin password reset
  const [resetUser, setResetUser] = useState(null);        // user being reset
  const [resetInput, setResetInput] = useState('');        // optional custom password typed by admin
  const [revealedPassword, setRevealedPassword] = useState(null); // { user, password } shown once after reset

  const load = () => {
    api.get('/auth/users').then(r => setUsers(r.data));
    api.get('/auth/roles').then(r => setRoles(r.data));
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', email: '', username: '', password: '', role: 'user', department: '', phone: '', active: true, approval_role: '' });
    setSelectedRoles([]);
    setModal(true);
  };

  const openEdit = (user) => {
    setEditing(user);
    setForm({ ...user, password: '', active: !!user.active });
    // Parse existing roles
    const currentRoleNames = user.role_names ? user.role_names.split(',') : [];
    const roleIds = roles.filter(r => currentRoleNames.includes(r.name)).map(r => r.id);
    setSelectedRoles(roleIds);
    setModal(true);
  };

  const save = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        await api.put(`/auth/users/${editing.id}`, { ...form, role_ids: selectedRoles });
        toast.success('User updated');
      } else {
        if (!form.password) return toast.error('Password is required');
        await api.post('/auth/register', { ...form, role_ids: selectedRoles });
        toast.success('User created');
      }
      setModal(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error');
    }
  };

  const toggleActive = async (user) => {
    await api.put(`/auth/users/${user.id}`, { ...user, active: !user.active, role_ids: undefined });
    toast.success(user.active ? 'User deactivated' : 'User activated');
    load();
  };

  // Archive (hide from all lists, keep every record) or restore (mam 2026-07-02).
  const archiveUser = async (user, archived) => {
    try {
      const r = await api.patch(`/auth/users/${user.id}/archive`, { archived: archived ? 1 : 0 });
      toast.success(r.data?.message || (archived ? 'Archived' : 'Restored'));
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Hard delete a user. Two-step confirm (so it's hard to fumble) and we
  // surface the backend error verbatim if it's blocked by FK references
  // (e.g. user is the created_by on indents / payments / etc.).
  const deleteUser = async (user) => {
    const first = confirm(
      `Delete user "${user.name}" (${user.email || user.username})?\n\n` +
      'This is permanent. Their login disappears and any audit trail referencing them as a creator may break.\n\n' +
      'Tip: if you just want to stop them logging in, use the "Deactivate" button instead — that\'s reversible.'
    );
    if (!first) return;
    const typed = prompt(`Type "DELETE ${user.name}" exactly to confirm:`);
    if (typed !== `DELETE ${user.name}`) {
      toast('Cancelled — confirmation text did not match');
      return;
    }
    try {
      await api.delete(`/auth/users/${user.id}`);
      toast.success(`User "${user.name}" deleted`);
      load();
    } catch (err) {
      // Mam (2026-05-22): when FK refs block the regular delete,
      // offer Force Delete (server nulls every FK ref pointing at
      // this user, then deletes the row).  Used for ex-employees
      // where she really wants the user GONE, not just deactivated.
      const status = err.response?.status;
      const refCount = err.response?.data?.reference_count;
      if (status === 409) {
        const ok = confirm(
          `Regular delete failed — this user is referenced on ${refCount || 'several'} other rows ` +
          `(indents created, candidates added, payment approvals, etc.).\n\n` +
          `FORCE DELETE will:\n` +
          `  • Set all those references to NULL (old rows keep working — just lose the "created by" link)\n` +
          `  • KEEP their attendance records (unlinked, but the name is preserved) — salary history stays intact\n` +
          `  • Then delete the user permanently\n\n` +
          `Audit-trail snapshots (denormalised "user_name" fields) stay intact.\n\n` +
          `Proceed with force delete?`
        );
        if (!ok) return;
        try {
          const r = await api.delete(`/auth/users/${user.id}?force=1`);
          const att = r.data?.attendance_preserved || 0;
          toast.success(
            `User "${user.name}" force-deleted (${r.data?.cleared_total || 0} references nulled` +
            (att > 0 ? `, ${att} attendance record${att === 1 ? '' : 's'} kept` : '') + ')'
          );
          load();
        } catch (err2) {
          toast.error(err2.response?.data?.error || 'Force delete failed');
        }
        return;
      }
      toast.error(err.response?.data?.error || 'Delete failed — try Deactivate instead');
    }
  };

  // Per-user opt-out from Admin → Location Tracking. Admins, office staff,
  // anyone mam doesn't want to see on the live map gets toggled off here.
  const toggleTrackLocation = async (user) => {
    const next = user.track_location ? 0 : 1;
    try {
      await api.patch(`/auth/users/${user.id}/track-location`, { track_location: next });
      toast.success(next ? `${user.name} now appears in Location Tracking` : `${user.name} hidden from Location Tracking`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
    load();
  };

  const toggleRole = (roleId) => {
    setSelectedRoles(prev => prev.includes(roleId) ? prev.filter(r => r !== roleId) : [...prev, roleId]);
  };

  // Admin password reset — backend returns the new plain password ONCE so
  // admin can share it with the user. Stored passwords are bcrypt-hashed and
  // cannot be recovered, so "set + reveal once" is the safe equivalent.
  const submitReset = async (e) => {
    e.preventDefault();
    if (!resetUser) return;
    try {
      const payload = resetInput ? { new_password: resetInput } : {};
      const res = await api.post(`/auth/users/${resetUser.id}/reset-password`, payload);
      setRevealedPassword({ user: res.data.user, password: res.data.new_password });
      setResetUser(null);
      setResetInput('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Reset failed');
    }
  };

  const copyPassword = async () => {
    if (!revealedPassword?.password) return;
    try {
      await navigator.clipboard.writeText(revealedPassword.password);
      toast.success('Password copied to clipboard');
    } catch { toast.error('Copy failed — select and copy manually'); }
  };

  // Status filter for the list (mam 2026-07-02). Archived users are hidden from
  // every tab except the dedicated "Archived" one.
  const matchFilter = (u) => filter === 'archived' ? !!u.archived
    : u.archived ? false
    : filter === 'active' ? !!u.active
    : filter === 'inactive' ? !u.active
    : filter === 'admin' ? u.role === 'admin'
    : true;

  // Status tab + search (username/email) combined, then paginated (15/page).
  const q = search.trim().toLowerCase();
  const filteredUsers = users.filter(u =>
    matchFilter(u) &&
    (!q || [u.username, u.email].some(v => String(v || '').toLowerCase().includes(q)))
  );
  const pg = usePagination(filteredUsers, perPage, page, setPage);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-xl font-bold text-gray-800">User Management</h3>
          <p className="text-sm text-gray-500">Create users and assign roles to control access</p>
        </div>
        <div className="flex gap-2">
          <button onClick={async () => {
            try {
              const r = await api.get('/auth/users/export.xlsx', { responseType: 'blob' });
              const url = URL.createObjectURL(r.data);
              const a = document.createElement('a');
              a.href = url; a.download = `active-users-${new Date().toISOString().slice(0, 10)}.xlsx`;
              document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
            } catch { toast.error('Export failed'); }
          }} className="btn btn-secondary flex items-center gap-2" title="Active users + salary (from Employees)"><FiDownload size={15} /> Export Excel</button>
          <button onClick={() => { setBulkData(''); setBulkPreview([]); setBulkModal(true); }} className="btn btn-secondary flex items-center gap-2"><FiUpload size={15} /> Bulk Import</button>
          <button onClick={openCreate} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add User</button>
        </div>
      </div>

      {/* Info Cards — click one to filter the list (mam 2026-07-02: a tab to
          see just the Inactive users, which were buried among the Active ones). */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {[
          { key: 'all',      label: 'Total Users', count: users.filter(u => !u.archived).length,                       color: 'text-red-600' },
          { key: 'active',   label: 'Active',      count: users.filter(u => u.active && !u.archived).length,           color: 'text-emerald-600' },
          { key: 'inactive', label: 'Inactive',    count: users.filter(u => !u.active && !u.archived).length,          color: 'text-red-600' },
          { key: 'admin',    label: 'Admins',      count: users.filter(u => u.role === 'admin' && !u.archived).length, color: 'text-purple-600' },
          { key: 'archived', label: 'Archived',    count: users.filter(u => u.archived).length,                        color: 'text-gray-500' },
        ].map(c => (
          <button key={c.key} type="button" onClick={() => { setFilter(c.key); setPage(1); }}
            className={`card text-center transition ${filter === c.key ? 'ring-2 ring-red-500 ring-offset-1' : 'hover:bg-gray-50 opacity-90 hover:opacity-100'}`}>
            <div className={`text-3xl font-bold ${c.color}`}>{c.count}</div>
            <div className="text-sm text-gray-500">{c.label}</div>
          </button>
        ))}
      </div>

      <div className="card p-0 overflow-x-auto">
        <div className="px-4 py-3 border-b bg-gray-50/60">
          <div className="relative w-full max-w-xs">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
            <input className={`input pl-10 ${search ? 'pr-9' : ''}`} placeholder="Search username or email…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }} />
            {search && (
              <button type="button" onClick={() => { setSearch(''); setPage(1); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                title="Clear search" aria-label="Clear search">
                <FiX size={16} />
              </button>
            )}
          </div>
        </div>
        {filter !== 'all' && (
          <div className="px-4 py-2 text-xs text-gray-500 border-b bg-gray-50/60 flex items-center justify-between">
            <span>Showing <b className="text-gray-700">{filteredUsers.length}</b> {filter} user{filteredUsers.length === 1 ? '' : 's'}</span>
            <button type="button" onClick={() => { setFilter('all'); setPage(1); }} className="text-red-600 hover:underline font-medium">Show all users</button>
          </div>
        )}
        <table>
          <thead>
            <tr><th>Name</th><th>Username</th><th>Email</th><th>Phone</th><th>System Role</th><th>Assigned Roles</th><th>Department</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {pg.rows.map(u => (
              <tr key={u.id}>
                <td className="font-medium">
                  <div className="flex items-center gap-2">
                    {u.avatar_url
                      ? <img src={u.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover border shrink-0" />
                      : <span className="w-8 h-8 rounded-full bg-gray-200 text-gray-500 flex items-center justify-center text-xs font-bold shrink-0">{(u.name || '?').slice(0, 1).toUpperCase()}</span>}
                    <span>{u.name}</span>
                  </div>
                </td>
                <td className="font-mono text-xs text-red-700">{u.username || <span className="text-gray-300">—</span>}</td>
                <td className="text-gray-600">{u.email}</td>
                <td>{u.phone}</td>
                <td>
                  <span className={`badge ${u.role === 'admin' ? 'badge-red' : u.role === 'manager' ? 'badge-purple' : 'badge-blue'}`}>{u.role}</span>
                  {u.approval_role === 'l1' && <span className="ml-1 inline-block text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300" title="L1 Indent Approver">L1</span>}
                  {u.approval_role === 'l2' && <span className="ml-1 inline-block text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 border border-purple-300" title="L2 Indent Approver">L2</span>}
                  {u.approval_role === 'hr' && <span className="ml-1 inline-block text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-teal-100 text-teal-700 border border-teal-300" title="HR Indent Approver (RGP)">HR</span>}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {u.role_names ? u.role_names.split(',').map((r, i) => (
                      <span key={i} className="badge badge-green text-[10px]">{r}</span>
                    )) : <span className="text-xs text-gray-400">No roles</span>}
                  </div>
                </td>
                <td>{u.department}</td>
                <td>{u.active ? <span className="badge badge-green">Active</span> : <span className="badge badge-red">Inactive</span>}</td>
                <td>
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(u)} className="p-1.5 hover:bg-red-50 rounded text-red-600" title="Edit"><FiEdit2 size={15} /></button>
                    <button onClick={() => { setResetUser(u); setResetInput('123'); }} className="p-1.5 hover:bg-amber-50 rounded text-amber-600" title="Reset password">
                      <FiKey size={15} />
                    </button>
                    {/* Activate/Deactivate + Track — only for non-archived users
                        (mam 2026-07-02: the labelled toggle replaced an icon-only one). */}
                    {!u.archived && (<>
                    <button onClick={() => toggleActive(u)}
                      className={`px-2 py-1 rounded text-xs font-semibold flex items-center gap-1 border whitespace-nowrap ${u.active ? 'text-red-600 border-red-200 hover:bg-red-50' : 'text-green-700 border-green-300 bg-green-50 hover:bg-green-100'}`}
                      title={u.active ? 'Deactivate this user — blocks login, keeps all data' : 'Activate this user'}>
                      {u.active ? <FiUserX size={13} /> : <FiUserCheck size={13} />}
                      {u.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button onClick={() => toggleTrackLocation(u)}
                      className={`p-1.5 rounded ${u.track_location ? 'hover:bg-amber-50 text-amber-600' : 'hover:bg-emerald-50 text-emerald-600'}`}
                      title={u.track_location ? 'Hide from Location Tracking' : 'Show in Location Tracking'}>
                      {u.track_location ? <FiMapPin size={15} /> : <FiEyeOff size={15} />}
                    </button>
                    </>)}
                    {/* Archive (hide from all lists, keep every record) / Restore —
                        mam 2026-07-02: the safe way to "remove" a user with salary data. */}
                    <button onClick={() => archiveUser(u, !u.archived)}
                      className={`px-2 py-1 rounded text-xs font-semibold flex items-center gap-1 border whitespace-nowrap ${u.archived ? 'text-emerald-700 border-emerald-300 bg-emerald-50 hover:bg-emerald-100' : 'text-gray-600 border-gray-300 hover:bg-gray-50'}`}
                      title={u.archived ? 'Restore this user to the Inactive list' : 'Archive — hide from all lists but keep every record (attendance, salary)'}>
                      {u.archived ? <FiRotateCcw size={13} /> : <FiArchive size={13} />}
                      {u.archived ? 'Restore' : 'Archive'}
                    </button>
                    {/* Hard delete — admin's escape hatch when a user really
                        needs to be removed (typo, wrong invite, employee left).
                        Two-step confirmation prompts inside deleteUser to
                        guard against accidental clicks. */}
                    <button onClick={() => deleteUser(u)} className="p-1.5 hover:bg-red-100 rounded text-red-700" title="Delete user (permanent)">
                      <FiTrash2 size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination pg={pg} setPerPage={setPerPage} className="border-t border-gray-100" />
      </div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? 'Edit User' : 'Create New User'} wide>
        <form onSubmit={save} className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            {/* Employee photo (mam 2026-06-23) — upload via /api/upload, stored as avatar_url */}
            <div className="col-span-2 flex items-center gap-3">
              {form.avatar_url
                ? <img src={form.avatar_url} alt="" className="w-16 h-16 rounded-full object-cover border" />
                : <span className="w-16 h-16 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center text-xl font-bold border">{(form.name || '?').slice(0, 1).toUpperCase()}</span>}
              <div>
                <label className="label">Employee Photo</label>
                {form.avatar_url ? (
                  <button type="button" onClick={() => setForm(f => ({ ...f, avatar_url: '' }))} className="text-red-500 text-xs underline">Remove photo</button>
                ) : (
                  <input type="file" accept="image/*" className="text-xs" onChange={async e => {
                    const file = e.target.files?.[0]; if (!file) return;
                    const fd = new FormData(); fd.append('file', file);
                    try { const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }); setForm(f => ({ ...f, avatar_url: r.data.url })); toast.success('Photo uploaded'); }
                    catch { toast.error('Upload failed'); }
                    e.target.value = '';
                  }} />
                )}
              </div>
            </div>
            <div><label className="label">Full Name *</label><input className="input" value={form.name || ''} onChange={e => setForm({...form, name: e.target.value})} required /></div>
            <div>
              <label className="label">Username</label>
              <input className="input font-mono" value={form.username || ''} onChange={e => setForm({...form, username: e.target.value.replace(/\s+/g, '.')})} placeholder="e.g. Monika.devi" />
              <p className="text-[10px] text-gray-400 mt-0.5">Staff will log in with this. Leave blank to use email only.</p>
            </div>
            <div><label className="label">Email *</label><input className="input" type="email" value={form.email || ''} onChange={e => setForm({...form, email: e.target.value})} required /></div>
            <div><label className="label">Phone</label><input className="input" value={form.phone || ''} onChange={e => setForm({...form, phone: e.target.value})} /></div>
            <div><label className="label">Department</label><input className="input" value={form.department || ''} onChange={e => setForm({...form, department: e.target.value})} /></div>
            <div>
              <label className="label">{editing ? 'New Password (leave blank to keep)' : 'Password *'}</label>
              <input className="input" type="password" value={form.password || ''} onChange={e => setForm({...form, password: e.target.value})} {...(!editing && { required: true })} />
            </div>
            <div>
              <label className="label">System Role</label>
              <select className="select" value={form.role || 'user'} onChange={e => setForm({...form, role: e.target.value})}>
                <option value="user">User</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            {/* Indent Approval Role field removed from this form (mam 2026-07-02):
                it's assigned inside the Indent module, not on user create/edit.
                approval_role stays in form state so editing a user never wipes it
                (the PUT /users route doesn't touch that column anyway). */}
          </div>

          {/* Role Assignment */}
          <div>
            <label className="label flex items-center gap-2"><FiKey size={14} /> Assign Permission Roles</label>
            <p className="text-xs text-gray-500 mb-3">Select which roles this user should have. Each role grants specific permissions to modules.</p>
            <div className="grid grid-cols-2 gap-2">
              {roles.map(r => (
                <label key={r.id} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${selectedRoles.includes(r.id) ? 'bg-red-50 border-red-300' : 'bg-gray-50 border-gray-200 hover:bg-gray-100'}`}>
                  <input
                    type="checkbox"
                    checked={selectedRoles.includes(r.id)}
                    onChange={() => toggleRole(r.id)}
                    className="w-4 h-4 text-red-600"
                  />
                  <div>
                    <div className="text-sm font-medium">{r.name}</div>
                    <div className="text-xs text-gray-500">{r.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {editing && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.active} onChange={e => setForm({...form, active: e.target.checked})} className="w-4 h-4" />
              <span>User is Active</span>
            </label>
          )}

          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update User' : 'Create User'}</button>
          </div>
        </form>
      </Modal>

      {/* Bulk Import Modal */}
      <Modal isOpen={bulkModal} onClose={() => setBulkModal(false)} title="Bulk Import Users" wide>
        <div className="space-y-4">
          <div className="bg-red-50 p-3 rounded-lg text-sm text-red-700">
            <p className="font-semibold mb-1">CSV Format: Name, Email, Phone, Department, Role Name</p>
            <p className="text-xs">Default password: <strong>sepl@123</strong> (users can change later)</p>
          </div>
          <button onClick={() => {
            const csv = 'Name,Email,Phone,Department,Role Name\nGurcharan Singh,gurcharan@gmail.com,88723 20800,Operation,Site Engineer\nKuldeep Bharti,kuldeep@gmail.com,70505 14246,Operation,Site Engineer';
            const blob = new Blob([csv], { type: 'text/csv' }); const a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = 'users-bulk-template.csv'; a.click();
          }} className="btn btn-secondary text-sm flex items-center gap-2"><FiDownload size={14} /> Download Template</button>
          <div><label className="label">Upload CSV</label>
            <input type="file" accept=".csv,.txt" onChange={(e) => {
              const file = e.target.files[0]; if (!file) return;
              const reader = new FileReader();
              reader.onload = (ev) => {
                const text = ev.target.result; setBulkData(text);
                const lines = text.trim().split('\n');
                if (lines.length < 2) return setBulkPreview([]);
                setBulkPreview(lines.slice(1).map(line => {
                  const c = line.split(',').map(v => v.replace(/^"|"$/g, '').trim());
                  return c[0] ? { name: c[0], email: c[1], phone: c[2], department: c[3], role_name: c[4] } : null;
                }).filter(Boolean));
              };
              reader.readAsText(file); e.target.value = '';
            }} className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700" />
          </div>
          <div><label className="label">Or Paste CSV</label>
            <textarea className="input font-mono text-xs" rows="5" value={bulkData} onChange={e => {
              setBulkData(e.target.value);
              const lines = e.target.value.trim().split('\n');
              setBulkPreview(lines.length > 1 ? lines.slice(1).map(line => {
                const c = line.split(',').map(v => v.replace(/^"|"$/g, '').trim());
                return c[0] ? { name: c[0], email: c[1], phone: c[2], department: c[3], role_name: c[4] } : null;
              }).filter(Boolean) : []);
            }} placeholder="Name,Email,Phone,Department,Role Name" />
          </div>
          {bulkPreview.length > 0 && (
            <div><p className="text-sm font-semibold mb-2">{bulkPreview.length} users to import</p>
              <div className="max-h-48 overflow-y-auto border rounded text-xs"><table><thead><tr className="bg-gray-50"><th className="px-2 py-1">Name</th><th className="px-2 py-1">Email</th><th className="px-2 py-1">Phone</th><th className="px-2 py-1">Dept</th><th className="px-2 py-1">Role</th></tr></thead>
                <tbody>{bulkPreview.map((u, i) => <tr key={i}><td className="px-2 py-1 font-medium">{u.name}</td><td className="px-2 py-1">{u.email}</td><td className="px-2 py-1">{u.phone}</td><td className="px-2 py-1">{u.department}</td><td className="px-2 py-1">{u.role_name}</td></tr>)}</tbody></table></div>
            </div>
          )}
          <div className="flex justify-end gap-3">
            <button onClick={() => setBulkModal(false)} className="btn btn-secondary">Cancel</button>
            <button disabled={bulkPreview.length === 0} onClick={async () => {
              try {
                const res = await api.post('/auth/bulk-import', { users: bulkPreview });
                toast.success(`Added ${res.data.added} of ${res.data.total} users`);
                if (res.data.errors.length > 0) toast.error(res.data.errors[0]);
                setBulkModal(false); load();
              } catch { toast.error('Import failed'); }
            }} className="btn btn-primary flex items-center gap-2 disabled:opacity-50"><FiUpload size={14} /> Import {bulkPreview.length} Users</button>
          </div>
        </div>
      </Modal>

      {/* Admin: Reset Password — confirm & optionally set custom password */}
      <Modal isOpen={!!resetUser} onClose={() => { setResetUser(null); setResetInput(''); }} title={resetUser ? `Reset password — ${resetUser.name}` : 'Reset password'}>
        <form onSubmit={submitReset} className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
            <p className="font-semibold mb-1">Why can't I see the old password?</p>
            <p>Passwords are one-way encrypted (bcrypt) — nobody can recover the original, not even the server. Instead you can set a new one and share it with the user through a secure channel. The user can change it themselves via "Change Password".</p>
          </div>
          <div>
            <label className="label">New password (leave blank to auto-generate)</label>
            <input className="input" type="text" placeholder="e.g. Welcome@123 — or leave blank for a random password" value={resetInput} onChange={e => setResetInput(e.target.value)} />
            <p className="text-[10px] text-gray-500 mt-1">Min 6 characters when typed. Auto-generated passwords are 10 chars, mixed case + digits.</p>
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => { setResetUser(null); setResetInput(''); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary flex items-center gap-2"><FiKey size={14} /> Reset & Show Once</button>
          </div>
        </form>
      </Modal>

      {/* Admin: Reveal new password ONCE after a successful reset */}
      <Modal isOpen={!!revealedPassword} onClose={() => setRevealedPassword(null)} title={revealedPassword ? `New password for ${revealedPassword.user.name}` : 'New password'}>
        <div className="space-y-3">
          <p className="text-sm text-gray-600">Share this password with the user via a secure channel (in person, internal chat). It will NOT be shown again.</p>
          <div className="bg-gray-900 text-white rounded-lg p-4 font-mono text-lg tracking-wider text-center select-all break-all">
            {revealedPassword?.password}
          </div>
          <div className="flex justify-between gap-3">
            <button type="button" onClick={copyPassword} className="btn btn-secondary flex items-center gap-2"><FiKey size={14} /> Copy</button>
            <button type="button" onClick={() => setRevealedPassword(null)} className="btn btn-primary">I've shared it — Close</button>
          </div>
          <p className="text-[10px] text-amber-700 text-center">Tell the user to change their password after login.</p>
        </div>
      </Modal>
    </div>
  );
}

import { useState, useEffect } from 'react';
import api from '../../api';
import Modal from '../../components/Modal';
import AttendanceAccessSetup from '../../components/AttendanceAccessSetup';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiTrash2, FiShield, FiCheck, FiX } from 'react-icons/fi';

// Order + labels mirror the sidebar so admins recognise each module
// at a glance. Keys (used by backend role_permissions) stay unchanged —
// renaming 'Procurement' to 'Indent to Dispatch' is UI-only.
// Mam (2026-05-21): "add all module in roles& permission".  Keep this
// list in sync with server/db/schema.js ALL_MODULES — every module
// permission-gated in the Sotyn.Headmasters needs a row here so admin can grant /
// revoke access.  Grouped by sidebar section for readability; keys
// (used by backend role_permissions) are unchanged.
const ALL_MODULES = [
  { key: 'dashboard', label: 'Dashboard' },
  // ─── Salon ───
  { key: 'salon_appointments', label: 'Salon · Appointments' },
  { key: 'salon_pos', label: 'Salon · Billing / POS' },
  { key: 'salon_clients', label: 'Salon · Clients' },
  { key: 'salon_services', label: 'Salon · Service Menu' },
  { key: 'salon_products', label: 'Salon · Retail Products' },
  { key: 'salon_stylists', label: 'Salon · Stylists' },
  { key: 'salon_memberships', label: 'Salon · Memberships' },
  { key: 'salon_commissions', label: 'Salon · Commissions' },
  // ─── Staff ───
  { key: 'attendance', label: 'Attendance / leave' },
  { key: 'attendance_capture', label: 'Attendance capture' },
  { key: 'attendance_corrections', label: 'Manual attendance corrections' },
  { key: 'attendance_locations', label: 'Attendance locations' },
  { key: 'attendance_tracking', label: 'Location tracking' },
  { key: 'employee_shifts', label: 'Employee shift assignments' },
  { key: 'employee_links', label: 'Employee login links' },
  { key: 'attendance_rules', label: 'Attendance / payroll settings' },
  { key: 'attendance_rosters', label: 'Shift templates and rosters' },
  { key: 'attendance_policies', label: 'Attendance policy versions' },
  { key: 'attendance_requests', label: 'Attendance correction requests' },
  { key: 'attendance_periods', label: 'Attendance period close/reopen' },
  { key: 'payroll', label: 'Payroll' },
  { key: 'employees', label: 'Employees' },
  // ─── Other ───
  { key: 'delegations', label: 'Delegations' },
  { key: 'checklists', label: 'Checklists' },
  { key: 'help_tickets', label: 'Help Tickets' },
  { key: 'work_settings', label: 'Work settings and scheduled jobs' },
  { key: 'site_chat', label: 'Salon Chat — manage groups (chatting is open to all)' },
  { key: 'ai_agent', label: 'AI Assistant (Ask Sotyn)' },
  { key: 'users', label: 'User Management' },
];

const ACTIONS = [
  { key: 'can_view', label: 'View', color: 'text-red-600' },
  { key: 'can_create', label: 'Create', color: 'text-emerald-600' },
  { key: 'can_edit', label: 'Edit', color: 'text-amber-600' },
  { key: 'can_delete', label: 'Delete', color: 'text-red-600' },
  { key: 'can_approve', label: 'Approve', color: 'text-purple-600' },
  // can_see_all: explicit "scope=ALL records" toggle (decoupled from approve).
  // When OFF (default), users with this role only see records they raised /
  // own. When ON, they see every record in the module like an approver does.
  // Useful for auditor-style roles that need full read but no approval power.
  { key: 'can_see_all', label: 'See All', color: 'text-blue-600' },
];

export default function RolesPermissions() {
  const [roles, setRoles] = useState([]);
  const [selectedRole, setSelectedRole] = useState(null);
  const [permissions, setPermissions] = useState([]);
  const [modal, setModal] = useState(false);
  const [roleForm, setRoleForm] = useState({ name: '', description: '' });
  const [editingRole, setEditingRole] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showRelationships, setShowRelationships] = useState(false);

  const loadRoles = () => api.get('/auth/roles').then(r => setRoles(r.data));

  useEffect(() => { loadRoles(); }, []);

  const selectRole = async (role) => {
    setSelectedRole(role);
    const { data } = await api.get(`/auth/roles/${role.id}/permissions`);
    // Build full permission matrix
    const permMap = {};
    for (const p of data) permMap[p.module] = p;
    const fullPerms = ALL_MODULES.map(m => ({
      module: m.key,
      can_view: permMap[m.key]?.can_view || 0,
      can_create: permMap[m.key]?.can_create || 0,
      can_edit: permMap[m.key]?.can_edit || 0,
      can_delete: permMap[m.key]?.can_delete || 0,
      can_approve: permMap[m.key]?.can_approve || 0,
      can_see_all: permMap[m.key]?.can_see_all || 0,
      scope_mode: permMap[m.key]?.scope_mode || 'self',
      scope_branches: permMap[m.key]?.scope_branches || '[]',
    }));
    setPermissions(fullPerms);
  };

  const togglePerm = (moduleKey, actionKey) => {
    setPermissions(prev => prev.map(p => {
      if (p.module !== moduleKey) return p;
      const newVal = p[actionKey] ? 0 : 1;
      if(actionKey==='can_see_all') return {...p,can_see_all:newVal,scope_mode:newVal?'all':'self'};
      // If enabling any action, also enable view
      if (newVal && actionKey !== 'can_view') {
        return { ...p, [actionKey]: newVal, can_view: 1 };
      }
      // If disabling view, disable all (including the new can_see_all)
      if (!newVal && actionKey === 'can_view') {
        return { ...p, can_view: 0, can_create: 0, can_edit: 0, can_delete: 0, can_approve: 0, can_see_all: 0 };
      }
      return { ...p, [actionKey]: newVal };
    }));
  };

  const toggleAll = (actionKey) => {
    const allEnabled = permissions.every(p => p[actionKey]);
    setPermissions(prev => prev.map(p => {
      if(actionKey==='can_see_all')return {...p,can_see_all:allEnabled?0:1,scope_mode:allEnabled?'self':'all'};
      if (allEnabled) {
        if (actionKey === 'can_view') return { ...p, can_view: 0, can_create: 0, can_edit: 0, can_delete: 0, can_approve: 0 };
        return { ...p, [actionKey]: 0 };
      } else {
        if (actionKey !== 'can_view') return { ...p, [actionKey]: 1, can_view: 1 };
        return { ...p, [actionKey]: 1 };
      }
    }));
  };

  const savePermissions = async () => {
    if (!selectedRole) return;
    setSaving(true);
    try {
      await api.put(`/auth/roles/${selectedRole.id}/permissions`, { permissions });
      toast.success(`Permissions saved for "${selectedRole.name}"`);
    } catch (err) {
      toast.error('Failed to save');
    }
    setSaving(false);
  };

  const saveRole = async (e) => {
    e.preventDefault();
    try {
      if (editingRole) {
        await api.put(`/auth/roles/${editingRole.id}`, roleForm);
        toast.success('Role updated');
      } else {
        await api.post('/auth/roles', roleForm);
        toast.success('Role created');
      }
      setModal(false);
      loadRoles();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error');
    }
  };

  const deleteRole = async (role) => {
    if (role.is_system) return toast.error('Cannot delete system role');
    if (!confirm(`Delete role "${role.name}"? Users with this role will lose their permissions.`)) return;
    await api.delete(`/auth/roles/${role.id}`);
    toast.success('Role deleted');
    if (selectedRole?.id === role.id) { setSelectedRole(null); setPermissions([]); }
    loadRoles();
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-xl font-bold text-gray-800">Roles & Permissions</h3>
        <p className="text-sm text-gray-500">Set permissions once per role, then assign that role to employees in Users. Everyone assigned the role inherits its permissions.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Roles List */}
        <div className="card lg:col-span-1 p-0 min-w-0 self-start">
          <div className="p-4 border-b flex items-center justify-between">
            <h4 className="font-semibold text-gray-700">Roles</h4>
            <button onClick={() => { setEditingRole(null); setRoleForm({ name: '', description: '' }); setModal(true); }} className="p-1.5 hover:bg-red-50 rounded text-red-600"><FiPlus size={18} /></button>
          </div>
          <div className="divide-y max-h-[36rem] overflow-y-auto">
            {roles.map(r => (
              <div
                key={r.id}
                className={`p-3 cursor-pointer flex items-center justify-between group hover:bg-gray-50 ${selectedRole?.id === r.id ? 'bg-red-50 border-l-4 border-red-500' : ''}`}
                onClick={() => selectRole(r)}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium flex items-center gap-2">
                    <FiShield size={14} className={`shrink-0 ${selectedRole?.id === r.id ? 'text-red-600' : 'text-gray-400'}`} />
                    <span className="break-words min-w-0">{r.name}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5 break-words">{r.description}</div>
                </div>
                {!r.is_system && (
                  <div className="hidden group-hover:flex gap-1 shrink-0">
                    <button onClick={(e) => { e.stopPropagation(); setEditingRole(r); setRoleForm({ name: r.name, description: r.description }); setModal(true); }} className="p-1 hover:bg-red-100 rounded text-red-600"><FiEdit2 size={12} /></button>
                    <button onClick={(e) => { e.stopPropagation(); deleteRole(r); }} className="p-1 hover:bg-red-100 rounded text-red-600"><FiTrash2 size={12} /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Permissions Matrix */}
        <div className="card lg:col-span-3 p-0 min-w-0">
          {selectedRole ? (
            <>
              <div className="p-4 border-b flex items-center justify-between bg-gradient-to-r from-blue-50 to-white">
                <div>
                  <h4 className="font-semibold text-gray-800">Permissions for: <span className="text-blue-700">{selectedRole.name}</span></h4>
                  <p className="text-xs text-gray-500 mt-1">Saving changes updates access for everyone assigned this role. Attendance scope controls whose records they can access: their own, their team, selected branches, or all records.</p>
                </div>
                <button onClick={savePermissions} disabled={saving} className="btn btn-primary flex items-center gap-2">
                  {saving ? 'Saving...' : 'Save Permissions'}
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 w-48">Module</th>
                      {ACTIONS.map(a => (
                        <th key={a.key} className="px-3 py-3 text-center text-xs font-semibold text-gray-600">
                          <button onClick={() => toggleAll(a.key)} className={`hover:underline ${a.color}`}>{a.label}</button>
                        </th>
                      ))}
                      <th>Scope / Branch IDs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {permissions.map((p, i) => {
                      const mod = ALL_MODULES.find(m => m.key === p.module);
                      return (
                        <tr key={p.module} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
                          <td className="px-4 py-3 text-sm font-medium text-gray-700">{mod?.label || p.module}</td>
                          {ACTIONS.map(a => (
                            <td key={a.key} className="px-3 py-3 text-center">
                              <button
                                aria-label={`${mod?.label || p.module}: ${a.label}`}
                                aria-pressed={!!p[a.key]}
                                onClick={() => togglePerm(p.module, a.key)}
                                className={`w-8 h-8 rounded-lg flex items-center justify-center mx-auto transition-colors ${p[a.key] ? 'bg-emerald-100 text-emerald-600 hover:bg-emerald-200' : 'bg-gray-100 text-gray-300 hover:bg-gray-200'}`}
                              >
                                {p[a.key] ? <FiCheck size={16} /> : <FiX size={14} />}
                              </button>
                            </td>
                          ))}
                          <td><select aria-label={(mod?.label||p.module)+' scope'} className="select" value={p.scope_mode} onChange={e=>setPermissions(prev=>prev.map(x=>x.module===p.module?{...x,scope_mode:e.target.value,can_see_all:e.target.value==='all'?1:0}:x))}>{['self','team','branch','all'].map(v=><option key={v} value={v}>{v}</option>)}</select>
                          {p.scope_mode==='branch'&&<input aria-label={(mod?.label||p.module)+' branch IDs'} className="input" placeholder="Branch IDs, e.g. 1,2" value={(()=>{try{return JSON.parse(p.scope_branches).join(',');}catch{return '';}})()} onChange={e=>{const ids=e.target.value.split(',').map(Number).filter(n=>Number.isSafeInteger(n)&&n>0);setPermissions(prev=>prev.map(x=>x.module===p.module?{...x,scope_branches:JSON.stringify(ids)}:x));}}/>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="p-12 text-center text-gray-400">
              <FiShield size={48} className="mx-auto mb-4 text-gray-300" />
              <h4 className="text-lg font-medium text-gray-500">Select a Role</h4>
              <p className="text-sm mt-1">Click a role from the left panel to view and edit its permissions</p>
            </div>
          )}
        </div>
      </div>

      <details className="card" onToggle={e => setShowRelationships(e.currentTarget.open)}>
        <summary className="cursor-pointer font-semibold text-gray-700">Team and branch assignments</summary>
        <p className="text-sm text-gray-500 my-3">Configure these relationships when using team or branch attendance scopes. Employee permissions are still inherited from roles.</p>
        {showRelationships && <AttendanceAccessSetup />}
      </details>

      {/* Role Create/Edit Modal */}
      <Modal isOpen={modal} onClose={() => setModal(false)} title={editingRole ? 'Edit Role' : 'Create New Role'}>
        <form onSubmit={saveRole} className="space-y-4">
          <div><label className="label">Role Name *</label><input className="input" value={roleForm.name} onChange={e => setRoleForm({...roleForm, name: e.target.value})} required placeholder="e.g. Project Manager" /></div>
          <div><label className="label">Description</label><input className="input" value={roleForm.description} onChange={e => setRoleForm({...roleForm, description: e.target.value})} placeholder="Brief description of this role" /></div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{editingRole ? 'Update' : 'Create'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

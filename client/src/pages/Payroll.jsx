import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiSettings, FiDollarSign, FiEye, FiLock, FiUnlock, FiSave, FiDownload, FiCalendar } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { LuIndianRupee } from 'react-icons/lu';
import TimePicker from '../components/TimePicker';
import { fmtDate, fmtTime } from '../utils/datetime';

const monthNow = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// Grouped settings for the rules tab — clearer than a flat list when there
// are 20+ rules. Each group renders as its own card.
const SETTING_GROUPS = [
  {
    title: 'Attendance Cutoffs',
    fields: [
      { key: 'late_after_time', label: 'Late Zone Start', help: 'Punch-in after this = late mark (e.g. 09:46). Full day; counts toward monthly grace.', type: 'time' },
      { key: 'half_day_after_time', label: 'Half-Day After Time', help: 'Punch-in after this = half day, no grace (e.g. 10:00)', type: 'time' },
      { key: 'min_hours_half_day', label: 'Min Hours for Full Day', help: 'Work this many hours or more = full day; less = half day (e.g. 4)', type: 'number', step: 0.5 },
    ]
  },
  {
    title: 'Late Penalty (per-minute model)',
    fields: [
      { key: 'late_grace_count', label: 'Free Late Marks / Month', help: 'First N late punches per month are free', type: 'number' },
      { key: 'late_per_minute_rate', label: 'Penalty per Minute (Rs)', help: 'After grace, deduct ₹/min × (punch-in - late zone start)', type: 'number' },
      { key: 'skip_half_day_if_short_leave', label: 'Skip Penalty if Short Leave Applied', help: '1 = if short leave on that day, no late/half-day deduction', type: 'bool' },
      { key: 'lates_to_absent', label: 'Lates → 1 Absent (legacy)', help: 'Set 0 to disable this alternative model', type: 'number' },
    ]
  },
  {
    title: 'Working Days & Sundays',
    fields: [
      { key: 'working_days_per_month', label: 'Working Days per Month', help: 'Divisor for per-day rate (26 / 30)', type: 'number' },
      { key: 'sundays_paid', label: 'Sundays Paid?', help: '1 = paid (monthly staff), 0 = unpaid (daily wage)', type: 'bool' },
    ]
  },
  {
    title: 'Leave Allowances (Paid up to N / month)',
    fields: [
      { key: 'cl_per_month', label: 'Casual Leave', help: 'Paid CL allowance per month', type: 'number', step: 0.5 },
      { key: 'sl_per_month', label: 'Sick Leave', help: 'Paid SL allowance per month', type: 'number', step: 0.5 },
      { key: 'pl_per_month', label: 'Privilege / Earned Leave', help: 'Paid PL/EL allowance per month', type: 'number', step: 0.5 },
      { key: 'short_leave_per_month', label: 'Short Leaves / Month', help: 'Allowed short-leave count', type: 'number' },
    ]
  },
  {
    title: 'Overtime',
    fields: [
      { key: 'ot_threshold_hours', label: 'OT After (hours/day)', help: 'Hours/day before OT pay starts', type: 'number', step: 0.5 },
      { key: 'ot_rate_multiplier', label: 'OT Rate Multiplier', help: 'OT pay = normal × this (1.5 / 2)', type: 'number', step: 0.1 },
    ]
  },
  {
    title: 'Salary Slip Breakdown (% of gross)',
    fields: [
      { key: 'basic_pct', label: 'Basic Pay %', help: 'e.g. 56.5', type: 'number', step: 0.1 },
      { key: 'conveyance_pct', label: 'Conveyance Allowance %', help: 'e.g. 22.6', type: 'number', step: 0.1 },
      { key: 'hra_pct', label: 'House Rent Allowance %', help: 'e.g. 5.9', type: 'number', step: 0.1 },
      { key: 'adhoc_pct', label: 'Adhoc Allowance %', help: 'e.g. 15.0', type: 'number', step: 0.1 },
      { key: 'misc_pct', label: 'Miscellaneous Allowance %', help: 'Should sum to 100', type: 'number', step: 0.1 },
    ]
  },
];

const LABEL_PILL = {
  present: 'bg-emerald-100 text-emerald-700',
  late: 'bg-amber-100 text-amber-700',
  half_day_late: 'bg-orange-100 text-orange-700',
  half_day_low_hours: 'bg-orange-100 text-orange-700',
  absent_no_punch: 'bg-red-100 text-red-700',
  absent_low_hours: 'bg-red-100 text-red-700',
  sunday_paid: 'bg-blue-100 text-blue-700',
  sunday_unpaid: 'bg-gray-100 text-gray-500',
  paid_casual_leave: 'bg-purple-100 text-purple-700',
  paid_sick_leave: 'bg-purple-100 text-purple-700',
  paid_earned_leave: 'bg-purple-100 text-purple-700',
  paid_comp_off_leave: 'bg-purple-100 text-purple-700',
  half_day_leave: 'bg-orange-100 text-orange-700',
  unpaid_casual_leave: 'bg-rose-100 text-rose-700',
  unpaid_sick_leave: 'bg-rose-100 text-rose-700',
  unpaid_earned_leave: 'bg-rose-100 text-rose-700',
  unpaid_comp_off_leave: 'bg-rose-100 text-rose-700',
};

export default function Payroll() {
  const { user, canApprove, canEdit } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [tab, setTab] = useUrlTab('monthly');
  const [month, setMonth] = useState(monthNow());
  const [settings, setSettings] = useState(null);
  const [savedSettings, setSavedSettings] = useState(null);
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState(null);
  const [advanceEdits, setAdvanceEdits] = useState({}); // employee_id -> draft advance amount
  const [foodEdits, setFoodEdits] = useState({});       // employee_id -> draft food amount (added to net)
  const [ovEdits, setOvEdits] = useState({});           // `${employee_id}:${field}` -> draft override (paid_days|cl|late_penalty)
  const [excludedNoSalary, setExcludedNoSalary] = useState([]); // active employees with no salary → not in payroll
  // CL Leave Balances tab
  const [leaveYear, setLeaveYear] = useState(new Date().getFullYear());
  const [leaveRows, setLeaveRows] = useState([]);
  const [leaveLoading, setLeaveLoading] = useState(false);
  const [leaveEdits, setLeaveEdits] = useState({}); // employee_id -> draft opening_balance

  const loadSettings = useCallback(() => {
    api.get('/payroll/settings').then(r => { setSettings(r.data); setSavedSettings(r.data); }).catch(() => {});
  }, []);

  const loadMonth = useCallback(() => {
    setLoading(true);
    api.get(`/payroll/calculate?month=${month}`)
      .then(r => { setList(r.data.employees || []); setExcludedNoSalary(r.data.excluded_no_salary || []); })
      .catch(err => toast.error(err.response?.data?.error || 'Failed'))
      .finally(() => setLoading(false));
  }, [month]);

  // silent=true → refresh rows without flipping the loading state (which
  // empties the table and bounces the page to the top). Used after a tick
  // or carry-forward save so the scroll position stays put.
  const loadLeaveBalances = useCallback((silent = false) => {
    if (!silent) setLeaveLoading(true);
    api.get(`/payroll/leave-balances?year=${leaveYear}`)
      .then(r => { setLeaveRows(r.data.rows || []); if (!silent) setLeaveEdits({}); })
      .catch(err => toast.error(err.response?.data?.error || 'Failed'))
      .finally(() => { if (!silent) setLeaveLoading(false); });
  }, [leaveYear]);

  useEffect(() => { loadSettings(); }, [loadSettings]);
  useEffect(() => { if (tab === 'monthly') loadMonth(); }, [tab, loadMonth]);
  useEffect(() => { if (tab === 'leaves') loadLeaveBalances(); }, [tab, loadLeaveBalances]);

  const saveOpening = async (employeeId) => {
    const v = leaveEdits[employeeId];
    try {
      await api.put(`/payroll/leave-balance/${employeeId}`, { cl_opening_balance: Number(v) });
      toast.success('Carry-forward saved');
      setLeaveEdits(s => { const n = { ...s }; delete n[employeeId]; return n; });
      loadLeaveBalances(true); // silent — keep scroll position
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const toggleEligible = async (employeeId, next) => {
    // Flip the checkbox in place immediately (no scroll jump), then sync
    // the recomputed accrued/remaining silently in the background.
    setLeaveRows(rows => rows.map(r => r.employee_id === employeeId ? { ...r, cl_eligible: next ? 1 : 0 } : r));
    try {
      await api.put(`/payroll/leave-balance/${employeeId}`, { cl_eligible: next ? 1 : 0 });
      loadLeaveBalances(true); // silent
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
      loadLeaveBalances(true); // revert to server state
    }
  };

  const toggleOtEligible = async (employeeId, next) => {
    setLeaveRows(rows => rows.map(r => r.employee_id === employeeId ? { ...r, ot_eligible: next ? 1 : 0 } : r));
    try {
      await api.put(`/payroll/leave-balance/${employeeId}`, { ot_eligible: next ? 1 : 0 });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
      loadLeaveBalances(true); // revert to server state
    }
  };

  // Save an employee's advance salary for the open month; net pay recomputes.
  const saveAdvance = async (employeeId, value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) { toast.error('Enter a valid amount'); return; }
    try {
      await api.put(`/payroll/advance/${employeeId}`, { month, amount });
      setAdvanceEdits(s => { const n = { ...s }; delete n[employeeId]; return n; });
      loadMonth();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Save an employee's food allowance for the open month; net pay recomputes.
  const saveFood = async (employeeId, value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) { toast.error('Enter a valid amount'); return; }
    try {
      await api.put(`/payroll/food/${employeeId}`, { month, amount });
      setFoodEdits(s => { const n = { ...s }; delete n[employeeId]; return n; });
      loadMonth();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Save a manual override (paid_days | cl | late_penalty) for the open month;
  // a blank value resets to the auto-calculated number. Net pay recomputes.
  const saveOverride = async (employeeId, field, value) => {
    const blank = value === '' || value === null || value === undefined;
    if (!blank) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) { toast.error('Enter a valid number'); return; }
    }
    try {
      await api.put(`/payroll/override/${employeeId}`, { month, field, value: blank ? '' : value });
      setOvEdits(s => { const n = { ...s }; delete n[`${employeeId}:${field}`]; return n; });
      loadMonth();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Compact editable input for a monthly override. savedVal = the value
  // currently shown (auto or already-overridden); an amber ring flags an
  // active override; clearing the box resets to auto.
  const ovInput = (r, field, savedVal, overridden, opts = {}) => {
    const k = `${r.employee_id}:${field}`;
    const draft = ovEdits[k];
    const display = draft !== undefined ? draft : (savedVal ?? '');
    return (
      <input type="number" min="0" step={opts.step || '0.5'}
        className={`input text-right ${opts.w || 'w-16'} inline-block ${overridden ? 'ring-1 ring-amber-400 bg-amber-50' : ''}`}
        value={display}
        onChange={e => setOvEdits(s => ({ ...s, [k]: e.target.value }))}
        onBlur={e => {
          const v = e.target.value;
          if (Number(v || 0) !== Number(savedVal || 0) || (v === '' && overridden)) saveOverride(r.employee_id, field, v);
        }}
        title={opts.title} />
    );
  };

  // Breakdown split for the Paid Days cell. A worked Sunday is folded into
  // present_days (att); pull it back out so "att" = weekday attendance and
  // "sun" shows ALL Sundays credited (weekly-off + worked). Pay is unchanged;
  // the green "+Nd Sun worked" line still shows the extra bonus on top.
  const dayBreakdown = (r) => {
    const worked = +r.sunday_worked_pay || 0;
    const att = Math.round(((+r.present_days || 0) - worked) * 100) / 100;
    const sun = Math.round(((+r.sunday_count || 0) + worked) * 100) / 100;
    return { att, sun };
  };

  const rolloverYear = async () => {
    if (!confirm(`Roll ${leaveYear}'s leftover CL into each person's opening balance? Do this once ${leaveYear} is complete — it overwrites the current carry-forward.`)) return;
    try {
      const res = await api.post('/payroll/leave-balances/rollover', { year: leaveYear });
      toast.success(res.data.message);
      setLeaveYear(y => y + 1);
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const saveSettings = async () => {
    try {
      const res = await api.put('/payroll/settings', settings);
      setSavedSettings(res.data.settings);
      toast.success('Payroll rules saved — calculations will use these from next refresh');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  const finaliseMonth = async () => {
    if (!confirm(`Finalise payroll for ${month}? After this, attendance edits won't change the slips for this month.`)) return;
    try {
      const res = await api.post('/payroll/finalise', { month });
      toast.success(res.data.message);
      loadMonth();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const unlockMonth = async () => {
    if (!confirm(`Unlock ${month}? Slips will recalc from live attendance.`)) return;
    try {
      await api.post('/payroll/unlock', { month });
      toast.success('Unlocked');
      loadMonth();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const viewSlip = async (employeeId) => {
    try {
      const { data } = await api.get(`/payroll/calculate/${employeeId}?month=${month}`);
      setDetail(data);
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const fmt = (n) => `Rs ${(Math.round(n || 0)).toLocaleString('en-IN')}`;

  const total = list.reduce((s, r) => s + (r.net_pay || 0), 0);
  // Disbursement tracking — only meaningful once the month is finalised.
  const isFinalised = list.some(r => r.locked);
  const canMarkPaid = isAdmin || (canEdit && canEdit('payroll'));
  const paidCount = list.filter(r => r.paid).length;
  const unpaidCount = list.filter(r => r.locked && !r.paid).length;
  const savePaid = async (employeeId, paid) => {
    try {
      await api.put(`/payroll/paid/${employeeId}`, { month, paid });
      loadMonth();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-6">
      <div className="sticky-toolbar">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><LuIndianRupee className="text-emerald-600" /> Payroll</h1>
            <p className="text-sm text-gray-500">Auto-calculate monthly salary from attendance + leaves using your custom rules</p>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setTab('monthly')} className={`btn ${tab === 'monthly' ? 'btn-primary' : 'btn-secondary'} text-sm flex items-center gap-1`}>
            <FiDollarSign size={14} /> Monthly Payroll
          </button>
          <button onClick={() => setTab('leaves')} className={`btn ${tab === 'leaves' ? 'btn-primary' : 'btn-secondary'} text-sm flex items-center gap-1`}>
            <FiCalendar size={14} /> Leave Balances
          </button>
          {isAdmin && (
            <button onClick={() => setTab('settings')} className={`btn ${tab === 'settings' ? 'btn-primary' : 'btn-secondary'} text-sm flex items-center gap-1`}>
              <FiSettings size={14} /> Rules / Settings
            </button>
          )}
        </div>
      </div>

      {/* Monthly Payroll Tab */}
      {tab === 'monthly' && (
        <>
          <div className="card p-4 flex flex-wrap items-center gap-3">
            <div>
              <label className="label">Pay Month</label>
              <input type="month" className="input" value={month} onChange={e => setMonth(e.target.value)} />
            </div>
            {/* Friendly notice when viewing the current month — explains why
                paid_days is partial and absent count looks low. Saves mam
                from doubting the engine on the 4th of any month. */}
            {list[0]?.is_current_month && (
              <div className="bg-amber-50 border border-amber-200 px-3 py-2 rounded text-xs text-amber-800">
                Showing salary <strong>earned so far</strong> (day 1 to day {list[0].days_counted}). Future days aren't counted as absent. Final figures land at month-end.
              </div>
            )}
            {list[0]?.is_future_month && (
              <div className="bg-blue-50 border border-blue-200 px-3 py-2 rounded text-xs text-blue-800">
                Future month — nothing to calculate yet.
              </div>
            )}
            {excludedNoSalary.length > 0 && (
              <div className="bg-rose-50 border border-rose-200 px-3 py-2 rounded text-xs text-rose-800 w-full">
                ⚠ <strong>{excludedNoSalary.length} active {excludedNoSalary.length === 1 ? 'employee is' : 'employees are'} NOT in payroll</strong> because their monthly salary isn't set (attendance doesn't matter — salary does):{' '}
                <strong>{excludedNoSalary.map(e => e.name).join(', ')}</strong>. Set their salary in <strong>HR → Employees</strong> and they'll appear here.
              </div>
            )}
            <div className="flex-1" />
            <button onClick={() => exportCsv(`payroll-${month}`,
              ['Employee','Dept','Base','Paid Days','Gross','Deductions','Net'],
              list.map(p => [p.employee_name, p.department, p.base_salary, p.paid_days, p.gross, p.total_deductions, p.net_pay]))}
              className="btn btn-secondary text-sm flex items-center gap-1"><FiDownload size={14} /> Export Excel</button>
            <div className="text-right">
              <p className="text-xs text-gray-500">Total Net Payout</p>
              <p className="text-2xl font-bold text-emerald-600">{fmt(total)}</p>
              {isFinalised && (
                <p className="text-[11px] font-semibold mt-0.5">
                  <span className="text-emerald-600">{paidCount} paid</span>
                  {unpaidCount > 0 && <span className="text-rose-500"> · {unpaidCount} unpaid</span>}
                </p>
              )}
            </div>
            {canApprove && canApprove('payroll') && (
              <button onClick={finaliseMonth} className="btn btn-success text-sm flex items-center gap-1">
                <FiLock size={14} /> Finalise Month
              </button>
            )}
            {isAdmin && (
              <button onClick={unlockMonth} className="btn btn-secondary text-sm flex items-center gap-1">
                <FiUnlock size={14} /> Unlock
              </button>
            )}
          </div>

          <div className="card p-0 hidden md:block">
            <table className="freeze-head">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Dept</th>
                  <th className="text-right">Base</th>
                  <th className="text-right" title="Paid Days = attendance days + Sundays + paid CL/leave">Paid Days</th>
                  <th className="text-center">Half</th>
                  <th className="text-center">Absent</th>
                  <th className="text-center" title="Late count — informational only, no pay impact">Late</th>
                  <th className="text-right" title="Late deduction (charged from late time)">Late ₹</th>
                  <th className="text-center">Leaves</th>
                  <th className="text-right" title="Overtime for hours worked beyond 9/day, paid at salary ÷ days ÷ 9 per hour">OT (&gt;9h)</th>
                  <th className="text-right" title="Salary before overtime is added">Before OT</th>
                  <th className="text-right" title="Advance salary taken this month — deducted from net pay">Advance</th>
                  <th className="text-right" title="Food allowance — added to net pay">Food</th>
                  <th className="text-right" title="Final salary including overtime, after advance + food">Net Pay</th>
                  <th className="text-center" title="Accounts marks each person Paid after the month is finalised">Paid</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan="16" className="text-center py-8 text-gray-400">Calculating…</td></tr>}
                {!loading && list.length === 0 && <tr><td colSpan="16" className="text-center py-8 text-gray-400">No active employees with salary set. Open HR → Employees and set monthly salary.</td></tr>}
                {!loading && list.map(r => (
                  <tr key={r.employee_id} className={r.locked ? 'bg-emerald-50/30' : (r.user_linked === false ? 'bg-amber-50/40' : '')}>
                    <td className="font-medium">
                      {r.employee_name}
                      {r.locked && <FiLock size={11} className="inline text-emerald-600 ml-1" title="Finalised" />}
                      {r.user_linked === false && <span className="ml-1 text-[10px] bg-amber-200 text-amber-800 px-1 py-0.5 rounded" title="No login user linked — attendance can't be looked up. Open HR → Employees and set the User for this employee.">⚠ no login</span>}
                    </td>
                    <td className="text-xs text-gray-500">{r.department || '-'}</td>
                    <td className="text-right">{fmt(r.base_salary)}</td>
                    <td className="text-right font-semibold">
                      {isAdmin && !r.locked
                        ? ovInput(r, 'paid_days', r.paid_days, r.paid_days_overridden, { w: 'w-16', step: '0.5', title: 'Paid days used for salary — type to override, clear to reset to auto' })
                        : r.paid_days}
                      <div className="text-[9px] font-normal text-gray-400" title="weekday attendance + Sundays (incl. worked) + paid CL">
                        att {dayBreakdown(r).att} · sun {dayBreakdown(r).sun}{r.paid_leaves ? ` · CL ${r.paid_leaves}` : ''}
                      </div>
                      {isAdmin && !r.locked && (
                        <div className="text-[9px] font-normal text-gray-500 flex items-center justify-end gap-1 mt-0.5">
                          <span>CL</span>
                          {ovInput(r, 'cl', r.paid_leaves, r.cl_overridden, { w: 'w-12', step: '0.5', title: 'Casual / paid leave days for the month — type to override' })}
                        </div>
                      )}
                      {r.sunday_worked > 0 && (
                        <div className="text-[9px] font-normal text-emerald-600" title="Extra full-day pay for working on Sunday(s)">
                          +{r.sunday_worked_pay}d for {r.sunday_worked} Sun worked
                        </div>
                      )}
                    </td>
                    <td className="text-center">{r.half_days || 0}</td>
                    <td className="text-center text-red-600">{r.absent_days || 0}</td>
                    <td className="text-center text-amber-600" title="Late count only — does not reduce pay. See Late ₹ for the deduction.">{r.late_marks || 0}{r.lates_converted_absent ? ` (-${r.lates_converted_absent})` : ''}</td>
                    <td className="text-right text-amber-700">
                      {isAdmin && !r.locked
                        ? ovInput(r, 'late_penalty', r.late_penalty, r.late_penalty_overridden, { w: 'w-16', step: '10', title: 'Late deduction ₹ — type to override, clear to reset to auto' })
                        : (r.late_penalty ? fmt(r.late_penalty) : '-')}
                    </td>
                    <td className="text-center text-purple-600">{(r.paid_leaves || 0) + (r.unpaid_leaves || 0)}</td>
                    <td className="text-right text-blue-600" title={r.ot_per_hour_rate ? `Rs ${r.ot_per_hour_rate}/hr = ${fmt(r.base_salary)} ÷ ${r.total_days_in_month} days ÷ ${r.ot_threshold || 9}h` : 'No overtime'}>
                      {r.ot_hours || 0}h{r.ot_pay ? ` (+${fmt(r.ot_pay)})` : ''}
                      {r.ot_hours ? <div className="text-[9px] font-normal text-gray-400">&gt;{r.ot_threshold || 9}h @ Rs {r.ot_per_hour_rate}/h</div> : null}
                    </td>
                    <td className="text-right text-gray-600">{fmt(r.net_before_ot ?? (r.net_pay - (r.ot_pay || 0)))}</td>
                    <td className="text-right">
                      {isAdmin && !r.locked ? (
                        <input type="number" min="0" step="100"
                          className="input text-right w-24 inline-block"
                          value={advanceEdits[r.employee_id] !== undefined ? advanceEdits[r.employee_id] : (r.advance || 0)}
                          onChange={e => setAdvanceEdits(s => ({ ...s, [r.employee_id]: e.target.value }))}
                          onBlur={e => { if (Number(e.target.value) !== Number(r.advance || 0)) saveAdvance(r.employee_id, e.target.value); }}
                          title="Advance salary taken this month — deducted from net pay" />
                      ) : (r.advance ? <span className="text-rose-600">-{fmt(r.advance)}</span> : '-')}
                    </td>
                    <td className="text-right">
                      {isAdmin && !r.locked ? (
                        <input type="number" min="0" step="100"
                          className="input text-right w-24 inline-block"
                          value={foodEdits[r.employee_id] !== undefined ? foodEdits[r.employee_id] : (r.food || 0)}
                          onChange={e => setFoodEdits(s => ({ ...s, [r.employee_id]: e.target.value }))}
                          onBlur={e => { if (Number(e.target.value) !== Number(r.food || 0)) saveFood(r.employee_id, e.target.value); }}
                          title="Food allowance — added to net pay" />
                      ) : (r.food ? <span className="text-emerald-600">+{fmt(r.food)}</span> : '-')}
                    </td>
                    <td className="text-right font-bold text-emerald-700">{fmt(r.net_pay)}{r.sunday_worked_pay ? <span className="block text-[9px] font-normal text-emerald-600">incl. +{r.sunday_worked_pay}d Sun work</span> : null}{r.ot_pay ? <span className="block text-[9px] font-normal text-blue-500">incl. +{fmt(r.ot_pay)} OT</span> : null}{r.food ? <span className="block text-[9px] font-normal text-emerald-600">incl. +₹{fmt(r.food)} food</span> : null}{r.advance ? <span className="block text-[9px] font-normal text-rose-500">less ₹{fmt(r.advance)} advance</span> : null}</td>
                    <td className="text-center">
                      {r.locked ? (
                        <label className={`inline-flex items-center gap-1 ${canMarkPaid ? 'cursor-pointer' : 'cursor-default'}`}
                          title={r.paid ? `Paid${r.paid_at ? ' on ' + fmtDate(r.paid_at) : ''}` : 'Not paid yet'}>
                          <input type="checkbox" checked={!!r.paid} disabled={!canMarkPaid}
                            onChange={e => savePaid(r.employee_id, e.target.checked)} />
                          <span className={`text-[11px] font-semibold ${r.paid ? 'text-emerald-600' : 'text-rose-500'}`}>{r.paid ? 'Paid' : 'Unpaid'}</span>
                        </label>
                      ) : <span className="text-[10px] text-gray-300" title="Finalise the month to mark salary paid">—</span>}
                    </td>
                    <td className="space-x-1 whitespace-nowrap">
                      <button onClick={() => viewSlip(r.employee_id)} className="btn btn-secondary text-xs">Detail</button>
                      <a href={`/payroll/slip/${r.employee_id}?month=${month}`} target="_blank" rel="noreferrer" className="btn btn-primary text-xs">SEPL Slip</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards (mam 2026-06-02) — Payroll monthly slip list */}
          <div className="md:hidden space-y-3">
            {loading && <div className="card p-6 text-center text-gray-400 text-sm">Calculating…</div>}
            {!loading && list.length === 0 && (
              <div className="card p-6 text-center text-gray-400 text-sm">No active employees with salary set.</div>
            )}
            {!loading && list.map(r => (
              <div key={r.employee_id} className={`card p-3 space-y-2 ${r.locked ? 'border-emerald-300' : (r.user_linked === false ? 'border-amber-300' : '')}`}>
                <div className="flex justify-between items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Employee</div>
                    <div className="text-lg font-bold text-gray-900 truncate flex items-center gap-1">
                      {r.employee_name}
                      {r.locked && <FiLock size={11} className="text-emerald-600" title="Finalised" />}
                    </div>
                    {r.department && <div className="text-[11px] text-gray-500">{r.department}</div>}
                    {r.user_linked === false && (
                      <div className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded inline-block mt-0.5">⚠ no login</div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-[9px] uppercase text-gray-400">Net Pay</div>
                    <div className="text-lg font-bold text-emerald-700">{fmt(r.net_pay)}</div>
                    <div className="text-[9px] text-gray-400">before OT {fmt(r.net_before_ot ?? (r.net_pay - (r.ot_pay || 0)))}</div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 pt-1 border-t border-gray-100 text-[11px] text-center">
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Base</div>
                    <div className="font-semibold text-gray-700">{fmt(r.base_salary)}</div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Paid Days</div>
                    <div className="font-semibold text-gray-800">{r.paid_days}</div>
                    <div className="text-[8px] text-gray-400">att {r.present_days ?? 0}·sun {r.sunday_count ?? 0}{r.paid_leaves ? `·CL ${r.paid_leaves}` : ''}</div>
                    {r.sunday_worked > 0 && <div className="text-[8px] text-emerald-600">+{r.sunday_worked_pay}d for {r.sunday_worked} Sun worked</div>}
                  </div>
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">OT (&gt;9h)</div>
                    <div className="font-semibold text-blue-700">{r.ot_hours || 0}h{r.ot_pay ? ` +${fmt(r.ot_pay)}` : ''}</div>
                    {r.ot_hours ? <div className="text-[8px] text-gray-400">Rs {r.ot_per_hour_rate}/h</div> : null}
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-2 pt-1 border-t border-gray-100 text-[11px] text-center">
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Half</div>
                    <div className="font-semibold text-gray-700">{r.half_days || 0}</div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Absent</div>
                    <div className="font-semibold text-red-600">{r.absent_days || 0}</div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Late</div>
                    <div className="font-semibold text-amber-600">{r.late_marks || 0}</div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Leaves</div>
                    <div className="font-semibold text-purple-600">{(r.paid_leaves || 0) + (r.unpaid_leaves || 0)}</div>
                  </div>
                </div>
                {r.late_penalty > 0 && (
                  <div className="text-[11px] text-amber-700 font-semibold pt-1 border-t border-gray-100">
                    Late penalty: {fmt(r.late_penalty)}
                  </div>
                )}
                {isAdmin && !r.locked ? (
                  <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
                    <span className="text-[11px] text-gray-500 font-semibold whitespace-nowrap">Advance ₹</span>
                    <input type="number" min="0" step="100" className="input text-right text-xs py-1 flex-1"
                      defaultValue={r.advance || 0}
                      onBlur={e => { if (Number(e.target.value) !== Number(r.advance || 0)) saveAdvance(r.employee_id, e.target.value); }} />
                  </div>
                ) : (r.advance > 0 && (
                  <div className="text-[11px] text-rose-700 font-semibold pt-1 border-t border-gray-100">
                    Advance: -{fmt(r.advance)}
                  </div>
                ))}
                {isAdmin && !r.locked ? (
                  <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
                    <span className="text-[11px] text-gray-500 font-semibold whitespace-nowrap">Food ₹</span>
                    <input type="number" min="0" step="100" className="input text-right text-xs py-1 flex-1"
                      defaultValue={r.food || 0}
                      onBlur={e => { if (Number(e.target.value) !== Number(r.food || 0)) saveFood(r.employee_id, e.target.value); }} />
                  </div>
                ) : (r.food > 0 && (
                  <div className="text-[11px] text-emerald-700 font-semibold pt-1 border-t border-gray-100">
                    Food: +{fmt(r.food)}
                  </div>
                ))}
                {/* Admin overrides + Paid toggle — same actions as the desktop
                    table (mam 2026-07-06: edit controls must show on mobile too,
                    not just desktop). Reuses ovInput / savePaid. */}
                {isAdmin && !r.locked && (
                  <div className="grid grid-cols-3 gap-2 pt-1 border-t border-gray-100">
                    <label className="text-[9px] uppercase text-gray-400 font-semibold block">Paid days
                      {ovInput(r, 'paid_days', r.paid_days, r.paid_days_overridden, { w: 'w-full', step: '0.5', title: 'Paid days — type to override, clear to reset' })}
                    </label>
                    <label className="text-[9px] uppercase text-gray-400 font-semibold block">CL
                      {ovInput(r, 'cl', r.paid_leaves, r.cl_overridden, { w: 'w-full', step: '0.5', title: 'Casual / paid leave days — type to override' })}
                    </label>
                    <label className="text-[9px] uppercase text-gray-400 font-semibold block">Late ₹
                      {ovInput(r, 'late_penalty', r.late_penalty, r.late_penalty_overridden, { w: 'w-full', step: '10', title: 'Late deduction ₹ — type to override, clear to reset' })}
                    </label>
                  </div>
                )}
                {r.locked && (
                  <label className={`flex items-center justify-between pt-1 border-t border-gray-100 ${canMarkPaid ? 'cursor-pointer' : 'cursor-default'}`}
                    title={r.paid ? `Paid${r.paid_at ? ' on ' + fmtDate(r.paid_at) : ''}` : 'Not paid yet'}>
                    <span className="text-[11px] text-gray-500 font-semibold">Salary disbursed?</span>
                    <span className="inline-flex items-center gap-1.5">
                      <input type="checkbox" checked={!!r.paid} disabled={!canMarkPaid}
                        onChange={e => savePaid(r.employee_id, e.target.checked)} />
                      <span className={`text-[12px] font-semibold ${r.paid ? 'text-emerald-600' : 'text-rose-500'}`}>{r.paid ? 'Paid' : 'Unpaid'}</span>
                    </span>
                  </label>
                )}
                <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
                  <button onClick={() => viewSlip(r.employee_id)} className="btn btn-secondary text-xs py-1.5 px-3 flex-1">Detail</button>
                  <a href={`/payroll/slip/${r.employee_id}?month=${month}`} target="_blank" rel="noreferrer"
                    className="btn btn-primary text-xs py-1.5 px-3 flex-1 text-center">SEPL Slip</a>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Settings Tab */}
      {tab === 'settings' && settings && (
        <div className="space-y-4 max-w-4xl">
          <div className="card p-4 flex items-center justify-between border-b-2 border-red-200">
            <div>
              <h3 className="font-bold text-lg">Payroll Calculation Rules</h3>
              <p className="text-xs text-gray-500">Every value below feeds the auto-calc engine. Save to apply to future months. Finalised months stay locked.</p>
            </div>
            <button onClick={saveSettings} className="btn btn-primary flex items-center gap-1"><FiSave size={14} /> Save Rules</button>
          </div>

          {SETTING_GROUPS.map(group => (
            <div key={group.title} className="card p-4">
              <h4 className="font-semibold text-sm mb-3 text-red-700 border-b pb-1">{group.title}</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {group.fields.map(f => (
                  <div key={f.key} className="p-3 bg-gray-50 rounded">
                    <label className="label text-sm">{f.label}</label>
                    {f.type === 'bool' ? (
                      <select className="select" value={settings[f.key]} onChange={e => setSettings(s => ({ ...s, [f.key]: +e.target.value }))}>
                        <option value={1}>Yes (1)</option>
                        <option value={0}>No (0)</option>
                      </select>
                    ) : f.type === 'time' ? (
                      <TimePicker value={settings[f.key] || ''} onChange={v => setSettings(s => ({ ...s, [f.key]: v }))} />
                    ) : (
                      <input type="number" step={f.step || 1} className="input" value={settings[f.key] ?? 0} onChange={e => setSettings(s => ({ ...s, [f.key]: +e.target.value }))} />
                    )}
                    <p className="text-[10px] text-gray-500 mt-1">{f.help}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {savedSettings?.updated_at && (
            <p className="text-[11px] text-gray-400 pt-2">Last updated: {savedSettings.updated_at}</p>
          )}
        </div>
      )}

      {/* Leave Balances Tab — annual CL with carry-forward */}
      {tab === 'leaves' && (
        <>
          <div className="card p-4 flex flex-wrap items-center gap-3">
            <div>
              <label className="label">Year</label>
              <select className="select" value={leaveYear} onChange={e => setLeaveYear(+e.target.value)}>
                {Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - 3 + i).map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <div className="bg-purple-50 border border-purple-200 px-3 py-2 rounded text-xs text-purple-800 max-w-xl">
              <strong>Remaining = Carry-Forward + Accrued − Used.</strong> Everyone accrues the same monthly CL
              ({leaveRows[0]?.cl_per_month ?? '—'}/month); whatever is left at year-end can be carried into next year.
              Accrued counts only the months that have <em>already passed</em> in the selected year.
            </div>
            {leaveYear > new Date().getFullYear() && (
              <div className="bg-amber-50 border border-amber-200 px-3 py-2 rounded text-xs text-amber-800 max-w-xl">
                ⚠ <strong>{leaveYear} is a future year</strong> — 0 months have accrued yet, so <strong>Accrued = 0</strong> and Remaining is just the carry-forward. Select <strong>{new Date().getFullYear()}</strong> to see this year's monthly accrual.
              </div>
            )}
            <div className="flex-1" />
            <button onClick={() => exportCsv(`cl-balances-${leaveYear}`,
              ['Employee', 'Dept', 'Carry-Forward', 'Accrued', 'Used', 'Remaining'],
              leaveRows.map(r => [r.employee_name, r.department, r.opening_balance, r.accrued, r.used, r.remaining]))}
              className="btn btn-secondary text-sm flex items-center gap-1"><FiDownload size={14} /> Export Excel</button>
            {isAdmin && (
              <button onClick={rolloverYear} className="btn btn-success text-sm flex items-center gap-1" title={`Set each person's carry-forward = their ${leaveYear} remaining`}>
                <FiSave size={14} /> Roll over {leaveYear} → {leaveYear + 1}
              </button>
            )}
          </div>

          <div className="card p-0">
            <table className="freeze-head">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Dept</th>
                  <th className="text-center">CL Eligible</th>
                  <th className="text-center">OT Eligible</th>
                  <th className="text-right">Carry-Forward</th>
                  <th className="text-right">Accrued ({leaveRows[0]?.months_elapsed ?? 0} mo)</th>
                  <th className="text-right">Used</th>
                  <th className="text-right">Remaining</th>
                  {isAdmin && <th></th>}
                </tr>
              </thead>
              <tbody>
                {leaveLoading && <tr><td colSpan={isAdmin ? 9 : 8} className="text-center py-8 text-gray-400">Loading…</td></tr>}
                {!leaveLoading && leaveRows.length === 0 && <tr><td colSpan={isAdmin ? 9 : 8} className="text-center py-8 text-gray-400">No active employees.</td></tr>}
                {!leaveLoading && leaveRows.map(r => {
                  const draft = leaveEdits[r.employee_id];
                  const dirty = draft !== undefined && Number(draft) !== r.opening_balance;
                  return (
                    <tr key={r.employee_id} className={r.user_linked === false ? 'bg-amber-50/40' : ''}>
                      <td className="font-medium">
                        {r.employee_name}
                        {r.user_linked === false && <span className="ml-1 text-[10px] bg-amber-200 text-amber-800 px-1 py-0.5 rounded" title="No login user linked — CL taken can't be counted.">⚠ no login</span>}
                      </td>
                      <td className="text-xs text-gray-500">{r.department || '-'}</td>
                      <td className="text-center">
                        {isAdmin ? (
                          <input type="checkbox" checked={!!r.cl_eligible} onChange={e => toggleEligible(r.employee_id, e.target.checked)} />
                        ) : (r.cl_eligible ? 'Yes' : 'No')}
                      </td>
                      <td className="text-center">
                        {isAdmin ? (
                          <input type="checkbox" checked={!!r.ot_eligible} onChange={e => toggleOtEligible(r.employee_id, e.target.checked)} title="Tick to give this person overtime pay above the OT threshold" />
                        ) : (r.ot_eligible ? 'Yes' : 'No')}
                      </td>
                      <td className="text-right">
                        {isAdmin ? (
                          <input type="number" step="0.5" className="input text-right w-24 inline-block"
                            value={draft !== undefined ? draft : r.opening_balance}
                            onChange={e => setLeaveEdits(s => ({ ...s, [r.employee_id]: e.target.value }))} />
                        ) : r.opening_balance}
                      </td>
                      <td className="text-right text-gray-700">{r.accrued}</td>
                      <td className="text-right text-purple-600">{r.used}</td>
                      <td className={`text-right font-bold ${r.remaining < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{r.remaining}</td>
                      {isAdmin && (
                        <td className="text-right">
                          {dirty && <button onClick={() => saveOpening(r.employee_id)} className="btn btn-primary text-xs">Save</button>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Slip Detail Modal */}
      <Modal isOpen={!!detail} onClose={() => setDetail(null)} title={`Salary Slip — ${detail?.employee_name} (${month})`} wide>
        {detail && (
          <div className="space-y-4 max-h-[75vh] overflow-y-auto">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Base Salary" value={fmt(detail.base_salary)} color="text-gray-700" />
              <Stat label="Per-Day Rate" value={fmt(detail.per_day_rate)} color="text-gray-700" />
              <Stat label="Paid Days" value={detail.paid_days} color="text-emerald-700" />
              <Stat label="Net Pay" value={fmt(detail.net_pay)} color="text-emerald-700 font-bold" />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Half Days" value={detail.half_days} color="text-orange-600" />
              <Stat label="Absent" value={detail.absent_days} color="text-red-600" />
              <Stat label="Late Marks" value={`${detail.late_marks}${detail.lates_converted_absent ? ` (-${detail.lates_converted_absent} day)` : ''}`} color="text-amber-600" />
              <Stat label="Late Penalty" value={detail.late_penalty ? fmt(detail.late_penalty) : '0'} color="text-red-600" />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Attendance Days" value={detail.present_days} color="text-emerald-700" />
              <Stat label="Sundays" value={detail.sunday_count} color="text-blue-600" />
              <Stat label="Paid CL/Leave" value={detail.paid_leaves} color="text-purple-600" />
              <Stat label={`OT (>${detail.ot_threshold || 9}h)`} value={`${detail.ot_hours} h (+${fmt(detail.ot_pay)})`} color="text-blue-600" />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Salary before OT" value={fmt(detail.net_before_ot ?? (detail.net_pay - (detail.ot_pay || 0)))} color="text-gray-700" />
              <Stat label="OT Pay" value={`+${fmt(detail.ot_pay)}`} color="text-blue-600" />
              <Stat label="OT Rate / Hour" value={`${fmt(detail.ot_per_hour_rate)}`} color="text-blue-600" />
              <Stat label="Net (after OT)" value={fmt(detail.net_pay)} color="text-emerald-700 font-bold" />
            </div>

            {/* Earnings Breakdown — matches the printable slip */}
            <div className="border rounded p-3 bg-emerald-50">
              <h5 className="font-semibold text-sm mb-2 text-emerald-700">Earnings Breakdown</h5>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">Basic Pay</span><span className="font-semibold">{fmt(detail.basic_pay)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Conveyance</span><span className="font-semibold">{fmt(detail.conveyance)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">HRA</span><span className="font-semibold">{fmt(detail.hra)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Adhoc</span><span className="font-semibold">{fmt(detail.adhoc)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Misc</span><span className="font-semibold">{fmt(detail.misc)}</span></div>
                <div className="flex justify-between border-t pt-1 col-span-full sm:col-span-1"><span className="font-bold">Total</span><span className="font-bold text-emerald-700">{fmt(detail.total_earnings)}</span></div>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="CL Used" value={`${detail.cl_used} / ${detail.settings?.cl_per_month ?? '?'}`} color="text-purple-600" />
              <Stat label="SL Used" value={`${detail.sl_used} / ${detail.settings?.sl_per_month ?? '?'}`} color="text-purple-600" />
              <Stat label="PL Used" value={`${detail.pl_used} / ${detail.settings?.pl_per_month ?? '?'}`} color="text-purple-600" />
              <Stat label="Short Leave" value={detail.short_leave_used} color="text-purple-600" />
            </div>

            <div>
              <h5 className="font-semibold text-sm mb-2">Day-by-Day Breakdown</h5>
              <div className="overflow-x-auto border rounded">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left p-2">Date</th>
                      <th className="text-left p-2">Day</th>
                      <th className="text-left p-2">Status</th>
                      <th className="text-left p-2">Punch In</th>
                      <th className="text-right p-2">Hrs</th>
                      <th className="text-right p-2">Pay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.breakdown?.map((d, i) => (
                      <tr key={i} className="border-t">
                        <td className="p-2">{d.date}</td>
                        <td className="p-2">{d.day}</td>
                        <td className="p-2"><span className={`text-[10px] px-1.5 py-0.5 rounded ${LABEL_PILL[d.label] || 'bg-gray-100'}`}>{d.label.replace(/_/g, ' ')}</span></td>
                        <td className="p-2">{d.punch_in ? fmtTime(d.punch_in, { hour: '2-digit', minute: '2-digit' }) : '-'}</td>
                        <td className="p-2 text-right">{d.hours || '-'}</td>
                        <td className="p-2 text-right font-semibold">{d.pay}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-3 border-t">
              <a href={`/payroll/slip/${detail.employee_id}?month=${month}`} target="_blank" rel="noreferrer" className="btn btn-success text-sm">Open SEPL Salary Slip</a>
              <button onClick={() => setDetail(null)} className="btn btn-primary text-sm">Close</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div className="p-3 bg-gray-50 rounded">
      <p className="text-[10px] text-gray-500 uppercase">{label}</p>
      <p className={`text-base ${color || 'text-gray-700'}`}>{value}</p>
    </div>
  );
}

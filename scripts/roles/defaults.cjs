// Explicit starting permissions for the shared salon roles. No per-person grants.
const modules = ['dashboard','salon_appointments','salon_pos','salon_clients','salon_services','salon_products','salon_stylists','salon_memberships','salon_commissions','attendance','attendance_capture','attendance_corrections','attendance_locations','attendance_tracking','employee_shifts','employee_links','attendance_rules','attendance_rosters','attendance_policies','attendance_requests','attendance_periods','payroll','employees','delegations','checklists','help_tickets','work_settings','site_chat','ai_agent','users'];
const row=(module,actions='v',scope='self')=>({module,can_view:+actions.includes('v'),can_create:+actions.includes('c'),can_edit:+actions.includes('e'),can_delete:+actions.includes('d'),can_approve:+actions.includes('a'),can_see_all:+(scope==='all'),scope_mode:scope,scope_branches:'[]'});
const base=()=>[row('attendance'),row('attendance_capture','vc'),row('attendance_requests','vc'),row('delegations','ve'),row('checklists','ve'),row('help_tickets','vce'),row('salon_services','v','all')];
const role=(name,description,grants)=>({name,description,permissions:modules.map(m=>grants.findLast(p=>p.module===m)||row(m,m==='dashboard'?'v':''))});
const salon=(m,a='v')=>row('salon_'+m,a,'all');
const defaults=[
 role('Admin','Full salon administration; permission ownership remains explicitly nominated',modules.map(m=>row(m,'vceda','all'))),
 role('Salon Manager','Shared salon operations; attendance and workflows for self and direct reports',[
  ...base(),row('dashboard','v','all'),...['appointments','clients','services','products','stylists','memberships'].map(m=>salon(m,'vce')),salon('pos','vc'),salon('commissions'),
  row('employees','v','team'),row('attendance','va','team'),row('attendance_requests','vca','team'),row('attendance_rosters','v','team'),row('employee_shifts','v','team'),
  ...['delegations','checklists','help_tickets'].map(m=>row(m,'vcea','team'))]),
 role('Receptionist','Bookings, client records and billing; own attendance and work',[
  ...base(),salon('appointments','vce'),salon('clients','vce'),salon('pos','vc'),salon('products'),salon('stylists'),salon('memberships')]),
 role('Cashier','Create bills and client records; read booking and catalog information; own work',[
  ...base(),salon('pos','vc'),salon('clients','vc'),salon('appointments'),salon('products'),salon('stylists'),salon('memberships')]),
 role('Stylist','Own linked appointments and commissions; own attendance and assigned work',[
  ...base(),row('salon_appointments'),row('salon_commissions')]),
 role('Viewer','Read service catalog and own work only; no financial or staff-wide reporting',[
  salon('services'),row('attendance'),row('delegations'),row('checklists'),row('help_tickets')]),
 role('Employee attendance self-service','Own attendance, punch in/out and correction requests',[
  row('attendance'),row('attendance_capture','vc'),row('attendance_requests','vc')]),
 role('Employee work self-service','Employee default: own attendance, tasks, checklists, tickets and service catalog',base()),
 role('Attendance foundation owner','Explicit owner: attendance configuration, staff and payroll',modules.filter(m=>m.startsWith('attendance')||['employees','employee_links','employee_shifts','payroll'].includes(m)).map(m=>row(m,'vceda','all'))),
 role('Workflows owner','Explicit owner: all tasks, checklists, tickets and workflow settings',[
  ...['delegations','checklists','help_tickets','work_settings'].map(m=>row(m,'vcea','all'))])
];
module.exports={modules,defaults};

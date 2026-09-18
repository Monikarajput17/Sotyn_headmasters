-- Basic employee self-service, explicitly requested by the owner.
-- Initial assignment only: later owner revocations are not restored by login/GET.
INSERT INTO roles(name,description,is_system)
VALUES('Employee attendance self-service','Own attendance history and punch in/out only; broader access requires separate grants',1)
ON CONFLICT(name) DO NOTHING;
INSERT INTO role_permissions(role_id,module,can_view,can_create,can_edit,can_delete,can_approve,can_see_all,scope_mode,scope_branches)
SELECT r.id,m.module,1,m.can_create,0,0,0,0,'self','[]'
FROM roles r CROSS JOIN (VALUES ('attendance',0),('attendance_capture',1)) m(module,can_create)
WHERE r.name='Employee attendance self-service'
ON CONFLICT(role_id,module) DO NOTHING;
INSERT INTO user_roles(user_id,role_id)
SELECT u.id,r.id FROM users u CROSS JOIN roles r
WHERE r.name='Employee attendance self-service' AND u.active=1 AND COALESCE(u.archived,0)=0
ON CONFLICT(user_id,role_id) DO NOTHING;

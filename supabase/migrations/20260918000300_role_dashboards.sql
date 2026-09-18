-- Dashboard entry is available to every existing role. Cards still require
-- their source-module grants; this does not grant financial or staff access.
INSERT INTO role_permissions(role_id,module,can_view,can_create,can_edit,can_delete,can_approve,can_see_all,scope_mode,scope_branches)
SELECT id,'dashboard',1,0,0,0,0,0,'self','[]' FROM roles
ON CONFLICT(role_id,module) DO UPDATE SET can_view=1;

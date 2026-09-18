-- Rejected requests remain visible, but a corrected proposal may be submitted.
-- Only one pending/approved adjustment may exist for a source revision.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='payroll_attendance_adjustments'::regclass AND contype='u' LOOP
  EXECUTE format('ALTER TABLE payroll_attendance_adjustments DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
CREATE UNIQUE INDEX attendance_adjustment_active_revision
 ON payroll_attendance_adjustments(employee_id,source_month,source_revision)
 WHERE status IN ('pending','approved');

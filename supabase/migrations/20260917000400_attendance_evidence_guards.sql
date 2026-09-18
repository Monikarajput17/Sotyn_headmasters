-- Preserve amendment decisions and original captures, including writes from old clients.
ALTER TABLE payroll_attendance_adjustments ADD COLUMN decision_reason text;
ALTER TABLE payroll_attendance_adjustments ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE attendance_requests DROP CONSTRAINT attendance_requests_kind_check;
ALTER TABLE attendance_requests ADD CONSTRAINT attendance_requests_kind_check CHECK(kind IN ('correction','capture_exception','leave_amendment'));

CREATE OR REPLACE FUNCTION attendance_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status<>'pending' THEN RAISE EXCEPTION 'Decisions are preserved; submit a new amendment' USING ERRCODE='P0001'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','decided_by','decided_at','decision_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','decided_by','decided_at','decision_reason']) THEN
  RAISE EXCEPTION 'Original request must be preserved' USING ERRCODE='P0001';
 END IF;
 IF NEW.status<>'pending' AND (NEW.decided_by IS NULL OR NEW.decided_at IS NULL OR length(trim(COALESCE(NEW.decision_reason,'')))<3) THEN
  RAISE EXCEPTION 'A decision needs its actor, time and reason' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER adjustment_decision_guard BEFORE UPDATE OR DELETE ON payroll_attendance_adjustments FOR EACH ROW EXECUTE FUNCTION attendance_decision_guard();

CREATE FUNCTION attendance_punch_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Attendance evidence cannot be deleted; request a correction' USING ERRCODE='P0001'; END IF;
 IF OLD.punch_in_time IS NOT NULL AND
   (to_jsonb(NEW)-ARRAY['punch_out_time','punch_out_lat','punch_out_lng','punch_out_address','punch_out_photo','punch_out_accuracy','total_hours','capture_state','review_state']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['punch_out_time','punch_out_lat','punch_out_lng','punch_out_address','punch_out_photo','punch_out_accuracy','total_hours','capture_state','review_state']) THEN
   RAISE EXCEPTION 'Original check-in evidence cannot be changed' USING ERRCODE='P0001';
 END IF;
 IF OLD.punch_out_time IS NOT NULL AND
   (to_jsonb(NEW)-ARRAY['capture_state','review_state']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['capture_state','review_state']) THEN
   RAISE EXCEPTION 'Original checkout evidence cannot be changed' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER punch_evidence_guard BEFORE UPDATE OR DELETE ON attendance FOR EACH ROW EXECUTE FUNCTION attendance_punch_evidence_guard();

CREATE FUNCTION attendance_leave_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(7430,1);
 IF TG_OP<>'INSERT' AND OLD.status<>'pending' THEN RAISE EXCEPTION 'Decided leave is immutable; submit a leave amendment' USING ERRCODE='P0001'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.from_date>NEW.to_date OR NEW.days<=0 OR NEW.hours<0 THEN RAISE EXCEPTION 'Invalid leave dates or quantities' USING ERRCODE='P0001'; END IF;
 IF NEW.status IN ('approved','pending') AND EXISTS(SELECT 1 FROM leave_requests l WHERE l.user_id=NEW.user_id AND l.id<>NEW.id AND l.status IN ('approved','pending') AND l.from_date<=NEW.to_date AND l.to_date>=NEW.from_date
 AND NOT EXISTS(SELECT 1 FROM attendance_requests r WHERE r.kind='leave_amendment' AND r.status='approved' AND (r.proposed->>'leave_id')::bigint=l.id)) THEN
  RAISE EXCEPTION 'Overlapping leave exists; amend that request instead' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER leave_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON leave_requests FOR EACH ROW EXECUTE FUNCTION attendance_leave_guard();

-- A cancelled or exhausted read-only operation must not leave a queued metric attempt forever.
create function public.studio_close_terminal_metric_operation()
returns trigger language plpgsql security definer set search_path=public,pg_catalog as $$
declare error_code text; affected integer;
begin
 error_code:=case when new.status='cancelled' then 'OPERATION_CANCELLED' when new.error like 'Restore interrupted%' then 'RESTORE_INTERRUPTED' else 'OPERATION_FAILED' end;
 update public.studio_metric_attempts set status=case when new.status='cancelled' then 'cancelled' else 'failed' end,error=error_code,finished_at=now()
 where workspace_id=new.workspace_id and operation_id=new.id and status='queued';
 get diagnostics affected=row_count;
 if affected>0 then update public.studio_metric_polls p set blocked_reason=error_code,next_at=greatest(next_at,now()+interval '1 minute')
 from public.studio_metric_attempts a where a.workspace_id=p.workspace_id and a.job_id=p.job_id and a.operation_id=new.id;end if;
 return new;
end $$;
revoke all on function public.studio_close_terminal_metric_operation() from public,anon,authenticated;
create trigger studio_close_terminal_metric_operation after update of status on public.studio_operations
for each row when (new.kind='collect_metrics' and old.status is distinct from new.status and new.status in ('cancelled','failed'))
execute function public.studio_close_terminal_metric_operation();
notify pgrst,'reload schema';

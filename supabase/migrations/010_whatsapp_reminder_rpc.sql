-- ============================================================================
-- PG MANAGER — 010_whatsapp_reminder_rpc.sql  (Module 6)
-- ============================================================================
-- generate_whatsapp_reminder_payload(p_tenant_id, p_period) builds everything
-- the client needs for a 1-tap WhatsApp payment reminder:
--   wa.me URL + prefilled text (tenant name, month, due amount, owner UPI).
-- SECURITY INVOKER: RLS guarantees the caller owns this tenant.
-- due = ledger due - paid (falls back to the tenant's effective rent when
-- no ledger row exists yet). Phone normalized to bare digits for wa.me.

-- Preserve JSON/JSONB return types and existing grants on partial deployments.
DO $migration$
DECLARE
  existing_type oid;
  definition text := $definition$create or replace function public.generate_whatsapp_reminder_payload(p_tenant_id uuid, p_period text default null)
returns json
language plpgsql
security invoker
stable
set search_path = public
as $$
declare
  t          tenants%rowtype;
  prop       properties%rowtype;
  led        rent_ledger%rowtype;
  v_period   text := coalesce(p_period, to_char(now(), 'YYYY-MM'));
  v_due      numeric;
  v_phone    text;
  v_text     text;
  v_upi      text;
begin
  select * into t from tenants where id::text = p_tenant_id::text and deleted_at is null;
  if not found then
    raise exception 'tenant % not found', p_tenant_id using errcode = 'P0002';
  end if;

  select * into prop from properties where id::text = t.property_id::text;
  select * into led from rent_ledger
    where tenant_id::text = p_tenant_id::text and period = v_period and deleted_at is null
    limit 1;

  v_due := case
             when led.id is not null then greatest(led.due - led.paid, 0)
             else coalesce(t.rent_amount, 0)
           end;
  v_upi := prop.upi_id;

  v_text := 'Namaste ' || t.name || ' ji,'
     || chr(10) || chr(10)
     || 'This is a friendly reminder for your ' || to_char(to_date(v_period || '-01', 'YYYY-MM-DD'), 'FMMonth YYYY')
     || ' rent of Rs. ' || to_char(v_due, 'FM999999999')
     || (case when v_upi is not null and v_upi <> ''
              then '.' || chr(10) || chr(10) || 'You can pay directly via UPI: ' || v_upi
              else '.' end)
     || chr(10) || chr(10) || 'Thank you! - ' || coalesce(nullif(prop.name, ''), 'Management');

  -- wa.me wants bare digits (country code, no +, no spaces).
  v_phone := regexp_replace(coalesce(t.phone, ''), '[^0-9]', '', 'g');

  return json_build_object(
    'tenant_id',  p_tenant_id,
    'period',     v_period,
    'tenant_name', t.name,
    'due_amount', v_due,
    'upi_id',     v_upi,
    'phone_e164', v_phone,
    'message',    v_text,
    'wa_url',     'https://wa.me/' || v_phone || '?text=' || v_text
  );
end;
$$;$definition$;
BEGIN
  SELECT prorettype INTO existing_type FROM pg_proc
  WHERE oid = to_regprocedure('public.generate_whatsapp_reminder_payload(uuid,text)');
  IF existing_type = 'jsonb'::regtype THEN
    definition := replace(definition, 'returns json', 'returns jsonb');
    definition := replace(definition, 'json_build_object(', 'jsonb_build_object(');
  ELSIF existing_type IS NOT NULL AND existing_type <> 'json'::regtype THEN
    RAISE EXCEPTION 'Unexpected reminder RPC return type: %', existing_type::regtype;
  END IF;
  EXECUTE definition;
END;
$migration$;

-- Self-check
select proname, prosecdef as is_security_definer
from pg_proc
where proname = 'generate_whatsapp_reminder_payload';

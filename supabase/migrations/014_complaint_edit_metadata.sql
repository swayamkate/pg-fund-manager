-- Preserve editable resolution dates and the linked repair expense across devices.
ALTER TABLE public.complaints
  ADD COLUMN IF NOT EXISTS resolved_at date,
  ADD COLUMN IF NOT EXISTS expense_id text;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- PG MANAGER — 006_tenant_documents_storage.sql
-- ============================================================================
-- Private Supabase Storage bucket for tenant ID scans (Aadhaar/PAN/license).
-- Folder convention: <owner_id>/<tenant_id>/<filename> — RLS on storage.objects
-- pins every operation to the owner's own top-level folder, so even a leaked
-- anon key can only reach the signed-in owner's own documents.
-- Signed URLs (default 1h) keep the bucket private: no public object access.

-- ---------- 1. Tenant columns for the document reference ----------
alter table tenants add column if not exists id_proof_url  text;  -- signed URL (short-lived)
alter table tenants add column if not exists id_proof_path text;  -- bucket path (stable id)

-- ---------- 2. Private bucket ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-documents', 'tenant-documents', false, 5242880,
        array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg','image/png','image/webp','application/pdf'];

-- ---------- 3. Owner-scoped storage RLS ----------
-- (storage.foldername(name))[1] is the first path segment — the owner_id.
drop policy if exists "tenant-documents owner read"   on storage.objects;
drop policy if exists "tenant-documents owner insert" on storage.objects;
drop policy if exists "tenant-documents owner update" on storage.objects;
drop policy if exists "tenant-documents owner delete" on storage.objects;

create policy "tenant-documents owner read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tenant-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "tenant-documents owner insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'tenant-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "tenant-documents owner update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'tenant-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'tenant-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "tenant-documents owner delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'tenant-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------- 4. Self-check ----------
select policyname, cmd
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname like 'tenant-documents%'
order by policyname;

-- Apply once, as the trusted schema owner, to a dedicated development branch first.
begin;
create schema neon_sync;
revoke all on schema neon_sync from public;
alter default privileges in schema neon_sync revoke execute on functions from public;

create table neon_sync.vaults (
  id uuid primary key, protocol integer not null default 1 check (protocol = 1),
  revision bigint not null default 0 check (revision >= 0), last_cleanup timestamptz
);
create table neon_sync.device_access (
  role_name name primary key, vault_id uuid not null references neon_sync.vaults(id)
);
create index on neon_sync.device_access(vault_id);
create table neon_sync.notes (
  vault_id uuid not null references neon_sync.vaults(id), path text not null,
  content text, hash text, deleted boolean not null, revision bigint not null,
  device uuid not null, updated_at timestamptz not null default now(),
  primary key(vault_id, path), unique(vault_id, revision),
  check ((deleted and content is null and hash is null) or
    (not deleted and content is not null and hash is not null and octet_length(content) <= 1048576))
);
create table neon_sync.operations (
  vault_id uuid not null references neon_sync.vaults(id), operation_id uuid not null,
  fingerprint text not null, result jsonb not null,
  primary key(vault_id, operation_id)
);
create table neon_sync.note_history (
  like neon_sync.notes including defaults including constraints,
  expires_at timestamptz,
  primary key(vault_id, path, revision),
  foreign key(vault_id) references neon_sync.vaults(id)
);
create index on neon_sync.note_history(vault_id, expires_at) where expires_at is not null;

create function neon_sync.authorized_vault() returns uuid
language plpgsql stable security definer set search_path = pg_catalog, neon_sync as $$
declare v uuid;
begin
  select vault_id into v from neon_sync.device_access where role_name = session_user;
  if v is null then raise exception 'unauthorized' using errcode='42501'; end if;
  return v;
end $$;

create function neon_sync.valid_path(p text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select p is not null and octet_length(p) <= 1024 and p ~ '\.md$'
    and p !~ '(^/|//|[\\:*?"<>|\x01-\x1f\x7f])'
    and not exists (select 1 from unnest(string_to_array(p, '/')) as part
      where part = '' or left(part,1) = '.' or part ~ '[. ]$'
      or part ~* '^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)');
$$;

create function neon_sync.json_note(n neon_sync.notes, body boolean default true) returns jsonb
language sql immutable set search_path = pg_catalog as $$
  select jsonb_build_object('path', n.path, 'hash', n.hash, 'deleted', n.deleted,
    'revision', n.revision::text, 'device', n.device::text, 'updatedAt', n.updated_at)
    || case when body then jsonb_build_object('content', n.content) else '{}'::jsonb end;
$$;

create function neon_sync.manifest() returns jsonb
language sql stable security definer set search_path = pg_catalog, neon_sync as $$
  select jsonb_build_object('protocol', v.protocol, 'vault', v.id::text, 'revision', v.revision::text,
    'notes', coalesce((select jsonb_agg(neon_sync.json_note(n, false) order by n.path)
      from neon_sync.notes n where n.vault_id = v.id), '[]'::jsonb))
  from neon_sync.vaults v where v.id = neon_sync.authorized_vault();
$$;

create function neon_sync.write_note(v uuid, p text, body text, d uuid, rev bigint) returns void
language plpgsql set search_path = pg_catalog, neon_sync as $$
begin
  update neon_sync.note_history set expires_at = clock_timestamp() + interval '30 days'
    where vault_id=v and path=p and expires_at is null;
  insert into neon_sync.notes(vault_id,path,content,hash,deleted,revision,device,updated_at)
    values (v,p,body,case when body is null then null else encode(sha256(convert_to(body,'UTF8')),'hex') end,
      body is null,rev,d,clock_timestamp())
    on conflict(vault_id,path) do update set content=excluded.content, hash=excluded.hash,
      deleted=excluded.deleted, revision=excluded.revision, device=excluded.device, updated_at=excluded.updated_at;
  insert into neon_sync.note_history(vault_id,path,content,hash,deleted,revision,device,updated_at)
    select vault_id,path,content,hash,deleted,revision,device,updated_at from neon_sync.notes where vault_id=v and path=p;
end $$;

create function neon_sync.apply(op jsonb, expected_revision bigint default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, neon_sync as $$
declare
  v uuid := neon_sync.authorized_vault(); r bigint; ident uuid; d uuid;
  p text := op->>'path'; dest text := op->>'destination'; kind text := op->>'kind';
  fingerprint text := encode(sha256(convert_to(op::text,'UTF8')),'hex');
  previous neon_sync.operations%rowtype; result jsonb;
begin
  -- Serialize revision assignment and visibility until transaction commit.
  select revision into r from neon_sync.vaults where id=v and protocol=1 for update;
  if r is null then raise exception 'protocol mismatch' using errcode='22023'; end if;
  begin ident := (op->>'id')::uuid; d := (op->>'device')::uuid;
  exception when invalid_text_representation then raise exception 'invalid identifiers' using errcode='22023'; end;
  if ident is null or d is null then raise exception 'missing identifiers' using errcode='22023'; end if;
  select * into previous from neon_sync.operations where vault_id=v and operation_id=ident;
  if found then
    if previous.fingerprint <> fingerprint then raise exception 'operation id reused' using errcode='22023'; end if;
    return previous.result;
  end if;
  if expected_revision is not null and expected_revision <> r then
    raise exception 'bootstrap changed' using errcode='P0002';
  end if;
  if kind is null or kind not in ('put','delete','rename') or not neon_sync.valid_path(p)
    or (kind in ('put','rename') and (jsonb_typeof(op->'content') is distinct from 'string'
      or octet_length(op->>'content') > 1048576))
    or (kind='rename' and (not neon_sync.valid_path(dest) or dest=p)) then
    raise exception 'invalid operation' using errcode='22023';
  end if;
  if kind='rename' then
    perform neon_sync.write_note(v,p,null,d,r+1);
    perform neon_sync.write_note(v,dest,op->>'content',d,r+2);
    r := r+2;
  else
    r := r+1;
    perform neon_sync.write_note(v,p,case when kind='delete' then null else op->>'content' end,d,r);
  end if;
  update neon_sync.vaults set revision=r where id=v;
  result := jsonb_build_object('revision',r::text);
  insert into neon_sync.operations values(v,ident,fingerprint,result);
  return result;
end $$;

create function neon_sync.changes(after_revision bigint, batch_limit integer default 100) returns jsonb
language sql stable security definer set search_path = pg_catalog, neon_sync as $$
  with batch as (
    select n, sum(octet_length(coalesce(n.content,'')) + octet_length(n.path) + 512)
      over(order by n.revision) as bytes
    from neon_sync.notes n where n.vault_id=neon_sync.authorized_vault() and n.revision > after_revision
    order by n.revision limit greatest(1,least(batch_limit,100))
  ) select coalesce(jsonb_agg(neon_sync.json_note(n) order by (n).revision), '[]'::jsonb)
    from batch where bytes <= 4194304;
$$;
create function neon_sync.note(p text) returns jsonb
language sql stable security definer set search_path = pg_catalog, neon_sync as $$
  select neon_sync.json_note(n) from neon_sync.notes n where n.vault_id=neon_sync.authorized_vault() and n.path=p;
$$;
create function neon_sync.history(p text, before_revision bigint default null) returns jsonb
language sql stable security definer set search_path = pg_catalog, neon_sync as $$
  select coalesce(jsonb_agg(jsonb_build_object('path',path,'hash',hash,'deleted',deleted,
    'revision',revision::text,'device',device::text,'updatedAt',updated_at) order by revision desc),'[]'::jsonb)
  from (select path,hash,deleted,revision,device,updated_at from neon_sync.note_history
    where vault_id=neon_sync.authorized_vault() and path=p and (expires_at is null or expires_at>now())
      and (before_revision is null or revision<before_revision) order by revision desc limit 50) h;
$$;
create function neon_sync.revision(p text, rev bigint) returns jsonb
language sql stable security definer set search_path = pg_catalog, neon_sync as $$
  select jsonb_build_object('path',path,'content',content,'hash',hash,'deleted',deleted,
    'revision',revision::text,'device',device::text,'updatedAt',updated_at)
  from neon_sync.note_history where vault_id=neon_sync.authorized_vault() and path=p and revision=rev
    and (expires_at is null or expires_at>now());
$$;
create function neon_sync.cleanup() returns jsonb
language plpgsql security definer set search_path = pg_catalog, neon_sync as $$
declare v uuid := neon_sync.authorized_vault();
begin
  update neon_sync.vaults set last_cleanup=now() where id=v
    and (last_cleanup is null or last_cleanup < now()-interval '1 day');
  if found then delete from neon_sync.note_history where vault_id=v and expires_at<=now(); end if;
  return '{}'::jsonb;
end $$;

revoke all on all tables in schema neon_sync from public;
revoke all on all functions in schema neon_sync from public;
commit;

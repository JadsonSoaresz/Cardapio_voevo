-- =====================================================================
-- Cardápio Vô e Vó · estrutura do banco no Supabase
-- Pode rodar mais de uma vez: não apaga dados existentes.
-- =====================================================================

-- ---------- Tabelas do cardápio ----------

create table if not exists public.categories (
  id          text primary key,
  position    integer not null,
  name        text not null,
  description text not null default '',
  note        text not null default ''
);

create table if not exists public.sections (
  id          text primary key,
  category_id text not null references public.categories (id) on delete cascade,
  position    integer not null,
  name        text not null default '',
  note        text not null default '',
  -- Dia da semana em que a seção ganha destaque (0 = domingo ... 6 = sábado), ex.: combos.
  weekday     smallint check (weekday between 0 and 6)
);

create table if not exists public.items (
  id          text primary key,
  section_id  text not null references public.sections (id) on delete cascade,
  position    integer not null,
  name        text not null,
  description text not null default '',
  price       numeric(10, 2) check (price >= 0),
  badge       text not null default '',
  image       text not null default '',
  available   boolean not null default true
);

create index if not exists sections_category_idx on public.sections (category_id, position);
create index if not exists items_section_idx on public.items (section_id, position);

-- Informações do estabelecimento ('info'), data da última alteração ('updated_at')
-- e hash da senha do painel ('auth').
create table if not exists public.app_settings (
  key   text primary key,
  value jsonb not null
);

-- Cópia do cardápio antes de cada salvamento (guarda as 30 últimas).
create table if not exists public.menu_backups (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  menu       jsonb not null
);

-- Fotos enviadas pelo painel (em base64, já reduzidas para até 1200px).
create table if not exists public.uploads (
  name         text primary key,
  content_type text not null,
  data         text not null,
  created_at   timestamptz not null default now()
);

-- Tentativas de login erradas, para bloquear quem tenta adivinhar a senha.
create table if not exists public.login_failures (
  ip       text primary key,
  count    integer not null,
  reset_at timestamptz not null
);

-- ---------- Segurança ----------
-- RLS ligado e nenhuma política: as chaves públicas (anon) não leem nem gravam nada.
-- Só o servidor do cardápio, com a chave secreta (service_role), acessa as tabelas.

alter table public.categories     enable row level security;
alter table public.sections       enable row level security;
alter table public.items          enable row level security;
alter table public.app_settings   enable row level security;
alter table public.menu_backups   enable row level security;
alter table public.uploads        enable row level security;
alter table public.login_failures enable row level security;

-- ---------- Funções usadas pelo servidor ----------

-- Monta o cardápio inteiro no formato que o site usa.
create or replace function public.get_menu()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'info', coalesce((select value from app_settings where key = 'info'), '{}'::jsonb),
    'updatedAt', (select value from app_settings where key = 'updated_at'),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'description', c.description,
        'note', c.note,
        'sections', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', s.id,
            'name', s.name,
            'note', s.note,
            'weekday', s.weekday,
            'items', coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', i.id,
                'name', i.name,
                'description', i.description,
                'price', i.price,
                'badge', i.badge,
                'image', i.image,
                'available', i.available
              ) order by i.position)
              from items i
              where i.section_id = s.id
            ), '[]'::jsonb)
          ) order by s.position)
          from sections s
          where s.category_id = c.id
        ), '[]'::jsonb)
      ) order by c.position)
      from categories c
    ), '[]'::jsonb)
  );
$$;

-- Substitui o cardápio inteiro (é o que o botão "Salvar alterações" faz), numa única transação.
create or replace function public.save_menu(p_menu jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  -- coalesce: sem a chave, jsonb_typeof dá null e a comparação não dispararia o erro.
  if coalesce(jsonb_typeof(p_menu -> 'categories'), '') <> 'array' then
    raise exception 'Cardápio inválido: falta a lista de categorias';
  end if;

  -- Backup da versão atual antes de sobrescrever.
  if exists (select 1 from categories) then
    insert into menu_backups (menu) values (get_menu());
    delete from menu_backups
    where id not in (select id from menu_backups order by id desc limit 30);
  end if;

  -- Seções e itens saem junto (on delete cascade). O "where true" atende ao
  -- pg-safeupdate do Supabase, que recusa DELETE sem WHERE.
  delete from categories where true;

  insert into categories (id, position, name, description, note)
  select c ->> 'id', c_pos, c ->> 'name',
         coalesce(c ->> 'description', ''), coalesce(c ->> 'note', '')
  from jsonb_array_elements(p_menu -> 'categories') with ordinality as cat(c, c_pos);

  insert into sections (id, category_id, position, name, note, weekday)
  select s ->> 'id', c ->> 'id', s_pos,
         coalesce(s ->> 'name', ''), coalesce(s ->> 'note', ''), (s ->> 'weekday')::smallint
  from jsonb_array_elements(p_menu -> 'categories') as cat(c),
       jsonb_array_elements(c -> 'sections') with ordinality as sec(s, s_pos);

  insert into items (id, section_id, position, name, description, price, badge, image, available)
  select i ->> 'id', s ->> 'id', i_pos, i ->> 'name',
         coalesce(i ->> 'description', ''), (i ->> 'price')::numeric,
         coalesce(i ->> 'badge', ''), coalesce(i ->> 'image', ''),
         coalesce((i ->> 'available')::boolean, true)
  from jsonb_array_elements(p_menu -> 'categories') as cat(c),
       jsonb_array_elements(c -> 'sections') as sec(s),
       jsonb_array_elements(s -> 'items') with ordinality as it(i, i_pos);

  insert into app_settings (key, value) values
    ('info', coalesce(p_menu -> 'info', '{}'::jsonb)),
    ('updated_at', coalesce(p_menu -> 'updatedAt', to_jsonb(now())))
  on conflict (key) do update set value = excluded.value;
end;
$$;

-- Conta uma senha errada; a contagem zera 15 minutos depois da primeira tentativa.
create or replace function public.register_login_failure(p_ip text)
returns integer
language sql
set search_path = public
as $$
  insert into login_failures (ip, count, reset_at)
  values (p_ip, 1, now() + interval '15 minutes')
  on conflict (ip) do update set
    count = case when login_failures.reset_at <= now() then 1 else login_failures.count + 1 end,
    reset_at = case when login_failures.reset_at <= now()
                    then now() + interval '15 minutes' else login_failures.reset_at end
  returning count;
$$;

-- Por padrão o Supabase deixa qualquer um chamar funções pela API; aqui só o servidor pode.
revoke execute on function public.get_menu() from public, anon, authenticated;
revoke execute on function public.save_menu(jsonb) from public, anon, authenticated;
revoke execute on function public.register_login_failure(text) from public, anon, authenticated;
grant execute on function public.get_menu() to service_role;
grant execute on function public.save_menu(jsonb) to service_role;
grant execute on function public.register_login_failure(text) to service_role;

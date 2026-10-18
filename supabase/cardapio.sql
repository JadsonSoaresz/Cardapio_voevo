-- =====================================================================
-- Cardápio Vô e Vó · Supabase
-- Gerado por scripts/gerar-sql-supabase.js a partir de seed/menu.json
-- 7 categorias, 23 seções, 92 itens.
--
-- Como usar: Supabase > SQL Editor > New query > cole este arquivo inteiro > Run.
-- Pode rodar de novo: atualiza os itens existentes sem duplicar.
-- =====================================================================

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

-- =====================================================================
-- Dados do cardápio
-- =====================================================================

begin;

insert into public.categories (id, position, name, description, note) values
  ('cuscuzeria', 1, 'Cuscuzeria do Vô', 'Tradição, sabor e aquele gostinho de casa de vô.', ''),
  ('tapiocas', 2, 'Tapiocas', 'Feitas com tapioca de qualidade e recheios que abraçam.', ''),
  ('lanches', 3, 'Lanches da Vó', '', ''),
  ('pratos-da-noite', 4, 'Pratos da Noite', 'Sabor caseiro para noites especiais.', ''),
  ('cafes-chocolates', 5, 'Cafés & Chocolates', '', ''),
  ('bebidas', 6, 'Bebidas', '', ''),
  ('combos', 7, 'Combos Promocionais', 'Promoções especiais do Vô & Vó.', 'Válidos somente de terça a quinta, das 17h às 22h.')
on conflict (id) do update set
  position = excluded.position,
  name = excluded.name,
  description = excluded.description,
  note = excluded.note;

insert into public.sections (id, category_id, position, name, note, weekday) values
  ('cuscuz-especial', 'cuscuzeria', 1, 'Especial da Casa', '', null),
  ('cuscuz-tradicionais', 'cuscuzeria', 2, 'Tradicionais', 'Massa de milho ou arroz. A escolha da massa é por conta da casa — consulte disponibilidade.', null),
  ('cuscuz-adicionais', 'cuscuzeria', 3, 'Adicionais', '', null),
  ('tapiocas-salgadas', 'tapiocas', 1, 'Salgadas', '', null),
  ('tapiocas-doces', 'tapiocas', 2, 'Doces', '', null),
  ('tapiocas-adicionais', 'tapiocas', 3, 'Adicionais (salgadas)', '', null),
  ('crepiocas-omeletes', 'lanches', 1, 'Crepiocas & Omeletes', '', null),
  ('lanches-da-vo', 'lanches', 2, 'Lanches', '', null),
  ('sobremesas', 'lanches', 3, 'Sobremesas', '', null),
  ('novidades', 'lanches', 4, 'Novidades', '', null),
  ('pratos', 'pratos-da-noite', 1, 'Pratos', '', null),
  ('caldos', 'pratos-da-noite', 2, 'Caldos', '', null),
  ('cafes-da-casa', 'cafes-chocolates', 1, 'Cafés da Casa', '', null),
  ('chocolates-especiais', 'cafes-chocolates', 2, 'Chocolates & Especiais', '', null),
  ('cafes-adicionais', 'cafes-chocolates', 3, 'Adicionais', '', null),
  ('sucos', 'bebidas', 1, 'Sucos Naturais (polpa)', '', null),
  ('refrigerantes', 'bebidas', 2, 'Refrigerantes', '', null),
  ('aguas', 'bebidas', 3, 'Águas', '', null),
  ('energeticos', 'bebidas', 4, 'Energéticos', '', null),
  ('cervejas', 'bebidas', 5, 'Cervejas Especiais', '', null),
  ('terca-do-cafe', 'combos', 1, 'Terça do Café', '', 2),
  ('quarta-do-cuscuz', 'combos', 2, 'Quarta do Cuscuz', '', 3),
  ('quinta-da-tapioca', 'combos', 3, 'Quinta da Tapioca', '', 4)
on conflict (id) do update set
  category_id = excluded.category_id,
  position = excluded.position,
  name = excluded.name,
  note = excluded.note,
  weekday = excluded.weekday;

insert into public.items (id, section_id, position, name, description, price, badge, image, available) values
  ('cuscuz-segredo-da-vo', 'cuscuz-especial', 1, 'Cuscuz Segredo da Vó', 'Cuscuz de macaxeira com carne desfiada, bacon crocante, raspa de queijo coalho e toque especial da casa.', 25, 'O mais pedido', '/img/pratos/cuscuz.svg', true),
  ('cuscuz-ovos', 'cuscuz-tradicionais', 1, 'Cuscuz com Ovos Mexidos da Vó', '', 10, '', '/img/pratos/cuscuz.svg', true),
  ('cuscuz-carne-de-sol', 'cuscuz-tradicionais', 2, 'Cuscuz de Carne de Sol do Vô', '', 15, '', '/img/pratos/cuscuz.svg', true),
  ('cuscuz-frango', 'cuscuz-tradicionais', 3, 'Cuscuz de Frango Desfiado da Vó', '', 13, '', '/img/pratos/cuscuz.svg', true),
  ('cuscuz-calabresa', 'cuscuz-tradicionais', 4, 'Cuscuz de Calabresa do Vô', '', 13, '', '/img/pratos/cuscuz.svg', true),
  ('cuscuz-queijo-banana', 'cuscuz-tradicionais', 5, 'Cuscuz com Queijo Coalho e Banana', 'Queijo coalho dourado, banana caramelizada e melaço.', 16, '', '/img/pratos/cuscuz.svg', true),
  ('cuscuz-add-queijo', 'cuscuz-adicionais', 1, 'Queijo extra', '', 5, '', '', true),
  ('cuscuz-add-frango', 'cuscuz-adicionais', 2, 'Frango extra', '', 5, '', '', true),
  ('cuscuz-add-carne-de-sol', 'cuscuz-adicionais', 3, 'Carne de sol extra', '', 7, '', '', true),
  ('cuscuz-add-ovo', 'cuscuz-adicionais', 4, 'Ovo extra', '', 2.5, '', '', true),
  ('cuscuz-add-requeijao', 'cuscuz-adicionais', 5, 'Requeijão extra', '', 3, '', '', true),
  ('cuscuz-add-calabresa', 'cuscuz-adicionais', 6, 'Calabresa extra', '', 5, '', '', true),
  ('cuscuz-add-bacon', 'cuscuz-adicionais', 7, 'Bacon extra', '', 5, '', '', true),
  ('tapioca-carne-de-sol', 'tapiocas-salgadas', 1, 'Tapioca de Carne de Sol do Vô', 'Carne de sol desfiada, bacon crocante, cheiro-verde e requeijão cremoso.', 19, 'Mais pedida', '/img/pratos/tapioca.svg', true),
  ('tapioca-frango', 'tapiocas-salgadas', 2, 'Tapioca de Frango Desfiado Cremoso da Vó', '', 16, '', '/img/pratos/tapioca.svg', true),
  ('tapioca-banana-mucarela', 'tapiocas-salgadas', 3, 'Tapioca de Banana Caramelizada e Muçarela', 'Recheada com banana caramelizada e queijo muçarela.', 15, '', '/img/pratos/tapioca.svg', true),
  ('tapioca-nutella', 'tapiocas-doces', 1, 'Tapioca de Nutella da Vó', '', 17, 'Favorita da casa', '/img/pratos/tapioca.svg', true),
  ('tapioca-coco', 'tapiocas-doces', 2, 'Tapioca de Coco do Vô', '', 15, '', '/img/pratos/tapioca.svg', true),
  ('tapioca-add-queijo', 'tapiocas-adicionais', 1, 'Queijo extra', '', 5, '', '', true),
  ('tapioca-add-frango', 'tapiocas-adicionais', 2, 'Frango extra', '', 5, '', '', true),
  ('tapioca-add-carne-de-sol', 'tapiocas-adicionais', 3, 'Carne de sol extra', '', 7, '', '', true),
  ('tapioca-add-ovo', 'tapiocas-adicionais', 4, 'Ovo extra', '', 2.5, '', '', true),
  ('tapioca-add-requeijao', 'tapiocas-adicionais', 5, 'Requeijão extra', '', 3, '', '', true),
  ('tapioca-add-calabresa', 'tapiocas-adicionais', 6, 'Calabresa extra', '', 5, '', '', true),
  ('tapioca-add-bacon', 'tapiocas-adicionais', 7, 'Bacon extra', '', 5, '', '', true),
  ('crepioca-frango', 'crepiocas-omeletes', 1, 'Crepioca de Frango Desfiado da Vó', 'Frango desfiado, requeijão, cenoura e muçarela.', 19, '', '/img/pratos/crepioca.svg', true),
  ('crepioca-carne-de-sol', 'crepiocas-omeletes', 2, 'Crepioca de Carne de Sol Desfiada', 'Carne desfiada, requeijão, milho e muçarela.', 21, '', '/img/pratos/crepioca.svg', true),
  ('omelete-frango', 'crepiocas-omeletes', 3, 'Omelete Cremoso de Frango', 'Ovos frescos com frango temperado, muçarela, milho verde e cheiro-verde. Leve, cremoso e muito saboroso.', 15, '', '/img/pratos/crepioca.svg', true),
  ('croque-vo-vo', 'lanches-da-vo', 1, 'Croque do Vô & Vó', 'Brioche, molho bechamel, peito de peru e muçarela gratinada.', 24, '', '/img/pratos/croissant.svg', true),
  ('pao-nurado', 'lanches-da-vo', 2, 'Pão Nurado da Vovó', 'Pão francês recheado com carne moída e muçarela.', 16, '', '/img/pratos/croissant.svg', true),
  ('waffle-doce-abraco', 'lanches-da-vo', 3, 'Waffle Doce Abraço', 'Nutella ou doce de leite com morangos.', 13, '', '/img/pratos/doce.svg', true),
  ('croque-sabor-da-roca', 'lanches-da-vo', 4, 'Croque Sabor da Roça', 'Carne de sol com molho especial da casa.', 26, '', '/img/pratos/croissant.svg', true),
  ('brownie-supremo', 'sobremesas', 1, 'Brownie Supremo', 'Com sorvete de creme e calda de chocolate, morango ou Nutella.', 22, '', '/img/pratos/doce.svg', true),
  ('fatia-bolo-noite', 'sobremesas', 2, 'Fatia de Bolo da Noite', '', 20, '', '/img/pratos/doce.svg', true),
  ('croissant-queijo-presunto', 'novidades', 1, 'Croissant de Queijo e Presunto', 'Croissant artesanal recheado com queijo e presunto.', 12, 'Novidade', '/img/pratos/croissant.svg', true),
  ('croissant-frango-requeijao', 'novidades', 2, 'Croissant de Frango com Requeijão', 'Croissant artesanal recheado com frango desfiado e requeijão cremoso.', 13, 'Novidade', '/img/pratos/croissant.svg', true),
  ('croissant-carne-de-sol', 'novidades', 3, 'Croissant de Carne de Sol', 'Croissant artesanal recheado com carne de sol desfiada e requeijão cremoso.', 15, 'Novidade', '/img/pratos/croissant.svg', true),
  ('arrumadinho', 'pratos', 1, 'Arrumadinho Raiz do Vô', 'Carne de sol, arroz Maria Isabel, creme de galinha, farofa e vinagrete.', 30, 'Destaque', '/img/pratos/prato.svg', true),
  ('talharim-branco-file', 'pratos', 2, 'Talharim ao Molho Branco e Filé', 'Talharim ao molho branco cremoso com filé selado.', 30, '', '/img/pratos/prato.svg', true),
  ('talharim-bolonhesa', 'pratos', 3, 'Talharim à Bolonhesa', 'Talharim ao molho de carne moída com tempero caseiro e toque especial.', 30, '', '/img/pratos/prato.svg', true),
  ('talharim-camarao', 'pratos', 4, 'Talharim de Camarão', 'Talharim ao molho cremoso com camarões selecionados e temperos especiais.', 35, '', '/img/pratos/prato.svg', true),
  ('caldo-reconforto', 'caldos', 1, 'Caldo Reconforto da Vó', 'Caldo de ovo acompanhado de pão francês e torradas.', 14, '', '/img/pratos/caldo.svg', true),
  ('caldinho-feijao', 'caldos', 2, 'Caldinho de Feijão com Bacon Crocante', '', 8, '', '/img/pratos/caldo.svg', true),
  ('cafe-expresso', 'cafes-da-casa', 1, 'Café Expresso', '', 7, '', '/img/pratos/cafe.svg', true),
  ('cafe-com-leite', 'cafes-da-casa', 2, 'Café com Leite', '', 8, '', '/img/pratos/cafe.svg', true),
  ('cappuccino-classico', 'cafes-da-casa', 3, 'Cappuccino Clássico', '', 13, '', '/img/pratos/cafe.svg', true),
  ('cappuccino-doce-de-leite', 'cafes-da-casa', 4, 'Cappuccino Doce de Leite', '', 16, '', '/img/pratos/cafe.svg', true),
  ('cappuccino-vienense', 'chocolates-especiais', 1, 'Cappuccino Vienense', '', 18, '', '/img/pratos/cafe.svg', true),
  ('cappuccino-nutella', 'chocolates-especiais', 2, 'Cappuccino Nutella', '', 18, '', '/img/pratos/cafe.svg', true),
  ('mocaccino', 'chocolates-especiais', 3, 'Mocaccino', '', 14, '', '/img/pratos/cafe.svg', true),
  ('chocolate-quente-gourmet', 'chocolates-especiais', 4, 'Chocolate Quente Cremoso Gourmet', '', 18, '', '/img/pratos/chocolate.svg', true),
  ('chocolate-quente-premium', 'chocolates-especiais', 5, 'Chocolate Quente Expresso Premium', '', 15, '', '/img/pratos/chocolate.svg', true),
  ('chocolate-gelado', 'chocolates-especiais', 6, 'Chocolate Gelado', '', 15, '', '/img/pratos/chocolate.svg', true),
  ('cafe-add-doce-de-leite', 'cafes-adicionais', 1, 'Doce de leite', '', 6, '', '', true),
  ('cafe-add-chantilly', 'cafes-adicionais', 2, 'Chantilly', '', 5, '', '', true),
  ('cafe-add-nutella', 'cafes-adicionais', 3, 'Nutella', '', 6, '', '', true),
  ('cafe-add-leite', 'cafes-adicionais', 4, 'Leite', '', 5, '', '', true),
  ('cafe-add-leite-zero', 'cafes-adicionais', 5, 'Leite zero lactose', '', 5, '', '', true),
  ('suco-acerola', 'sucos', 1, 'Acerola', '', 7, '', '/img/pratos/suco.svg', true),
  ('suco-caja', 'sucos', 2, 'Cajá', '', 7, '', '/img/pratos/suco.svg', true),
  ('suco-caju', 'sucos', 3, 'Caju', '', 7, '', '/img/pratos/suco.svg', true),
  ('suco-goiaba', 'sucos', 4, 'Goiaba', '', 7, '', '/img/pratos/suco.svg', true),
  ('suco-maracuja', 'sucos', 5, 'Maracujá', '', 10, '', '/img/pratos/suco.svg', true),
  ('cajuina', 'sucos', 6, 'Cajuína', '', 11, '', '/img/pratos/suco.svg', true),
  ('coca-cola', 'refrigerantes', 1, 'Coca-Cola', '', 7, '', '/img/pratos/lata.svg', true),
  ('coca-cola-zero', 'refrigerantes', 2, 'Coca-Cola Zero', '', 7, '', '/img/pratos/lata.svg', true),
  ('pepsi', 'refrigerantes', 3, 'Pepsi', '', 7, '', '/img/pratos/lata.svg', true),
  ('sprite', 'refrigerantes', 4, 'Sprite', '', 6, '', '/img/pratos/lata.svg', true),
  ('fanta', 'refrigerantes', 5, 'Fanta', '', 6, '', '/img/pratos/lata.svg', true),
  ('kuat', 'refrigerantes', 6, 'Kuat', '', 6, '', '/img/pratos/lata.svg', true),
  ('schweppes-citrus', 'refrigerantes', 7, 'Schweppes Citrus', '', 7, '', '/img/pratos/lata.svg', true),
  ('h2oh', 'refrigerantes', 8, 'H2OH!', '', 8, '', '/img/pratos/lata.svg', true),
  ('agua-mineral', 'aguas', 1, 'Água Mineral', '', 4, '', '/img/pratos/garrafa.svg', true),
  ('agua-com-gas', 'aguas', 2, 'Água Mineral com Gás', '', 5, '', '/img/pratos/garrafa.svg', true),
  ('red-bull', 'energeticos', 1, 'Red Bull', '', 15, '', '/img/pratos/lata.svg', true),
  ('red-bull-zero', 'energeticos', 2, 'Red Bull Zero', '', 15, '', '/img/pratos/lata.svg', true),
  ('heineken', 'cervejas', 1, 'Heineken (330ml)', '', 11, '', '/img/pratos/garrafa.svg', true),
  ('corona-extra', 'cervejas', 2, 'Corona Extra (330ml)', '', 11, '', '/img/pratos/garrafa.svg', true),
  ('corona-zero', 'cervejas', 3, 'Corona Zero Álcool (330ml)', '', 11, '', '/img/pratos/garrafa.svg', true),
  ('stella-artois', 'cervejas', 4, 'Stella Artois (330ml)', '', 11, '', '/img/pratos/garrafa.svg', true),
  ('stella-pure-gold', 'cervejas', 5, 'Stella Pure Gold (330ml)', '', 11, '', '/img/pratos/garrafa.svg', true),
  ('skol-beats-sense', 'cervejas', 6, 'Skol Beats Sense (269ml)', '', 14, '', '/img/pratos/garrafa.svg', true),
  ('combo-croissant-expresso', 'terca-do-cafe', 1, 'Croissant + Expresso', '', 21.9, '', '/img/pratos/croissant.svg', true),
  ('combo-misto-expresso', 'terca-do-cafe', 2, 'Misto Quente + Expresso', '', 14.9, '', '/img/pratos/croissant.svg', true),
  ('combo-cappuccino-misto', 'terca-do-cafe', 3, 'Cappuccino Doce de Leite + Misto Quente', '', 21.9, '', '/img/pratos/croissant.svg', true),
  ('combo-cuscuz-frango', 'quarta-do-cuscuz', 1, 'Cuscuz de Frango Desfiado + Expresso', '', 17.9, '', '/img/pratos/cuscuz.svg', true),
  ('combo-cuscuz-calabresa', 'quarta-do-cuscuz', 2, 'Cuscuz de Calabresa + Expresso', '', 17.9, '', '/img/pratos/cuscuz.svg', true),
  ('combo-cuscuz-carne-de-sol', 'quarta-do-cuscuz', 3, 'Cuscuz de Carne de Sol + Expresso', '', 19.9, '', '/img/pratos/cuscuz.svg', true),
  ('combo-cuscuz-ovos', 'quarta-do-cuscuz', 4, 'Cuscuz com Ovos Mexidos', '', 15.9, '', '/img/pratos/cuscuz.svg', true),
  ('combo-tapioca-frango', 'quinta-da-tapioca', 1, 'Tapioca de Frango + Expresso', '', 19.9, '', '/img/pratos/tapioca.svg', true),
  ('combo-tapioca-carne-de-sol', 'quinta-da-tapioca', 2, 'Tapioca de Carne de Sol + Expresso', '', 22.9, '', '/img/pratos/tapioca.svg', true),
  ('combo-2-tapiocas', 'quinta-da-tapioca', 3, '2 Tapiocas de Frango + 2 Expressos', '', 36.9, '', '/img/pratos/tapioca.svg', true)
on conflict (id) do update set
  section_id = excluded.section_id,
  position = excluded.position,
  name = excluded.name,
  description = excluded.description,
  price = excluded.price,
  badge = excluded.badge,
  image = excluded.image,
  available = excluded.available;

insert into public.app_settings (key, value) values
  ('info', '{"name":"Vô e Vó","subtitle":"Café & Tapiocaria","tagline":"Sabor com afeto e aquele gostinho de casa de vó.","footer":"Feito com ingredientes selecionados e muito carinho para você.","hours":"","address":"","whatsapp":"","instagram":""}'::jsonb),
  ('updated_at', to_jsonb(now()))
on conflict (key) do update set
  value = excluded.value;

commit;

-- Conferência: deve mostrar 7 categorias, 23 seções e 92 itens.
select
  (select count(*) from public.categories) as categorias,
  (select count(*) from public.sections) as secoes,
  (select count(*) from public.items) as itens;

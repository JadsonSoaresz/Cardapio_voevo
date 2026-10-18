'use strict';

// Gera supabase/cardapio.sql: a estrutura (supabase/schema.sql) + os inserts do cardápio.
//
//   npm run sql:supabase                      -> usa o cardápio inicial (seed/menu.json)
//   npm run sql:supabase -- data/menu.json    -> usa o cardápio editado no painel local

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = path.resolve(root, process.argv[2] || 'seed/menu.json');
const output = path.join(root, 'supabase', 'cardapio.sql');
const menu = JSON.parse(fs.readFileSync(source, 'utf8'));

const text = (value) => `'${String(value ?? '').replace(/'/g, "''")}'`;
const num = (value) => (value === null || value === undefined ? 'null' : String(Number(value)));
const bool = (value) => (value === false ? 'false' : 'true');

function insert(table, columns, rows, conflictKey) {
  if (rows.length === 0) return '';
  const updates = columns.filter((c) => c !== conflictKey).map((c) => `${c} = excluded.${c}`).join(',\n  ');
  return [
    `insert into public.${table} (${columns.join(', ')}) values`,
    rows.map((row) => `  (${row.join(', ')})`).join(',\n'),
    `on conflict (${conflictKey}) do update set\n  ${updates};`,
  ].join('\n');
}

const categories = [];
const sections = [];
const items = [];
menu.categories.forEach((c, ci) => {
  categories.push([text(c.id), ci + 1, text(c.name), text(c.description), text(c.note)]);
  c.sections.forEach((s, si) => {
    sections.push([text(s.id), text(c.id), si + 1, text(s.name), text(s.note), num(s.weekday)]);
    s.items.forEach((i, ii) => {
      items.push([text(i.id), text(s.id), ii + 1, text(i.name), text(i.description), num(i.price),
        text(i.badge), text(i.image), bool(i.available)]);
    });
  });
});

const settings = [
  [text('info'), `${text(JSON.stringify(menu.info))}::jsonb`],
  [text('updated_at'), `to_jsonb(now())`],
];

const sql = `-- =====================================================================
-- Cardápio Vô e Vó · Supabase
-- Gerado por scripts/gerar-sql-supabase.js a partir de ${path.relative(root, source).replace(/\\/g, '/')}
-- ${categories.length} categorias, ${sections.length} seções, ${items.length} itens.
--
-- Como usar: Supabase > SQL Editor > New query > cole este arquivo inteiro > Run.
-- Pode rodar de novo: atualiza os itens existentes sem duplicar.
-- =====================================================================

${fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8').trim()}

-- =====================================================================
-- Dados do cardápio
-- =====================================================================

begin;

${insert('categories', ['id', 'position', 'name', 'description', 'note'], categories, 'id')}

${insert('sections', ['id', 'category_id', 'position', 'name', 'note', 'weekday'], sections, 'id')}

${insert('items', ['id', 'section_id', 'position', 'name', 'description', 'price', 'badge', 'image', 'available'], items, 'id')}

${insert('app_settings', ['key', 'value'], settings, 'key')}

commit;

-- Conferência: deve mostrar ${categories.length} categorias, ${sections.length} seções e ${items.length} itens.
select
  (select count(*) from public.categories) as categorias,
  (select count(*) from public.sections) as secoes,
  (select count(*) from public.items) as itens;
`;

fs.writeFileSync(output, sql);
console.log(`Gerado ${path.relative(root, output)}: ${categories.length} categorias, ${sections.length} seções, ${items.length} itens.`);

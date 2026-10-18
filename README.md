# Cardápio virtual · Vô e Vó Café & Tapiocaria

Cardápio público (sem login) + painel administrativo com senha para editar itens, preços e categorias.
Não tem dependências: basta Node.js 18 ou superior.

## Rodar

```bash
npm start
```

- Cardápio dos clientes: http://localhost:3000
- Painel admin: http://localhost:3000/admin

Na primeira execução o servidor cria `data/` com o cardápio inicial e **mostra no terminal a senha do admin**.
Para escolher a senha em vez disso:

```bash
ADMIN_PASSWORD=minhasenha npm start           # só vale na primeira execução
npm run set-password -- NOVA_SENHA             # troca a qualquer momento
```

Também dá para trocar pelo painel, na aba **Senha**.

## Como funciona

| Caminho | O que é |
|---|---|
| `lib/app.js` | Rotas da API (`/api/menu`, login, senha, envio de fotos) e validação |
| `lib/storage.js` | Onde os dados ficam: Supabase, Upstash Redis ou pasta `data/` |
| `supabase/schema.sql` | Tabelas, funções e segurança do banco no Supabase |
| `supabase/cardapio.sql` | Estrutura + todos os itens do cardápio, pronto para colar no SQL Editor |
| `scripts/gerar-sql-supabase.js` | Gera o `cardapio.sql` (`npm run sql:supabase`) |
| `server.js` | Servidor para rodar no computador ou numa VPS |
| `api/index.js` + `vercel.json` | Entrada e configuração para a Vercel |
| `seed/menu.json` | Cardápio inicial (copiado para `data/` na primeira execução) |
| `data/menu.json` | Cardápio atual, alterado pelo painel |
| `data/backups/` | Cópia automática antes de cada salvamento (guarda as 30 últimas) |
| `data/auth.json` | Hash da senha (scrypt) e segredo da sessão |
| `data/uploads/` | Fotos enviadas pelo painel (reduzidas para até 1200px no navegador antes do envio) |
| `public/img/pratos/` | Ilustrações provisórias usadas até cada item ganhar uma foto real |
| `public/` | Página do cliente (`index.html`, `css/`, `js/`) e painel (`admin/`) |

Recursos do cardápio: abas fixas por categoria, busca (ignora acentos), destaque automático do combo do dia
(terça, quarta e quinta), selos ("Mais pedido"), itens indisponíveis riscados, rodapé com WhatsApp/Instagram/horário
e cópia offline da última versão vista no aparelho.

Para desfazer um salvamento, copie um arquivo de `data/backups/` por cima de `data/menu.json` e reinicie.

## Colocar no ar

### Banco de dados no Supabase

1. No Supabase, abra **SQL Editor → New query**, cole todo o conteúdo de `supabase/cardapio.sql` e clique em
   **Run**. Isso cria as tabelas (`categories`, `sections`, `items`, …) e insere o cardápio atual.
   O resultado final mostra a contagem: 7 categorias, 23 seções, 92 itens.
2. Pegue a **Project URL** e a chave **secreta** (`service_role` ou `sb_secret_…`) em **Project Settings → API**.
3. Cadastre `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` onde o site roda (Vercel ou `.env` local).

Para exportar o cardápio editado no computador em vez do inicial:
`npm run sql:supabase -- data/menu.json` e rode o `cardapio.sql` de novo (atualiza sem duplicar).

Segurança: todas as tabelas têm RLS ligado e nenhuma política, então a chave pública (`anon`) não acessa nada.
Só o servidor, com a chave secreta, lê e grava. Nunca coloque a chave secreta no código do navegador.

### Vercel

A Vercel não guarda arquivos gravados pelo site, então lá os dados ficam no Supabase.

1. Faça os passos do Supabase acima.
2. Em **Settings → Environment Variables**, crie `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`
   (e `ADMIN_PASSWORD` quando ligar a senha do painel).
3. **Deployments → Redeploy** (variáveis novas só valem depois de um novo deploy).

Sem banco configurado o cardápio abre com os dados iniciais, mas o painel avisa que não consegue salvar.
A `ADMIN_PASSWORD` só é usada para criar a senha na primeira vez; depois, troque pelo painel.
O Upstash Redis (`KV_REST_API_URL` / `KV_REST_API_TOKEN`) também funciona, como alternativa ao Supabase.

### Supabase no computador

Copie `.env.example` para `.env`, preencha e rode `npm run start:env`.

### Servidor com disco (VPS, Railway, Render, Fly.io)

Qualquer serviço que rode Node e tenha **disco persistente** (senão as alterações do admin somem ao reiniciar):
rode `npm start` e os dados ficam na pasta `data/`.

Variáveis de ambiente:

| Variável | Uso |
|---|---|
| `PORT` | Porta (padrão 3000) |
| `DATA_DIR` | Pasta dos dados; aponte para o volume persistente |
| `ADMIN_PASSWORD` | Senha inicial, usada só se ainda não houver senha salva |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase; quando presentes, os dados vão para o banco em vez de `data/` |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis (alternativa ao Supabase) |
| `COOKIE_SECURE=true` | Use quando o site estiver em HTTPS |
| `TRUST_PROXY=true` | Use atrás de proxy (Nginx, Render, Railway) para o limite de tentativas de login ver o IP real |

Depois de publicado, gere um QR Code com o endereço do site e coloque nas mesas.

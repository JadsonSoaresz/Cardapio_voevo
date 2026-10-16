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
| `server.js` | Servidor HTTP: entrega as páginas e a API (`/api/menu`, login, senha) |
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

Qualquer serviço que rode Node e tenha **disco persistente** (senão as alterações do admin somem ao reiniciar):
VPS com PM2, Railway com volume, Render com disco, Fly.io com volume etc.

Variáveis de ambiente:

| Variável | Uso |
|---|---|
| `PORT` | Porta (padrão 3000) |
| `DATA_DIR` | Pasta dos dados; aponte para o volume persistente |
| `ADMIN_PASSWORD` | Senha inicial, usada só se `auth.json` ainda não existir |
| `COOKIE_SECURE=true` | Use quando o site estiver em HTTPS |
| `TRUST_PROXY=true` | Use atrás de proxy (Nginx, Render, Railway) para o limite de tentativas de login ver o IP real |

Depois de publicado, gere um QR Code com o endereço do site e coloque nas mesas.

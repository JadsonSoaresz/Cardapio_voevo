'use strict';

// Servidor para rodar no computador ou numa VPS. Na Vercel quem atende é api/index.js.

const http = require('node:http');
const { handle, createAuth, ensureAuth, getStorage } = require('./lib/app');

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  const passwordFlag = process.argv.indexOf('--set-password');
  if (passwordFlag !== -1) {
    const password = process.argv[passwordFlag + 1];
    if (!password || password.length < 6) {
      console.error('Uso: npm run set-password -- NOVA_SENHA (mínimo 6 caracteres)');
      process.exit(1);
    }
    await getStorage().setAuth(createAuth(password));
    console.log('Senha do painel admin atualizada.');
    return;
  }

  // Cria a senha inicial já na partida (e mostra no terminal), em vez de esperar o primeiro login.
  await ensureAuth();

  http.createServer(handle).listen(PORT, () => {
    console.log(`Cardápio:      http://localhost:${PORT}`);
    console.log(`Painel admin:  http://localhost:${PORT}/admin`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

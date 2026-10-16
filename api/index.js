'use strict';

// Função da Vercel. O vercel.json manda /api/* e /uploads/* para cá; o resto (páginas, CSS,
// imagens) é servido direto da pasta public/ pela CDN da Vercel.
module.exports = require('../lib/app').handle;

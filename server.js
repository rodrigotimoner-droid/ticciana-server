require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const API_KEY  = process.env.API_KEY;
const MP_BASE  = 'https://api.mercadopago.com';
app.use(express.json());
app.use(cors());
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apikey;
  if (!API_KEY || key === API_KEY) return next();
  return res.status(401).json({ error: 'No autorizado' });
}
async function mp(path) {
  const r = await fetch(MP_BASE + path, { headers: { Authorization: 'Bearer ' + MP_TOKEN } });
  if (!r.ok) { const err = await r.text(); throw new Error('MP ' + r.status + ': ' + err); }
  return r.json();
}
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.get('/mp/balance', auth, async (req, res) => {
  try {
    const d = await mp('/v1/account/balance');
    res.json({ disponible: d.available_balance, enTransito: d.unavailable_balance, total: d.total_amount, moneda: d.currency_id });
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/mp/payments', auth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit)||20, 50);
    const dias = parseInt(req.query.dias)||30;
    const desde = new Date(Date.now() - dias*24*3600*1000).toISOString();
    const data = await mp('/v1/payments/search?sort=date_created&criteria=desc&range=date_created&begin_date='+desde+'&limit='+limit);
    const pagos = (data.results||[]).map(p=>({ id:p.id, fecha:p.date_created, monto:p.transaction_amount, moneda:p.currency_id, estado:p.status, medio:p.payment_type_id, descripcion:p.description||'', pagador:{nombre:p.payer?.first_name?(p.payer.first_name+' '+(p.payer.last_name||'')).trim():null,email:p.payer?.email||null} }));
    res.json({ total: data.paging?.total||pagos.length, pagos });
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/mp/payment/:id', auth, async (req, res) => {
  try {
    const p = await mp('/v1/payments/'+req.params.id);
    res.json({ id:p.id, fecha:p.date_created, monto:p.transaction_amount, estado:p.status, medio:p.payment_type_id, pagador:{nombre:p.payer?.first_name?(p.payer.first_name+' '+(p.payer.last_name||'')).trim():null,email:p.payer?.email||null} });
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.listen(PORT, () => {
  console.log('Ticciana MP Server en puerto ' + PORT);
  if (!MP_TOKEN) console.warn('MP_ACCESS_TOKEN no configurado');
  if (!API_KEY) console.warn('API_KEY no configurada');
});

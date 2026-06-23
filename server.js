// ═══════════════════════════════════════════════════════════════════════════════
//  TICCIANA SERVER — Proxy MercadoPago
//  Desplegá en Railway: https://railway.app
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

const MP_TOKEN     = process.env.MP_ACCESS_TOKEN;
const API_KEY      = process.env.API_KEY;
const MP_BASE      = 'https://api.mercadopago.com';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_ID      = process.env.GIST_ID;
const GIST_FILE    = 'ticciana-db.json';

app.use(express.json());
app.use(cors()); // permite llamadas desde tu HTML local

// ── Middleware: verifica la API_KEY en cada request ──────────────────────────
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apikey;
  if (!API_KEY || key === API_KEY) return next();
  return res.status(401).json({ error: 'No autorizado' });
}

// ── Helper: llama a la API de MP ─────────────────────────────────────────────
async function mp(path) {
  const r = await fetch(`${MP_BASE}${path}`, {
    headers: { Authorization: `Bearer ${MP_TOKEN}` }
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`MP ${r.status}: ${err}`);
  }
  return r.json();
}

// ── GET /health — ping para saber si el servidor está vivo ───────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'ticciana-mp-proxy', ts: new Date().toISOString() });
});

// ── GET /mp/balance — saldo disponible en MP ─────────────────────────────────
app.get('/mp/balance', auth, async (req, res) => {
  try {
    const data = await mp('/v1/account/balance');
    res.json({
      disponible:    data.available_balance,
      enTransito:    data.unavailable_balance,
      total:         data.total_amount,
      moneda:        data.currency_id
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /mp/payments — últimos pagos recibidos ───────────────────────────────
//   ?limit=20  (default 20, max 100)
//   ?dias=30   (últimos N días, default 30)
//   ?offset=0  (paginación)
app.get('/mp/payments', auth, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 20, 100);
    const dias   = parseInt(req.query.dias)  || 30;
    const offset = parseInt(req.query.offset) || 0;
    const desde  = new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();
    const hasta  = new Date().toISOString();

    const data = await mp(
      `/v1/payments/search?sort=date_created&criteria=desc&range=date_created` +
      `&begin_date=${desde}&end_date=${hasta}&limit=${limit}&offset=${offset}`
    );

    const pagos = (data.results || []).map(p => {
      // ── Comisiones y retenciones ──────────────────────────────────────────
      const fees       = p.fee_details || [];
      const comisionMP = fees.find(f => f.type === 'mercadopago_fee')?.amount  || 0;
      const financiacion = fees.find(f => f.type === 'financing_fee')?.amount  || 0;
      const otrasCom   = fees.filter(f => !['mercadopago_fee','financing_fee'].includes(f.type))
                              .reduce((s,f) => s + f.amount, 0);
      const totalCom   = fees.reduce((s,f) => s + f.amount, 0);

      return {
        id:              p.id,
        fecha:           p.date_created,
        fecha_aprobado:  p.date_approved  || null,
        monto:           p.transaction_amount,
        monto_neto:      p.transaction_details?.net_received_amount ?? null,
        moneda:          p.currency_id,
        estado:          p.status,
        medio:           p.payment_type_id,
        marca:           p.payment_method_id || null,
        cuotas:          p.installments || 1,
        descripcion:     p.description || '',
        pagador: {
          id:       p.payer?.id   || null,
          nombre:   p.payer?.first_name
                      ? `${p.payer.first_name} ${p.payer.last_name || ''}`.trim()
                      : null,
          email:    p.payer?.email  || null,
          dni:      p.payer?.identification?.number || null,
          tipo_doc: p.payer?.identification?.type   || null,
          telefono: p.payer?.phone?.number
                      ? `${p.payer.phone.area_code || ''}${p.payer.phone.number}`
                      : null,
        },
        comisiones: {
          mp:           comisionMP,
          financiacion: financiacion,
          otras:        otrasCom,
          total:        totalCom,
          detalle: fees.map(f => ({
            tipo:    f.type,
            monto:   f.amount,
            pagador: f.fee_payer
          }))
        },
        impuestos:   p.taxes_amount  || 0,
        externo_ref: p.external_reference || null,
      };
    });

    res.json({
      total:  data.paging?.total || pagos.length,
      offset: data.paging?.offset || 0,
      pagos
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /mp/payment/:id — detalle de un pago específico ──────────────────────
app.get('/mp/payment/:id', auth, async (req, res) => {
  try {
    const p = await mp(`/v1/payments/${req.params.id}`);
    res.json({
      id:          p.id,
      fecha:       p.date_created,
      monto:       p.transaction_amount,
      estado:      p.status,
      medio:       p.payment_type_id,
      descripcion: p.description,
      pagador: {
        nombre: p.payer?.first_name ? `${p.payer.first_name} ${p.payer.last_name || ''}`.trim() : null,
        email:  p.payer?.email || null,
        dni:    p.payer?.identification?.number || null
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /mp/match — cruza pagos recientes con clientes del sistema ───────────
app.post('/mp/match', auth, async (req, res) => {
  try {
    const clientes = req.body.clientes || [];
    const dias     = parseInt(req.query.dias) || 30;
    const desde    = new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();
    const hasta    = new Date().toISOString();
    const data     = await mp(`/v1/payments/search?sort=date_created&criteria=desc&range=date_created&begin_date=${desde}&end_date=${hasta}&limit=50`);
    const pagos    = (data.results || []).filter(p => p.status === 'approved');

    const resultado = pagos.map(p => {
      const emailPagador  = (p.payer?.email || '').toLowerCase();
      const nombrePagador = `${p.payer?.first_name || ''} ${p.payer?.last_name || ''}`.toLowerCase().trim();
      let match = clientes.find(c => c.email && c.email.toLowerCase() === emailPagador);
      if (!match && nombrePagador) {
        match = clientes.find(c => {
          const nc = c.name.toLowerCase();
          return nc === nombrePagador ||
                 nombrePagador.includes(nc.split(' ')[0]) ||
                 nc.includes(nombrePagador.split(' ')[0]);
        });
      }
      return {
        id:              p.id,
        fecha:           p.date_created,
        monto:           p.transaction_amount,
        medio:           p.payment_type_id,
        pagador_email:   p.payer?.email || null,
        pagador_nombre:  nombrePagador || null,
        cliente_match:   match ? { id: match.id, name: match.name } : null,
        confianza:       match ? (emailPagador && emailPagador === (match.email||'').toLowerCase() ? 'alta' : 'media') : null
      };
    });

    res.json({ pagos: resultado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /db — trae el JSON persistido (GitHub Gist) ─────────────────────────
app.get('/db', auth, async (req, res) => {
  try {
    if (!GITHUB_TOKEN || !GIST_ID)
      return res.status(503).json({ error: 'GITHUB_TOKEN o GIST_ID no configurados en Railway' });
    const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'ticciana-server'
      }
    });
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
    const gist = await r.json();
    const content = gist.files[GIST_FILE]?.content || '{}';
    res.json(JSON.parse(content));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /db — guarda el JSON (GitHub Gist) ───────────────────────────────────
app.put('/db', auth, async (req, res) => {
  try {
    if (!GITHUB_TOKEN || !GIST_ID)
      return res.status(503).json({ error: 'GITHUB_TOKEN o GIST_ID no configurados en Railway' });
    const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'ticciana-server'
      },
      body: JSON.stringify({
        files: { [GIST_FILE]: { content: JSON.stringify(req.body) } }
      })
    });
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Inicio ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Ticciana MP Server corriendo en puerto ${PORT}`);
  if (!MP_TOKEN)     console.warn('⚠️  MP_ACCESS_TOKEN no configurado — las rutas /mp/* van a fallar');
  if (!API_KEY)      console.warn('⚠️  API_KEY no configurada — el servidor está abierto sin autenticación');
  if (!GITHUB_TOKEN) console.warn('⚠️  GITHUB_TOKEN no configurado — /db va a fallar');
  if (!GIST_ID)      console.warn('⚠️  GIST_ID no configurado — /db va a fallar');
});

const express = require('express');
const webpush  = require('web-push');
const cors     = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ── VAPID Keys ───────────────────────────────────────────────
const VAPID_PUBLIC  = 'BJrxmGfucm9YOfhnAsz43tRvqHDOwQ4Af5enWXnVWUkeoMzxFeMcGlSnvuEJAvdLPYo89N3I9roWqxXHXG3xh6U';
const VAPID_PRIVATE = '225c30n3XeteBxW2RvguVhF8gc8ubJoD70A5XcGvOaA';

webpush.setVapidDetails('mailto:monitor@eth.app', VAPID_PUBLIC, VAPID_PRIVATE);

// ── In-memory store ──────────────────────────────────────────
const subscribers = {};

// ── Routes ───────────────────────────────────────────────────

app.get('/', (req, res) => res.json({
  status: 'ok',
  subscribers: Object.keys(subscribers).length,
  uptime: Math.floor(process.uptime()) + 's'
}));

app.get('/vapid-public-key', (req, res) => res.json({ key: VAPID_PUBLIC }));

app.post('/subscribe', (req, res) => {
  const { subscription, clientId, alerts } = req.body;
  if (!subscription || !clientId) return res.status(400).json({ error: 'Missing fields' });
  subscribers[clientId] = { subscription, alerts: alerts || [] };
  console.log(`[+] Subscribed: ${clientId} | Alerts: ${alerts?.length || 0}`);
  res.json({ ok: true });
});

app.post('/update-alerts', (req, res) => {
  const { clientId, alerts } = req.body;
  if (!subscribers[clientId]) return res.status(404).json({ error: 'Not found' });
  subscribers[clientId].alerts = alerts;
  res.json({ ok: true });
});

app.post('/unsubscribe', (req, res) => {
  const { clientId } = req.body;
  delete subscribers[clientId];
  res.json({ ok: true });
});

// ── Price Monitor ────────────────────────────────────────────
let lastPrice = null;
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

async function fetchETHPrice() {
  try {
    const res  = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=brl');
    const data = await res.json();
    return data?.ethereum?.brl ?? null;
  } catch (e) {
    console.error('Price fetch error:', e.message);
    return null;
  }
}

async function checkAndNotify() {
  const price = await fetchETHPrice();
  if (!price) return;

  const prev = lastPrice;
  lastPrice  = price;
  console.log(`[ETH] R$ ${price.toLocaleString('pt-BR')} ${prev ? `(antes: R$ ${prev.toLocaleString('pt-BR')})` : '(primeiro fetch)'}`);

  for (const [clientId, data] of Object.entries(subscribers)) {
    for (const alert of data.alerts) {
      if (alert.triggered) continue;

      const hit =
        (alert.direction === 'above' && price >= alert.price) ||
        (alert.direction === 'below' && price <= alert.price);

      if (!hit) continue;

      const dirLabel = alert.direction === 'above' ? 'acima de' : 'abaixo de';
      const payload  = JSON.stringify({
        title: `🚨 ETH ${alert.direction === 'above' ? '📈' : '📉'} Alerta atingido!`,
        body:  `Ethereum R$ ${price.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} — ${dirLabel} R$ ${alert.price.toLocaleString('pt-BR')}`,
        price, alertPrice: alert.price, direction: alert.direction, timestamp: Date.now()
      });

      try {
        await webpush.sendNotification(data.subscription, payload);
        alert.triggered = true;
        console.log(`[PUSH] Enviado para ${clientId}: ETH R$ ${price}`);
      } catch (e) {
        console.error(`[PUSH] Falhou para ${clientId}:`, e.message);
        if (e.statusCode === 410) delete subscribers[clientId];
      }
    }
  }
}

// Verifica preço a cada 2 minutos
setInterval(checkAndNotify, 2 * 60 * 1000);
checkAndNotify();

// ── Self-ping para não dormir no Render free ─────────────────
// O Render free dorme após 15 min sem requisição HTTP.
// Este ping bate na própria URL a cada 14 min para manter acordado.
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(async () => {
    try {
      await fetch(RENDER_URL);
      console.log('[PING] Self-ping OK — servidor acordado');
    } catch (e) {
      console.warn('[PING] Self-ping falhou:', e.message);
    }
  }, 14 * 60 * 1000); // a cada 14 minutos
  console.log(`[PING] Self-ping ativado para ${RENDER_URL}`);
} else {
  console.log('[PING] RENDER_EXTERNAL_URL não definida — self-ping desativado');
}

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ETH Monitor backend rodando na porta ${PORT}`));

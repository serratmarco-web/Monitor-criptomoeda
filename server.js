const express = require('express');
const webpush = require('web-push');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ── VAPID Keys ──────────────────────────────────────────────
const VAPID_PUBLIC  = 'BJrxmGfucm9YOfhnAsz43tRvqHDOwQ4Af5enWXnVWUkeoMzxFeMcGlSnvuEJAvdLPYo89N3I9roWqxXHXG3xh6U';
const VAPID_PRIVATE = '225c30n3XeteBxW2RvguVhF8gc8ubJoD70A5XcGvOaA';

webpush.setVapidDetails('mailto:monitor@eth.app', VAPID_PUBLIC, VAPID_PRIVATE);

// ── In-memory store (subscriptions + alerts) ────────────────
// Structure: { id: { subscription, alerts: [{id, price, direction, triggered}] } }
const subscribers = {};

// ── Routes ──────────────────────────────────────────────────

// Health check
app.use(express.static(__dirname));
const path = require('path');

app.get('/debug', (req, res) => {
  const fs = require('fs');
  const files = fs.readdirSync(__dirname);
  res.json({ __dirname, files });
});
app.get('/status', (req, res) => res.json({ status: 'ok', subscribers: Object.keys(subscribers).length }));

// Expose public VAPID key to frontend
app.get('/vapid-public-key', (req, res) => res.json({ key: VAPID_PUBLIC }));

// Register subscription + alerts
app.post('/subscribe', (req, res) => {
  const { subscription, clientId, alerts } = req.body;
  if (!subscription || !clientId) return res.status(400).json({ error: 'Missing fields' });

  subscribers[clientId] = { subscription, alerts: alerts || [] };
  console.log(`[+] Subscribed: ${clientId} | Alerts: ${JSON.stringify(alerts)}`);
  res.json({ ok: true });
});

// Update alerts for existing subscriber
app.post('/update-alerts', (req, res) => {
  const { clientId, alerts } = req.body;
  if (!subscribers[clientId]) return res.status(404).json({ error: 'Not found' });
  subscribers[clientId].alerts = alerts;
  // Reset triggered state for new/changed alerts
  res.json({ ok: true });
});

// Unsubscribe
app.post('/unsubscribe', (req, res) => {
  const { clientId } = req.body;
  delete subscribers[clientId];
  res.json({ ok: true });
});

// ── Price Monitor ────────────────────────────────────────────
let lastPrice = null;

async function fetchETHPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=brl');
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
  lastPrice = price;
  console.log(`[ETH] R$ ${price.toLocaleString('pt-BR')} ${prev ? `(antes: R$ ${prev.toLocaleString('pt-BR')})` : '(primeiro fetch)'}`);

  for (const [clientId, data] of Object.entries(subscribers)) {
    for (const alert of data.alerts) {
      if (alert.triggered) continue;

      const hit =
        (alert.direction === 'above' && price >= alert.price) ||
        (alert.direction === 'below' && price <= alert.price);

      if (hit) {
        const dirLabel = alert.direction === 'above' ? 'acima de' : 'abaixo de';
        const payload = JSON.stringify({
          title: `🚨 ETH ${alert.direction === 'above' ? '📈' : '📉'} Alerta atingido!`,
          body: `Ethereum está R$ ${price.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} — ${dirLabel} R$ ${alert.price.toLocaleString('pt-BR')}`,
          price,
          alertPrice: alert.price,
          direction: alert.direction,
          timestamp: Date.now()
        });

        try {
          await webpush.sendNotification(data.subscription, payload);
          alert.triggered = true;
          console.log(`[PUSH] Sent to ${clientId}: ETH R$ ${price}`);
        } catch (e) {
          console.error(`[PUSH] Failed for ${clientId}:`, e.message);
          if (e.statusCode === 410) {
            // Subscription expired
            delete subscribers[clientId];
          }
        }
      }
    }
  }
}

// Check every 2 minutes
setInterval(checkAndNotify, 2 * 60 * 1000);
checkAndNotify(); // Run immediately on start

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ETH Monitor backend running on port ${PORT}`));

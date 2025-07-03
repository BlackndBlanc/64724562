'use strict';

const express = require('express');
const { Client, LocalAuth, MessageMedia, Buttons } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fetch = require('node-fetch');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

/* ───── إعداد WhatsApp ───── */
let latestQR = null;
let idleTimer = null;
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes idle timeout

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

client.on('qr', qr => {
  qrcode.toDataURL(qr, (err, url) => {
    if (err) return console.error('QR gen error:', err);
    latestQR = url;
    console.log('QR-TEXT:', qr);
  });
});

client.on('ready', () => {
  console.log('✅ WhatsApp Client ready');
  startIdleTimer();
});

client.initialize();


/* ───── Webhook لرسائل الواتساب ───── */
const TEST_WEBHOOK_URL = process.env.TEST_WEBHOOK_URL;
const PROD_WEBHOOK_URL = process.env.PROD_WEBHOOK_URL;

client.on('message', async (msg) => {
  // Update activity and reset timer on new message
  updateActivity();

  // تجاهل الرسائل الغير مهمة
  if (
    msg.from === 'status@broadcast' ||        // الحالة
    msg.from.endsWith('@g.us') ||             // المجموعات
    !msg.body || msg.body.trim() === ''       // الرسائل الفارغة
  ) {
    return;
  }

  console.log('📩 Received:', msg.body);

  const payload = {
    from: msg.from,
    body: msg.body,
    timestamp: msg.timestamp,
    type: msg.type,
    id: msg.id.id,
    fromMe: msg.fromMe
  };

  const urls = [TEST_WEBHOOK_URL, PROD_WEBHOOK_URL].filter(Boolean);
  for (const url of urls) {
    try {
      await axios.post(url, payload);
      console.log('✅ Webhook sent to:', url);
    } catch (err) {
      console.error('❌ Webhook failed for', url, ':', err.message);
    }
  }
});

/* ───── QR Display ───── */
app.get('/qr', (_req, res) => {
  if (!latestQR) return res.send('<h3>🔄 QR Code is not ready yet…</h3>');
  res.send(`
    <html><body style="text-align:center;margin-top:40px">
      <h2>📲 Scan this QR Code</h2>
      <img src="${latestQR}" width="300"/>
    </body></html>
  `);
});

/* ───── Text Message ───── */
app.post('/api/send-text', async (req, res) => {
  // Update activity and reset timer on outgoing message
  updateActivity();

  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).send('phone / message?');

  try {
    await client.sendMessage(`${phone}@c.us`, message);
    res.send('Text sent');
  } catch (e) {
    console.error(e);
    res.status(500).send('Failed');
  }
});

/* ───── Image from URL ───── */
app.post('/api/send-image-url', async (req, res) => {
  // Update activity and reset timer on outgoing message
  updateActivity();

  const { phone, imageUrl, caption = '' } = req.body;
  if (!phone || !imageUrl) return res.status(400).send('phone / imageUrl?');

  try {
    const resp = await fetch(imageUrl);
    const buffer = await resp.buffer();
    const media = new MessageMedia('image/jpeg', buffer.toString('base64'), 'img.jpg');
    await client.sendMessage(`${phone}@c.us`, media, { caption });
    res.send('Image sent');
  } catch (e) {
    console.error(e);
    res.status(500).send('Failed');
  }
});

/* ───── List Message ───── */
app.post('/api/send-list', async (req, res) => {
  // Update activity and reset timer on outgoing message
  updateActivity();

  const { phone, sections, description = 'اختر من القائمة', buttonText = 'اختر' } = req.body;
  if (!phone || !Array.isArray(sections)) return res.status(400).send('phone / sections?');

  try {
    await client.sendMessage(`${phone}@c.us`, {
      buttonText,
      description,
      sections,
      listType: 1
    });
    res.send('List sent');
  } catch (e) {
    console.error(e);
    res.status(500).send('Failed');
  }
});

/* ───── Reply Buttons ───── */
app.post('/api/send-reply-buttons', async (req, res) => {
  // Update activity and reset timer on outgoing message
  updateActivity();

  const { phone, text, buttons } = req.body;
  if (!phone || !text || !Array.isArray(buttons)) return res.status(400).send('payload?');

  const templateButtons = buttons.slice(0, 3).map((b, i) => ({
    index: i + 1,
    quickReplyButton: { id: b.id, displayText: b.displayText }
  }));

  try {
    await client.sendMessage(`${phone}@c.us`, { text, templateButtons });
    res.send('Reply buttons sent');
  } catch (e) {
    console.error(e);
    res.status(500).send('Failed');
  }
});

/* ───── Old-style Buttons ───── */
app.post('/api/send-buttons', async (req, res) => {
  // Update activity and reset timer on outgoing message
  updateActivity();

  const { phone, message, buttons, title = '', footer = '' } = req.body;
  if (!phone || !message || !Array.isArray(buttons)) return res.status(400).send('bad payload');

  try {
    const oldBtns = new Buttons(message, buttons, title, footer);
    await client.sendMessage(`${phone}@c.us`, oldBtns);
    res.send('Legacy buttons sent');
  } catch (e) {
    console.error(e);
    res.status(500).send('Failed');
  }
});

/* ───── Media (PDF / Audio / Image) ───── */
app.post('/api/send-media-url', async (req, res) => {
  // Update activity and reset timer on outgoing message
  updateActivity();

  const { phone, mediaUrl, mimeType, fileName, caption } = req.body;
  if (!phone || !mediaUrl || !mimeType || !fileName) {
    return res.status(400).send('Missing phone, mediaUrl, mimeType, or fileName');
  }

  try {
    const response = await fetch(mediaUrl);
    const buffer = await response.buffer();
    const media = new MessageMedia(mimeType, buffer.toString('base64'), fileName);
    await client.sendMessage(`${phone}@c.us`, media, { caption });
    res.status(200).send('Media sent');
  } catch (err) {
    console.error('❌ Error sending media:', err);
    res.status(500).send('Failed to send media');
  }
});

/* ───── Health Check ───── */
app.get('/status', (_req, res) =>
  res.status(client.info ? 200 : 503).send(client.info ? 'Ready' : 'Not ready')
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀  http://localhost:${PORT}`));

// Webhook endpoint to trigger WhatsApp client initialization if not ready
const RAILWAY_WEBHOOK_URL = process.env.WEBHOOK_URL || '/webhook'; // Default to /webhook if not set
app.post(RAILWAY_WEBHOOK_URL, async (req, res) => {
  console.log('Webhook received.');
  // Update activity and reset timer on incoming webhook
  updateActivity();

  if (!client.info) {
    console.log('WhatsApp client not ready, initializing...');
    try {
      await client.initialize();
      console.log('WhatsApp client initialized by webhook.');
      res.status(200).send('WhatsApp client initialization triggered by webhook.');
    } catch (error) {
      console.error('Error initializing WhatsApp client from webhook:', error);
      res.status(500).send('Failed to initialize WhatsApp client from webhook.');
    }
  } else {
    console.log('WhatsApp client already ready.');
    res.status(200).send('WhatsApp client already ready.');
  }
});


// Function to update activity timestamp and reset idle timer
function updateActivity() {
  lastActivity = Date.now();
  resetIdleTimer();
}

// Function to start the idle timer
function startIdleTimer() {
  idleTimer = setTimeout(goToMinimalState, IDLE_TIMEOUT);
}

// Function to reset the idle timer
function resetIdleTimer() {
  clearTimeout(idleTimer);
  startIdleTimer();
}

// Function to transition to minimal state (destroy client)
function goToMinimalState() {
  console.log('Idle timeout reached, transitioning to minimal state...');
  if (client && client.info) {
    client.destroy().then(() => {
      console.log('WhatsApp client destroyed.');
    }).catch(error => {
      console.error('Error destroying WhatsApp client:', error);
    });
  }
}

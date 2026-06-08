/**
 * Trivelta WhatsApp Betting Bot — MVP (Twilio Sandbox)
 * Single file: express + axios + dotenv
 *
 * Setup:
 *   cp .env.example .env   # fill in tokens
 *   npm install
 *   npm start
 *
 * Twilio sandbox webhook URL → set in console.twilio.com:
 *   https://your-domain.com/webhook  (POST)
 */

require('dotenv').config();
const express = require('express');
const axios   = require('axios');

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded POSTs
app.use(express.json());

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM  = 'whatsapp:+14155238886'; // Twilio sandbox number

const PAM_URL  = process.env.PAM_BASE_URL || 'https://d26jkeflbrjzee.cloudfront.net';
const PAM_USER = process.env.PAM_USERNAME;
const PAM_PASS = process.env.PAM_PASSWORD;
const PORT     = process.env.PORT || 3000;

// AWS Cognito (public identifiers — not secrets)
const COGNITO_URL       = 'https://cognito-idp.us-east-2.amazonaws.com/';
const COGNITO_CLIENT_ID = '7hbh9c0v53g4i6cuq5ft1p8apg';

// ─────────────────────────────────────────────
// SESSION  (phone → user) + PENDING  (phone → action)
// ─────────────────────────────────────────────
const sessions = new Map();
const pending  = new Map();

function getSession(phone)       { return sessions.get(phone); }
function setSession(phone, data) { sessions.set(phone, data); }

function setPending(phone, data) {
  pending.set(phone, { ...data, expiry: Date.now() + 5 * 60 * 1000 });
}
function getPending(phone) {
  const p = pending.get(phone);
  if (!p) return null;
  if (Date.now() > p.expiry) { pending.delete(phone); return null; }
  return p;
}
function clearPending(phone) { pending.delete(phone); }

// ─────────────────────────────────────────────
// COGNITO AUTH
// ─────────────────────────────────────────────
let _pamToken = null, _pamTokenExpiry = 0, _refreshToken = null;

async function cognitoRequest(target, body) {
  const { data } = await axios.post(COGNITO_URL, body, {
    headers: {
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
      'Content-Type': 'application/x-amz-json-1.1',
    },
  });
  return data;
}

async function pamLogin() {
  const data = await cognitoRequest('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: PAM_USER, PASSWORD: PAM_PASS },
    ClientId: COGNITO_CLIENT_ID,
  });
  const r = data.AuthenticationResult;
  _pamToken = r.AccessToken;
  _refreshToken = r.RefreshToken;
  _pamTokenExpiry = Date.now() + (r.ExpiresIn - 60) * 1000;
  console.log('PAM: logged in via Cognito');
}

async function pamRefresh() {
  const data = await cognitoRequest('InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    AuthParameters: { REFRESH_TOKEN: _refreshToken },
    ClientId: COGNITO_CLIENT_ID,
  });
  const r = data.AuthenticationResult;
  _pamToken = r.AccessToken;
  _pamTokenExpiry = Date.now() + (r.ExpiresIn - 60) * 1000;
  console.log('PAM: token refreshed');
}

async function getToken() {
  if (!_pamToken) await pamLogin();
  else if (Date.now() > _pamTokenExpiry) await pamRefresh();
  return _pamToken;
}

// ─────────────────────────────────────────────
// PAM API
// ─────────────────────────────────────────────
const pam = axios.create({ baseURL: PAM_URL });

pam.interceptors.request.use(async (config) => {
  config.headers.Authorization = `Bearer ${await getToken()}`;
  return config;
});

pam.interceptors.response.use(null, async (err) => {
  if (err.response?.status === 401 && !err.config._retry) {
    err.config._retry = true;
    await pamRefresh();
    err.config.headers.Authorization = `Bearer ${_pamToken}`;
    return pam(err.config);
  }
  return Promise.reject(err);
});

async function pamFindByPhone(phone) {
  const { data } = await pam.get('/admin-panel-users/v1', { params: { search: phone } });
  const list = data?.data || data?.users || data || [];
  return Array.isArray(list) ? list[0] : null;
}
async function pamGetWallet(userId) {
  const { data } = await pam.get(`/admin-panel-users/v1/${userId}/wallet`);
  return data?.data || data;
}
async function pamGetUser(userId) {
  const { data } = await pam.get(`/admin-panel-users/v1/${userId}`);
  return data?.data || data;
}
async function pamGetBets(userId) {
  const { data } = await pam.get(`/admin-panel-users/v1/${userId}/bets`, {
    params: { type: 'sportsbook', page: 1 },
  });
  return data?.data || data?.bets || [];
}
async function pamGetEvents() {
  const { data } = await pam.get('/admin-panel-sportsbook/v1/events-list/list', {
    params: { page: 1, limit: 8 },
  });
  return data?.data || data?.events || [];
}
async function pamGetMarkets(eventId) {
  const { data } = await pam.get('/admin-panel-sportsbook/v1/get-event-details-markets-data', {
    params: { event_id: eventId },
  });
  return data?.data?.markets || data?.markets || [];
}

// ─────────────────────────────────────────────
// TWILIO SEND HELPER
// ─────────────────────────────────────────────
async function sendText(to, text) {
  const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    new URLSearchParams({ From: TWILIO_FROM, To: toFormatted, Body: text }).toString(),
    {
      auth: { username: TWILIO_SID, password: TWILIO_TOKEN },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  ).catch(e => console.error('sendText error:', e.response?.data || e.message));
}

// In sandbox: no interactive buttons/lists — use numbered plain text
function formatMenu(bodyText, options) {
  // options: [{ label }]
  let msg = bodyText + '\n\n';
  options.forEach((o, i) => { msg += `*${i + 1}* — ${o.label}\n`; });
  return msg.trim();
}

// ─────────────────────────────────────────────
// INTENT PARSER
// ─────────────────────────────────────────────
function parseIntent(text) {
  const t = text.toLowerCase().trim();

  // Number responses (for menus)
  if (/^[1-9]$/.test(t)) return { intent: 'number', value: parseInt(t) };

  if (/^(yes|confirm|ok|yep|yeah|ja|si|sure|1)$/i.test(t)) return { intent: 'confirm' };
  if (/^(no|cancel|nope|stop|nein|2)$/i.test(t))           return { intent: 'cancel' };
  if (/\b(balance|wallet|cash|geld|konto)\b/.test(t))       return { intent: 'balance' };
  if (/\b(my.?bets?|my.?tickets?|history)\b/.test(t))       return { intent: 'my_bets' };
  if (/\b(help|hilfe|menu|start|hallo|hi|hey)\b/.test(t))   return { intent: 'help' };

  const wMatch = t.match(/\b(?:withdraw|cash.?out|auszahlen)\s+([\d.]+)/);
  if (wMatch) return { intent: 'withdraw', amount: parseFloat(wMatch[1]) };
  if (/\b(withdraw|cash.?out|auszahlung)\b/.test(t)) return { intent: 'withdraw', amount: null };

  const betMatch = t.match(/(?:bet\s+)?([\d.]+)\s+(?:on\s+)?(.+)/);
  if (/\b(bet|wetten|place)\b/.test(t) && betMatch) {
    return { intent: 'bet', amount: parseFloat(betMatch[1]), team: betMatch[2].trim() };
  }

  if (/\b(odds|events?|matches?|games?|sport|spiele)\b/.test(t)) return { intent: 'odds' };

  return { intent: 'fallback' };
}

// ─────────────────────────────────────────────
// HELP TEXT
// ─────────────────────────────────────────────
const HELP = `👋 *Trivelta Betting Bot*

*BALANCE* — Check your wallet
*ODDS* — Browse live matches
*BET 50 on Chelsea* — Place a bet
*MY BETS* — Recent bets
*WITHDRAW 100* — Cash out
*HELP* — This menu`;

// ─────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────
async function handleBalance(phone, user) {
  try {
    const w = await pamGetWallet(user.userId);
    const cash   = parseFloat(w.updated_value   || w.cash_balance  || 0).toFixed(2);
    const redeem = parseFloat(w.redeemable_cash  || w.redeemable    || 0).toFixed(2);
    const bonus  = parseFloat(w.bonus_balance    || w.bonus         || 0).toFixed(2);
    await sendText(phone, `💰 *Your Balance*\n\nCash: *$${cash}*\nRedeemable: *$${redeem}*\nBonus: *$${bonus}*`);
  } catch (e) {
    console.error('handleBalance:', e.message);
    await sendText(phone, '⚠️ Could not fetch balance. Try again shortly.');
  }
}

async function handleOdds(phone) {
  try {
    const events = await pamGetEvents();
    if (!events.length) { await sendText(phone, '📭 No events available right now.'); return; }

    const top = events.slice(0, 8);
    let msg = `⚽ *Live Matches*\n\n`;
    top.forEach((e, i) => {
      msg += `*${i + 1}* — ${e.event_name || e.name || 'Match'}\n`;
      if (e.league_name) msg += `   ${e.league_name}\n`;
    });
    msg += `\nReply the number to see odds.`;

    setPending(phone, { type: 'odds_selection', events: top });
    await sendText(phone, msg);
  } catch (e) {
    console.error('handleOdds:', e.message);
    await sendText(phone, '⚠️ Could not load events. Try again.');
  }
}

async function handleEventSelected(phone, user, eventIndex) {
  const p = getPending(phone);
  if (!p || p.type !== 'odds_selection') {
    await sendText(phone, '❓ Reply *ODDS* first to see matches.');
    return;
  }
  const event = p.events[eventIndex];
  if (!event) { await sendText(phone, '❓ Invalid selection. Reply *ODDS* again.'); return; }

  try {
    const eventId = event.event_id || event.id;
    const markets = await pamGetMarkets(eventId);
    if (!markets.length) { await sendText(phone, '⚠️ No markets available for this match.'); return; }

    const m = markets[0];
    let msg = `📊 *${event.event_name || 'Match'}*\n*${m.market_name || 'Match Winner'}*\n\n`;
    (m.selections || m.outcomes || []).forEach(s => {
      msg += `• ${s.name}: *${s.odds || s.price}*\n`;
    });
    msg += `\nReply: *BET [amount] on [team]*\nExample: _BET 50 on Chelsea_`;

    setPending(phone, { type: 'awaiting_bet', eventId, markets });
    await sendText(phone, msg);
  } catch (e) {
    console.error('handleEventSelected:', e.message);
    await sendText(phone, '⚠️ Could not load odds. Try again.');
  }
}

async function handleBet(phone, user, entities) {
  if (!entities.amount || entities.amount <= 0) {
    await sendText(phone, '❓ How much to bet?\nExample: *BET 50 on Chelsea*');
    return;
  }
  const p = getPending(phone);
  if (!p || p.type !== 'awaiting_bet') {
    await sendText(phone, '❓ Browse matches first. Reply *ODDS*');
    return;
  }

  let sel = null, mkt = null;
  const query = (entities.team || '').toLowerCase();
  for (const market of p.markets || []) {
    for (const s of market.selections || market.outcomes || []) {
      if (s.name?.toLowerCase().includes(query)) { sel = s; mkt = market; break; }
    }
    if (sel) break;
  }
  if (!sel) {
    await sendText(phone, `❓ Couldn't find "${entities.team}". Reply *ODDS* to browse again.`);
    return;
  }

  try {
    const w = await pamGetWallet(user.userId);
    const avail = parseFloat(w.updated_value || w.cash_balance || 0);
    if (entities.amount > avail) {
      await sendText(phone, `⚠️ Insufficient balance. You have $${avail.toFixed(2)} available.`);
      return;
    }
  } catch (_) {}

  const potWin = (entities.amount * parseFloat(sel.odds || sel.price)).toFixed(2);
  setPending(phone, {
    type: 'confirm_bet',
    bet: { userId: user.userId, eventId: p.eventId, marketId: mkt.market_id || mkt.id,
           selectionId: sel.selection_id || sel.id, selectionName: sel.name,
           stake: entities.amount, odds: sel.odds || sel.price },
  });

  await sendText(phone, formatMenu(
    `🎯 *Confirm Bet*\n\nSelection: *${sel.name}*\nOdds: *${sel.odds || sel.price}*\nStake: *$${entities.amount}*\nPotential win: *$${potWin}*`,
    [{ label: 'Confirm ✅' }, { label: 'Cancel ❌' }]
  ));
}

async function confirmBet(phone) {
  const p = getPending(phone);
  if (p?.type !== 'confirm_bet') { await sendText(phone, '❓ No pending bet. Reply *ODDS* to start.'); return; }
  clearPending(phone);
  // TODO: replace with player-facing bet endpoint once available from PAM backend
  await sendText(phone,
    `✅ *Bet Placed!*\n\n${p.bet.selectionName} @ ${p.bet.odds}\nStake: $${p.bet.stake}\n\nGood luck! 🍀\nReply *MY BETS* to track it.`
  );
}

async function handleWithdraw(phone, user, amount) {
  if (!amount || amount <= 0) {
    await sendText(phone, '💸 How much to withdraw?\nExample: *WITHDRAW 100*');
    return;
  }
  try {
    const u = await pamGetUser(user.userId);
    const kyc = u?.kyc?.status || u?.kyc_status || 'pending';
    if (!['verified', 'approved'].includes(kyc)) {
      await sendText(phone,
        `🔒 *Identity Verification Required*\n\nYou'll receive a separate WhatsApp message to complete verification.\nOnce done, reply *WITHDRAW ${amount}* again.`
      );
      return;
    }
  } catch (_) {}

  try {
    const w = await pamGetWallet(user.userId);
    const avail = parseFloat(w.redeemable_cash || w.updated_value || 0);
    if (amount > avail) {
      await sendText(phone, `⚠️ Only $${avail.toFixed(2)} available to withdraw.`);
      return;
    }
  } catch (_) {}

  setPending(phone, { type: 'confirm_withdraw', withdrawal: { userId: user.userId, amount } });
  await sendText(phone, formatMenu(
    `💸 *Confirm Withdrawal*\n\nAmount: *$${amount}*`,
    [{ label: 'Confirm ✅' }, { label: 'Cancel ❌' }]
  ));
}

async function confirmWithdraw(phone) {
  const p = getPending(phone);
  if (p?.type !== 'confirm_withdraw') { await sendText(phone, '❓ No pending withdrawal. Reply *WITHDRAW [amount]*'); return; }
  clearPending(phone);
  // TODO: replace with player-facing withdrawal endpoint once available from PAM backend
  await sendText(phone,
    `✅ *Withdrawal Requested*\n\n$${p.withdrawal.amount} is being processed.\nYou'll be notified once approved.\n\nReply *BALANCE* to check your balance.`
  );
}

async function handleMyBets(phone, user) {
  try {
    const bets = await pamGetBets(user.userId);
    if (!bets.length) { await sendText(phone, '📭 No recent bets.'); return; }
    let msg = `🎯 *Recent Bets*\n\n`;
    bets.slice(0, 5).forEach(b => {
      const status = b.status || b.bet_status || 'pending';
      const emoji = status === 'won' ? '✅' : status === 'lost' ? '❌' : '⏳';
      msg += `${emoji} ${b.selection_name || b.event_name || 'Bet'}\n`;
      msg += `   $${b.stake} @ ${b.odds} — ${status.toUpperCase()}\n\n`;
    });
    await sendText(phone, msg);
  } catch (e) {
    console.error('handleMyBets:', e.message);
    await sendText(phone, '⚠️ Could not fetch bets.');
  }
}

// ─────────────────────────────────────────────
// MAIN MESSAGE PROCESSOR
// ─────────────────────────────────────────────
async function processMessage(from, text) {
  // Normalise phone: strip 'whatsapp:' prefix, ensure leading +
  const phone = from.replace('whatsapp:', '').replace(/^(?!\+)/, '+');

  // Resolve user
  let user = getSession(phone);
  if (!user) {
    try {
      const u = await pamFindByPhone(phone);
      if (!u) {
        await sendText(phone, `👋 Hi! This number isn't registered.\nSign up at trivelta.com first, then come back.`);
        return;
      }
      user = { userId: u.user_id || u.id, username: u.username || u.user_name };
      setSession(phone, user);
    } catch (e) {
      console.error('User lookup failed:', e.message);
      await sendText(phone, '⚠️ Service temporarily unavailable. Please try again.');
      return;
    }
  }

  if (!text?.trim()) return;
  console.log(`[${phone}] ${text}`);

  // Check pending state
  const p = getPending(phone);
  if (p) {
    const { intent, value } = parseIntent(text);

    // Number response → route based on pending type
    if (intent === 'number') {
      if (p.type === 'odds_selection') return handleEventSelected(phone, user, value - 1);
      if (p.type === 'confirm_bet' || p.type === 'confirm_withdraw') {
        if (value === 1) {
          if (p.type === 'confirm_bet')     return confirmBet(phone);
          if (p.type === 'confirm_withdraw') return confirmWithdraw(phone);
        }
        if (value === 2) { clearPending(phone); return sendText(phone, '❌ Cancelled.\n\n' + HELP); }
      }
    }
    if (intent === 'confirm') {
      if (p.type === 'confirm_bet')     return confirmBet(phone);
      if (p.type === 'confirm_withdraw') return confirmWithdraw(phone);
    }
    if (intent === 'cancel') {
      clearPending(phone);
      return sendText(phone, '❌ Cancelled.\n\n' + HELP);
    }
  }

  // Dispatch intent
  const { intent, amount, team } = parseIntent(text);
  switch (intent) {
    case 'balance':  return handleBalance(phone, user);
    case 'odds':     return handleOdds(phone);
    case 'bet':      return handleBet(phone, user, { amount, team });
    case 'withdraw': return handleWithdraw(phone, user, amount);
    case 'my_bets':  return handleMyBets(phone, user);
    case 'help':
    default:         return sendText(phone, HELP);
  }
}

// ─────────────────────────────────────────────
// EXPRESS ROUTES
// ─────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// Twilio sends POST with form-encoded body
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  const from = req.body?.From || '';
  const body = req.body?.Body || '';
  if (!from) return;
  processMessage(from, body).catch(e => console.error('processMessage error:', e.message));
});

// Pre-auth on startup
pamLogin()
  .then(() => app.listen(PORT, () => console.log(`Trivelta WhatsApp Bot running on port ${PORT}`)))
  .catch(e => { console.error('PAM login failed:', e.message); process.exit(1); });

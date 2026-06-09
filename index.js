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
// PAM AUTH  (direct sign-in endpoint)
// ─────────────────────────────────────────────
let _pamToken = null, _pamTokenExpiry = 0;

async function pamLogin() {
  const { data } = await axios.post(
    `${PAM_URL}/admin-panel-auth/v1/sign-in`,
    { user_name: PAM_USER, password: PAM_PASS },
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (!data?.data?.AccessToken) throw new Error('No AccessToken in sign-in response');
  _pamToken      = data.data.AccessToken;
  _pamTokenExpiry = Date.now() + (3600 - 60) * 1000; // 1h - 60s buffer
  console.log('PAM: logged in via admin-panel-auth');
}

async function getToken() {
  if (!_pamToken || Date.now() > _pamTokenExpiry) await pamLogin();
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
    await pamLogin(); // re-login on 401
    err.config.headers.Authorization = `Bearer ${_pamToken}`;
    return pam(err.config);
  }
  return Promise.reject(err);
});

async function pamFindByUsername(username) {
  const { data } = await pam.get('/admin-panel-users/v1', {
    params: { page: 1, page_size: 5, username },
  });
  const list = data?.data || data?.users || data?.items || [];
  if (Array.isArray(list) && list.length > 0) return list[0];
  // Some PAMs return the object directly keyed by data
  if (list && !Array.isArray(list) && list.user_id) return list;
  return null;
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
  // Required discriminator: event_type=match
  // Date range: today (expand window to catch upcoming + live events)
  const today = new Date();
  const yyyy  = today.getUTCFullYear();
  const mm    = String(today.getUTCMonth() + 1).padStart(2, '0');
  const dd    = String(today.getUTCDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;
  // PAM uses same date for both start and end — returns all events for the day
  const tomorrowStr = dateStr;

  try {
    const { data } = await pam.get('/admin-panel-sportsbook/v1/events-list/list', {
      params: {
        event_type: 'match',
        start_date: dateStr,
        end_date:   tomorrowStr,
        page:       1,
        page_size:  20,
      },
    });
    // Response: { success, message, data: { events: [...] } }
    const list = data?.data?.events || data?.data || data?.events || data?.items || [];
    console.log(`pamGetEvents: got ${Array.isArray(list) ? list.length : 0} events`);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.error('pamGetEvents:', e.response?.status, JSON.stringify(e.response?.data)?.slice(0, 200));
    return [];
  }
}
async function pamGetMarkets(eventId) {
  // POST with body (GET returns 403 IAM error)
  const { data } = await pam.post(
    '/admin-panel-sportsbook/v1/get-event-details-markets-data',
    { event_id: eventId }
  );
  // Response: { success, message, data: { markets: [{market_name, selection_name, odds}], available_markets: [] } }
  const flat = data?.data?.available_markets?.length
    ? data.data.available_markets
    : data?.data?.markets || data?.markets || [];
  // Group by market_name → [{market_name, selections:[{name, odds}]}]
  const grouped = {};
  for (const m of flat) {
    const key = m.market_name || 'Match Winner';
    if (!grouped[key]) grouped[key] = { market_name: key, market_id: key, selections: [] };
    grouped[key].selections.push({ name: m.selection_name, odds: m.odds });
  }
  return Object.values(grouped);
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

  const linkMatch = t.match(/^link\s+(\S+)/i) || text.trim().match(/^link\s+(\S+)/i);
  if (linkMatch) return { intent: 'link', username: linkMatch[1] };

  return { intent: 'fallback' };
}

// ─────────────────────────────────────────────
// HELP TEXT
// ─────────────────────────────────────────────
const HELP = `👋 *Trivelta Betting Bot*

*ODDS* — Browse today's matches
*BET 50 on [name]* — Place a bet
*BALANCE* — Check your wallet
*MY BETS* — Recent bet history
*WITHDRAW 100* — Request cashout
*LINK username* — Connect your account
*HELP* — This menu`;

const LINK_PROMPT = `🔗 *Link your Trivelta account*\n\nReply: *LINK yourUsername*\nExample: _LINK john_doe_\n\nDon't have an account? Sign up at trivelta.com`;

// ─────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────
function resolveUser(phone) {
  const cached = getSession(phone);
  return (cached?.userId) ? cached : null;
}

async function handleLink(phone, username) {
  if (!username) { await sendText(phone, LINK_PROMPT); return; }
  try {
    const u = await pamFindByUsername(username.trim());
    if (!u) {
      await sendText(phone, `❌ Username *${username}* not found.\n\nCheck the spelling and try again, or visit trivelta.com to register.`);
      return;
    }
    const userId = u.user_id || u.id || u.userId;
    const uname  = u.username || u.user_name || username;
    setSession(phone, { userId, username: uname });
    console.log(`Linked ${phone} → userId=${userId} username=${uname}`);
    await sendText(phone, `✅ *Account linked!*\n\nWelcome, *${uname}* 🎉\n\nYou can now use BALANCE, MY BETS, and WITHDRAW.\n\nReply *HELP* to see all commands.`);
  } catch (e) {
    console.error('handleLink error:', e.message, e.response?.status, JSON.stringify(e.response?.data)?.slice(0,200));
    await sendText(phone, '⚠️ Could not link account. Try again shortly.');
  }
}

async function handleBalance(phone) {
  const resolved = resolveUser(phone);
  if (!resolved) { await sendText(phone, LINK_PROMPT); return; }
  try {
    const w = await pamGetWallet(resolved.userId);
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
      const statusEmoji = e.status === 'Live' ? '🔴' : '📅';
      msg += `*${i + 1}* ${statusEmoji} ${e.name || e.event_name || 'Match'}\n`;
      if (e.league || e.league_name) msg += `   ${e.league || e.league_name}\n`;
    });
    msg += `\nReply the number to see odds.`;

    setPending(phone, { type: 'odds_selection', events: top });
    await sendText(phone, msg);
  } catch (e) {
    console.error('handleOdds:', e.message, JSON.stringify(e.response?.data)?.slice(0, 300));
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
    const eventId = event.id || event.event_id;
    const markets = await pamGetMarkets(eventId);
    if (!markets.length) { await sendText(phone, '⚠️ No markets available for this match.'); return; }

    const m = markets[0];
    let msg = `📊 *${event.name || event.event_name || 'Match'}*\n*${m.market_name || 'Match Winner'}*\n\n`;
    (m.selections || []).forEach(s => {
      msg += `• ${s.name}: *${s.odds}*\n`;
    });
    if (!m.selections?.length) {
      msg += `_(Odds not yet available for this match)_\n`;
    }
    msg += `\nReply: *BET [amount] on [name]*\nExample: _BET 50 on ${m.selections?.[0]?.name?.split(' ')[0] || 'Player'}_`;

    setPending(phone, { type: 'awaiting_bet', eventId, markets });
    await sendText(phone, msg);
  } catch (e) {
    console.error('handleEventSelected:', e.message);
    await sendText(phone, '⚠️ Could not load odds. Try again.');
  }
}

async function handleBet(phone, user, entities) {
  if (!user) { await sendText(phone, LINK_PROMPT); return; }
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
    for (const s of market.selections || []) {
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

  const potWin = (entities.amount * parseFloat(sel.odds)).toFixed(2);
  setPending(phone, {
    type: 'confirm_bet',
    bet: { userId: user.userId, eventId: p.eventId, marketId: mkt.market_id || mkt.id,
           selectionId: sel.selection_id || sel.id, selectionName: sel.name,
           stake: entities.amount, odds: sel.odds },
  });

  await sendText(phone, formatMenu(
    `🎯 *Confirm Bet*\n\nSelection: *${sel.name}*\nOdds: *${sel.odds}*\nStake: *$${entities.amount}*\nPotential win: *$${potWin}*`,
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

async function handleWithdraw(phone, _user, amount) {
  const user = resolveUser(phone);
  if (!user) { await sendText(phone, LINK_PROMPT); return; }
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

async function handleMyBets(phone) {
  const user = resolveUser(phone);
  if (!user) { await sendText(phone, LINK_PROMPT); return; }
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

  // Resolve user (lazy — only required for account actions)
  let user = getSession(phone) || { userId: null, username: null, phone };

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
  const { intent, amount, team, username } = parseIntent(text);
  switch (intent) {
    case 'link':     return handleLink(phone, username);
    case 'balance':  return handleBalance(phone);
    case 'odds':     return handleOdds(phone);
    case 'bet':      return handleBet(phone, resolveUser(phone), { amount, team });
    case 'withdraw': return handleWithdraw(phone, null, amount);
    case 'my_bets':  return handleMyBets(phone);
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
  console.log('Webhook POST received:', JSON.stringify(req.body));
  res.sendStatus(200);
  const from = req.body?.From || '';
  const body = req.body?.Body || '';
  if (!from) return;
  processMessage(from, body).catch(e => console.error('processMessage error:', e.message));
});

// Some Twilio probes use GET
app.get('/webhook', (_req, res) => res.sendStatus(200));

// Pre-auth on startup
pamLogin()
  .then(() => app.listen(PORT, () => console.log(`Trivelta WhatsApp Bot running on port ${PORT}`)))
  .catch(e => {
    console.error('PAM login failed:', e.message);
    console.error('Response:', JSON.stringify(e.response?.data));
    process.exit(1);
  });

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const TOKEN_FILE = path.join(__dirname, 'tokens.json');
const CACHE_FILE = path.join(__dirname, 'scan_cache.json');
const PORT = process.env.PORT || 3001;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

function loadTokensSafe() {
  try {
    if (fs.existsSync(TOKEN_FILE)) return JSON.parse(fs.readFileSync(TOKEN_FILE));
    if (process.env.GMAIL_TOKENS) return JSON.parse(process.env.GMAIL_TOKENS);
  } catch(e) {}
  return null;
}
function loadTokens() {
  const t = loadTokensSafe();
  if (t) { oauth2Client.setCredentials(t); return true; }
  return false;
}
function saveTokens(tokens) {
  const merged = { ...loadTokensSafe(), ...tokens };
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(merged)); } catch(e) {}
  return merged;
}
function loadCache() {
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE)); } catch(e) {}
  return null;
}
function saveCache(data) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data)); } catch(e) {}
}

loadTokens();
oauth2Client.on('tokens', t => oauth2Client.setCredentials(saveTokens(t)));

// ── HELPERS ──────────────────────────────────────────────────────────
const SKIP = [
  // Internal / system
  'noreply','no-reply','donotreply','mailer-daemon',
  'kdooli12@gmail','nhyoung5150@gmail','karla@nsmn','nathan@nsmn',
  // Mortgage tech / LOS systems
  'service@my220','loans@arive','noreply-mortgage','neptunewholesale',
  'newrez','dcrlaw','homegauge','ice.com','myhomeiq.report','zendesk',
  'listreports','dartappraisal','mortgagetech','arive.com','leaf360',
  'lendware','aidium','whiteboard','my1003app','encompass',
  // VoIP / SMS platforms
  'ringcentral','quo.com','openphone','salesmsg','heymarket','podium',
  'notify.railway','updates.ringcentral','voip',
  // Marketing / ads / retail
  'livenation','facebookmail','backcountry','511tactical','marketing@',
  'newsletter@','unsubscribe','hello@notify','email@updates',
  'parkplaceus','levitate','constantcontact','mailchimp','hubspot',
  // Social media notifications
  'twitter','instagram','linkedin','tiktok','youtube','facebook',
  // Subscriptions / shopping
  'amazon','apple.com','google.com','microsoft','netflix','hulu',
  'doordash','ubereats','grubhub','instacart',
  // Railway (backend notifications)
  'railway.app','notify.railway'
];

// Only let through mortgage-relevant domains
const MORTGAGE_KEYWORDS = [
  'mortgage','loan','realt','real estate','home','house','property',
  'buyer','seller','purchase','refinan','heloc','rate','lender',
  'title','escrow','closing','pre-approv','pre approv','pre-qual',
  'va loan','fha','usda','conventional','dscr','invest'
];

// Extra filter: inbox emails must be mortgage-related OR from known contacts
function isMortgageRelated(subject, snippet, email) {
  const text = (subject + ' ' + snippet + ' ' + email).toLowerCase();
  // Always allow if they're in Google Contacts
  return MORTGAGE_KEYWORDS.some(kw => text.includes(kw));
}
const skipEmail = e => SKIP.some(s => (e||'').toLowerCase().includes(s));
const extractEmail = raw => { const m=(raw||'').match(/<([^>]+)>/); return (m?m[1]:raw||'').toLowerCase().trim(); };
const cleanName = raw => (raw||'').replace(/<[^>]+>/g,'').replace(/"/g,'').trim();
const extractPhone = txt => { const m=(txt||'').match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/); return m?m[0]:''; };
const isRef = (n,e,ctx) => /realtor|realty|real.?estate|\bagent\b|broker|builder|financial.?advisor|\bcpa\b|attorney|title.?co|insurance.?agent/.test((n+' '+e+' '+ctx).toLowerCase());
const getHdr = (msg,name) => { const h=(msg.payload?.headers||[]).find(h=>h.name.toLowerCase()===name.toLowerCase()); return h?.value||''; };

// ── CORE SCAN ────────────────────────────────────────────────────────
async function runScan() {
  if (!loadTokens()) throw new Error('Not authenticated');

  const gmail  = google.gmail({ version:'v1', auth:oauth2Client });
  const people = google.people({ version:'v1', auth:oauth2Client });

  // contactsMap: email -> {name, phone, role, org}
  const contactsMap = {};
  const prospects = [], referrals = [], seen = new Set();

  // ── STEP 1: Load ALL Google Contacts first (primary phone source) ──
  console.log('Loading Google Contacts...');
  try {
    let pageToken = null;
    do {
      const params = {
        resourceName: 'people/me',
        pageSize: 1000,
        personFields: 'names,emailAddresses,phoneNumbers,organizations',
      };
      if (pageToken) params.pageToken = pageToken;
      const cr = await people.people.connections.list(params);
      const connections = cr.data.connections || [];
      pageToken = cr.data.nextPageToken || null;

      for (const p of connections) {
        const name  = p.names?.[0]?.displayName || '';
        const phone = p.phoneNumbers?.[0]?.value || '';
        const org   = p.organizations?.[0]?.name || '';
        const title = p.organizations?.[0]?.title || '';
        const role  = [title, org].filter(Boolean).join(' @ ');
        const emails = (p.emailAddresses || []).map(e => e.value?.toLowerCase()).filter(Boolean);

        // Store in map by email for cross-referencing
        for (const email of emails) {
          contactsMap[email] = { name, phone, role, org, title };
        }

        // Also add to dialer if they have a phone number
        if (name && (phone || emails.length)) {
          const email = emails[0] || '';
          const tab = isRef(name, email, org + title) ? 'referrals' : 'prospects';
          const key = (email || name).toLowerCase();
          if (!seen.has(key) && !skipEmail(email)) {
            seen.add(key);
            const synopsis = role
              ? name + ' — ' + role + '.' + (phone ? ' Phone: ' + phone + '.' : '')
              : name + (phone ? ' — ' + phone : '') + '. From Google Contacts.';
            const contact = {
              id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
              name, email, phone, role, synopsis,
              tab, source: 'contacts',
              skipped: false, isNew: true, log: [],
              scannedAt: new Date().toISOString()
            };
            tab === 'referrals' ? referrals.push(contact) : prospects.push(contact);
          }
        }
      }
    } while (pageToken);
    console.log('Google Contacts loaded:', Object.keys(contactsMap).length, 'with emails');
  } catch(e) {
    console.log('Google Contacts error:', e.message);
  }

  // ── STEP 2: Scan Gmail — enrich with phone numbers from contacts ──
  function addFromGmail(name, email, phone, synopsis, source) {
    const key = (email || name).toLowerCase().trim();
    if (!key || !name || name.length < 2 || skipEmail(email || '')) return;

    // Check if already added from Google Contacts — if so, just update synopsis
    const existing = [...prospects, ...referrals].find(c =>
      (email && c.email && c.email === email) ||
      c.name.toLowerCase() === name.toLowerCase()
    );

    if (existing) {
      // Update synopsis with Gmail context if more specific
      if (synopsis && synopsis.length > (existing.synopsis || '').length) {
        existing.synopsis = synopsis;
      }
      // Add phone if we found one in email and contact didn't have one
      if (phone && !existing.phone) existing.phone = phone;
      return;
    }

    if (seen.has(key)) return;
    seen.add(key);

    // Cross-reference with Google Contacts for phone number
    const contactData = contactsMap[email] || {};
    const finalPhone = phone || contactData.phone || '';
    const finalRole  = contactData.role || '';

    const tab = isRef(name, email, synopsis + finalRole) ? 'referrals' : 'prospects';
    const contact = {
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
      name: name.slice(0, 60), email: email || '',
      phone: finalPhone, role: finalRole,
      synopsis: (synopsis || '').slice(0, 280),
      tab, source,
      skipped: false, isNew: true, log: [],
      scannedAt: new Date().toISOString()
    };
    tab === 'referrals' ? referrals.push(contact) : prospects.push(contact);
  }

  // Get Gmail labels
  const lblRes = await gmail.users.labels.list({ userId: 'me' });
  const allLabels = lblRes.data.labels || [];
  const lbl = name => allLabels.find(l => l.name.toLowerCase() === name.toLowerCase());

  const queries = [
    { q: 'in:inbox newer_than:30d', source: 'gmail', type: 'inbox' },
    { q: 'in:sent newer_than:30d', source: 'replied', type: 'sent' },
    { q: 'subject:(missed call OR voicemail OR "tried to reach") newer_than:30d', source: 'missed', type: 'missed' },
  ];
  if (lbl('PROSPECTS'))              queries.push({ q: 'label:PROSPECTS newer_than:30d', source: 'gmail', type: 'prospects' });
  if (lbl('Realtor Builder emails')) queries.push({ q: 'label:"Realtor Builder emails" newer_than:30d', source: 'gmail', type: 'realtors' });
  if (lbl('Client emails'))          queries.push({ q: 'label:"Client emails" newer_than:30d', source: 'gmail', type: 'clients' });

  for (const { q, source, type } of queries) {
    try {
      const r = await gmail.users.threads.list({ userId: 'me', q, maxResults: 40 });
      for (const thread of (r.data.threads || []).slice(0, 25)) {
        try {
          const td = await gmail.users.threads.get({
            userId: 'me', id: thread.id,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject']
          });
          const msgs = td.data.messages || [];
          if (!msgs.length) continue;
          const m = msgs[0];
          const snippet = m.snippet || '';
          const subject = getHdr(m, 'Subject');
          const fromRaw = getHdr(m, 'From');
          const fromEmail = extractEmail(fromRaw);
          const fromName  = cleanName(fromRaw.split('<')[0]) || fromEmail.split('@')[0];
          const phone = extractPhone(snippet + fromRaw);

          if (type === 'sent') {
            const toRaw = getHdr(m, 'To');
            if (!toRaw) continue;
            for (const entry of toRaw.split(',').slice(0, 3)) {
              const te = extractEmail(entry);
              const tn = cleanName(entry.split('<')[0]) || te.split('@')[0];
              if (!skipEmail(te)) {
                addFromGmail(tn, te, '', `Nathan emailed about: "${subject.slice(0,60)}". Follow up.`, 'replied');
              }
            }
            continue;
          }
          if (type === 'missed') {
            addFromGmail(fromName, fromEmail, phone, `Missed call/voicemail: "${subject.slice(0,60)}". Call back ASAP.`, 'missed');
            continue;
          }
          if (skipEmail(fromEmail)) continue;
          // For inbox, only include if mortgage-related OR already in Google Contacts
          const inContacts = !!contactsMap[fromEmail];
          if (type === 'inbox' && !inContacts && !isMortgageRelated(subject, snippet, fromEmail)) continue;
          const syn = subject
            ? `Reached out about "${subject.slice(0,60)}". ${snippet.slice(0,120).replace(/<[^>]+>/g,'')} — follow up.`
            : snippet.slice(0,200).replace(/<[^>]+>/g,'') + ' — follow up.';
          addFromGmail(fromName, fromEmail, phone, syn, source);
        } catch(e) {}
      }
    } catch(e) { console.log('Query error:', type, e.message); }
  }

  // Sort: missed/voicemail first, then replied, then gmail, then contacts
  const pri = { missed:0, voicemail:1, replied:2, gmail:3, contacts:4 };
  prospects.sort((a,b) => (pri[a.source]||9) - (pri[b.source]||9));
  referrals.sort((a,b) => (pri[a.source]||9) - (pri[b.source]||9));

  const result = {
    success: true,
    contacts: { prospects, referrals },
    stats: {
      prospects: prospects.length,
      referrals: referrals.length,
      total: prospects.length + referrals.length,
      scannedAt: new Date().toISOString()
    }
  };
  saveCache(result);
  console.log(`Scan done: ${prospects.length} prospects, ${referrals.length} referrals`);
  return result;
}

// ── SCHEDULED 7AM SCAN ───────────────────────────────────────────────
function scheduleMorningScan() {
  function msUntil7am() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(11, 0, 0, 0); // 7am ET
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }
  function scheduleNext() {
    const ms = msUntil7am();
    console.log(`Next auto-scan in ~${Math.round(ms/3600000)}h`);
    setTimeout(async () => {
      console.log('Running 7am scan...');
      try { await runScan(); console.log('Done'); } catch(e) { console.log('Error:', e.message); }
      scheduleNext();
    }, ms);
  }
  scheduleNext();
}

// ── AUTH ROUTES ──────────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  res.redirect(oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/contacts.readonly',
    ],
    prompt: 'consent'
  }));
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    saveTokens(tokens); oauth2Client.setCredentials(tokens);
    setTimeout(() => runScan().catch(e => console.log(e.message)), 2000);
    res.send(`<html><body style="font-family:-apple-system,sans-serif;background:#071530;color:#fff;text-align:center;padding:60px">
      <div style="font-size:60px">⭐</div>
      <h1 style="color:#5dade2">Gmail + Contacts Connected!</h1>
      <p style="color:#85c1e9">Running first scan now — pulling your Google Contacts and Gmail...</p>
      <script>setTimeout(()=>window.close(),4000)</script>
    </body></html>`);
  } catch(e) { res.status(500).send('Auth failed: ' + e.message); }
});

app.get('/auth/status', (req, res) => res.json({ authenticated: loadTokens() }));

// ── SCAN ROUTE ───────────────────────────────────────────────────────
app.get('/scan', async (req, res) => {
  if (!loadTokens()) {
    const base = process.env.BACKEND_URL || `http://localhost:${PORT}`;
    return res.status(401).json({ error: 'Not authenticated', authUrl: base + '/auth/login' });
  }
  // Return cache if fresh (< 4 hours) and not forced
  if (req.query.force !== 'true') {
    const cache = loadCache();
    if (cache?.stats?.scannedAt) {
      const ageHrs = (Date.now() - new Date(cache.stats.scannedAt).getTime()) / 3600000;
      if (ageHrs < 4) {
        console.log(`Returning cache (${Math.round(ageHrs*10)/10}h old)`);
        return res.json({ ...cache, cached: true, cacheAge: Math.round(ageHrs*10)/10 });
      }
    }
  }
  try {
    const result = await runScan();
    res.json(result);
  } catch(e) {
    const cache = loadCache();
    if (cache) return res.json({ ...cache, cached: true, warning: 'Live scan failed, showing cache' });
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => {
  const cache = loadCache();
  res.json({
    status: 'ok',
    authenticated: loadTokens(),
    lastScan: cache?.stats?.scannedAt || null,
    cachedContacts: cache ? cache.stats.total : 0,
    version: '3.0'
  });
});

app.get('/', (req, res) => {
  const auth = loadTokens();
  const cache = loadCache();
  const base = process.env.BACKEND_URL || `http://localhost:${PORT}`;
  const lastScan = cache?.stats?.scannedAt
    ? new Date(cache.stats.scannedAt).toLocaleString('en-US', { timeZone:'America/New_York', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
    : 'Never';
  res.send(`<html><body style="font-family:-apple-system,sans-serif;background:#071530;color:#fff;text-align:center;padding:60px 20px;max-width:500px;margin:0 auto">
    <div style="font-size:60px">⭐</div>
    <h1 style="color:#5dade2">NSMN Dialer Backend</h1>
    <p style="color:${auth?'#30d158':'#ff453a'};font-size:18px;font-weight:700">${auth ? '✅ Connected' : '❌ Not Connected'}</p>
    ${auth ? `
      <p style="color:rgba(255,255,255,.5);font-size:13px">Last scan: ${lastScan} ET</p>
      <p style="color:rgba(255,255,255,.4);font-size:12px">${cache ? cache.stats.total + ' contacts cached' : ''}</p>
      <p style="color:rgba(255,255,255,.3);font-size:11px;margin-top:8px">Auto-scans 7am ET daily</p>
      <a href="/scan?force=true" style="display:inline-block;background:rgba(46,134,193,.3);color:#85c1e9;padding:10px 20px;border-radius:16px;text-decoration:none;font-size:13px;font-weight:700;margin-top:14px;border:1px solid rgba(93,173,226,.4)">🔄 Run Manual Scan</a>
    ` : `<a href="/auth/login" style="display:inline-block;background:#2e86c1;color:#fff;padding:14px 28px;border-radius:24px;text-decoration:none;font-weight:700;margin-top:12px">🔐 Connect Gmail</a>`}
  </body></html>`);
});

app.listen(PORT, () => {
  console.log(`NSMN Dialer Backend v3.0 on port ${PORT}`);
  if (!loadTokens()) {
    console.log(`Connect Gmail: http://localhost:${PORT}/auth/login`);
  } else {
    console.log('Gmail connected!');
    scheduleMorningScan();
    if (!loadCache()) {
      console.log('Running initial scan...');
      runScan().catch(e => console.log(e.message));
    }
  }
});

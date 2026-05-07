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

// ── SKIP LIST ────────────────────────────────────────────────────────
const SKIP = [
  'noreply','no-reply','donotreply','mailer-daemon',
  'kdooli12@gmail','nhyoung5150@gmail','karla@nsmn','nathan@nsmn',
  'service@my220','loans@arive','noreply-mortgage','neptunewholesale',
  'newrez','dcrlaw','homegauge','ice.com','myhomeiq.report','zendesk',
  'listreports','dartappraisal','mortgagetech','arive.com','leaf360',
  'lendware','aidium','whiteboard','my1003app','encompass',
  'ringcentral','quo.com','openphone','salesmsg','heymarket','podium',
  'notify.railway','updates.ringcentral','voip',
  'livenation','facebookmail','backcountry','511tactical','marketing@',
  'newsletter@','unsubscribe','hello@notify','email@updates',
  'parkplaceus','levitate','constantcontact','mailchimp','hubspot',
  'twitter','instagram','linkedin','tiktok','youtube','facebook',
  'amazon','apple.com','google.com','microsoft','netflix','hulu',
  'doordash','ubereats','grubhub','instacart','railway.app',
  'regg','fanatics','mlbshop','petsuper','momentumwatch',
  'evergoods','bozeman','tawk.to','veteransaffairs','quntis',
  'royals.com','adelaidems','scotsmanguide','motto'
];
const skipEmail = e => SKIP.some(s => (e||'').toLowerCase().includes(s));
const extractEmail = raw => { const m=(raw||'').match(/<([^>]+)>/); return (m?m[1]:raw||'').toLowerCase().trim(); };
const cleanName = raw => (raw||'').replace(/<[^>]+>/g,'').replace(/"/g,'').trim();
const extractPhone = txt => { const m=(txt||'').match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/); return m?m[0]:''; };
const isRef = (n,e,ctx) => /realtor|realty|real.?estate|\bagent\b|broker|builder|financial.?advisor|\bcpa\b|attorney|title.?co|insurance.?agent/.test((n+' '+e+' '+ctx).toLowerCase());
const getHdr = (msg,name) => { const h=(msg.payload?.headers||[]).find(h=>h.name.toLowerCase()===name.toLowerCase()); return h?.value||''; };
const normName = n => (n||'').toLowerCase().replace(/[^a-z]/g,'');
const MORTGAGE_KEYWORDS = ['mortgage','loan','realt','real estate','home','house','property','buyer','seller','purchase','refinan','heloc','rate','lender','title','escrow','closing','pre-approv','pre-qual','va loan','fha','usda','conventional','dscr','invest','apprais','contract','addendum','under contract','pre approval'];
const isMortgageRelated = (subject, snippet, email) => MORTGAGE_KEYWORDS.some(kw => (subject+' '+snippet+' '+email).toLowerCase().includes(kw));

// ── CORE SCAN ────────────────────────────────────────────────────────
async function runScan() {
  if (!loadTokens()) throw new Error('Not authenticated');

  const gmail  = google.gmail({ version:'v1', auth:oauth2Client });
  const people = google.people({ version:'v1', auth:oauth2Client });

  // Maps for cross-referencing
  const contactsByEmail = {}; // email -> contact data
  const contactsByName  = {}; // normalized name -> contact data
  const recentlySent    = {}; // email -> {date, subject} — who Nathan emailed last 7 days
  const prospects = [], referrals = [], seen = new Set();

  // ── STEP 1: Load ALL Google Contacts ─────────────────────────────
  console.log('Loading Google Contacts...');
  try {
    let pageToken = null;
    do {
      const params = { resourceName:'people/me', pageSize:1000, personFields:'names,emailAddresses,phoneNumbers,organizations' };
      if (pageToken) params.pageToken = pageToken;
      const cr = await people.people.connections.list(params);
      pageToken = cr.data.nextPageToken || null;

      for (const p of cr.data.connections || []) {
        const name  = p.names?.[0]?.displayName || '';
        const phone = p.phoneNumbers?.[0]?.value || '';
        const org   = p.organizations?.[0]?.name || '';
        const title = p.organizations?.[0]?.title || '';
        const role  = [title, org].filter(Boolean).join(' @ ');
        const emails = (p.emailAddresses || []).map(e => e.value?.toLowerCase()).filter(Boolean);
        const data = { name, phone, role, org, title };

        // Index by all emails
        for (const email of emails) contactsByEmail[email] = data;
        // Index by normalized name for fuzzy matching
        if (name) contactsByName[normName(name)] = { ...data, email: emails[0] || '' };

        // Add to dialer if they have a phone
        if (name && phone) {
          const email = emails[0] || '';
          const tab = isRef(name, email, org+title) ? 'referrals' : 'prospects';
          const key = (email || normName(name));
          if (!seen.has(key) && !skipEmail(email)) {
            seen.add(key);
            const synopsis = role ? `${name} — ${role}. Phone: ${phone}.` : `${name}. Phone: ${phone}. From Google Contacts.`;
            const contact = {
              id: 's'+Date.now().toString(36)+Math.random().toString(36).slice(2,5),
              name, email, phone, role, synopsis,
              tab, source:'contacts', priority: isRef(name,email,org+title) ? 2 : 3,
              skipped:false, isNew:true, log:[], scannedAt:new Date().toISOString()
            };
            tab==='referrals' ? referrals.push(contact) : prospects.push(contact);
          }
        }
      }
    } while (pageToken);
    console.log(`Contacts loaded: ${Object.keys(contactsByEmail).length} by email, ${Object.keys(contactsByName).length} by name`);
  } catch(e) { console.log('Contacts error:', e.message); }

  // ── STEP 2: Scan Sent folder — who did Nathan contact last 7 days? ─
  console.log('Scanning sent mail for recent contacts...');
  try {
    const sentRes = await gmail.users.threads.list({ userId:'me', q:'in:sent newer_than:7d', maxResults:50 });
    for (const thread of (sentRes.data.threads||[]).slice(0,40)) {
      try {
        const td = await gmail.users.threads.get({ userId:'me', id:thread.id, format:'metadata', metadataHeaders:['To','Subject','Date'] });
        const msgs = td.data.messages || [];
        if (!msgs.length) continue;
        const m = msgs[msgs.length-1]; // last message = most recent
        const toRaw = getHdr(m, 'To');
        const subject = getHdr(m, 'Subject');
        const date = getHdr(m, 'Date');
        if (!toRaw) continue;
        for (const entry of toRaw.split(',')) {
          const email = extractEmail(entry);
          if (email && !skipEmail(email)) {
            recentlySent[email] = { date, subject: subject.slice(0,60) };
          }
        }
      } catch(e) {}
    }
    console.log(`Recently sent to: ${Object.keys(recentlySent).length} people`);
  } catch(e) { console.log('Sent scan error:', e.message); }

  // ── STEP 3: Enrich/add from Gmail ────────────────────────────────
  function enrichOrAdd(name, email, phone, synopsis, source, priority) {
    const key = (email || normName(name)).toLowerCase().trim();
    if (!key || !name || name.length < 2 || skipEmail(email||'')) return;

    // Cross-reference Google Contacts by email first, then name
    const contactData = contactsByEmail[email] ||
      contactsByName[normName(name)] || {};
    const finalPhone = phone || contactData.phone || '';
    const finalRole  = contactData.role || '';
    const finalName  = contactData.name || name; // use Google Contacts name if available

    // Check if recently contacted (sent in last 7 days)
    const recentContact = recentlySent[email];
    if (recentContact) {
      // Mark as recently contacted but still include — just lower priority
      synopsis = `Recently emailed: "${recentContact.subject}". ${synopsis}`;
      priority = Math.max(priority, 4); // push to lower priority
    }

    // Check if already added — update if found
    const existingP = prospects.find(c => c.email===email || normName(c.name)===normName(finalName));
    const existingR = referrals.find(c => c.email===email || normName(c.name)===normName(finalName));
    const existing = existingP || existingR;

    if (existing) {
      if (finalPhone && !existing.phone) existing.phone = finalPhone;
      if (finalRole && !existing.role) existing.role = finalRole;
      if (synopsis && synopsis.length > (existing.synopsis||'').length) existing.synopsis = synopsis;
      if (recentContact) existing.recentlySent = recentContact;
      return;
    }

    if (seen.has(key)) return;
    seen.add(key);

    const tab = isRef(finalName, email, synopsis+finalRole) ? 'referrals' : 'prospects';
    const contact = {
      id: 's'+Date.now().toString(36)+Math.random().toString(36).slice(2,5),
      name: finalName.slice(0,60), email:email||'', phone:finalPhone,
      role:finalRole, synopsis:(synopsis||'').slice(0,280),
      tab, source, priority,
      recentlySent: recentContact || null,
      skipped:false, isNew:true, log:[], scannedAt:new Date().toISOString()
    };
    tab==='referrals' ? referrals.push(contact) : prospects.push(contact);
  }

  // Gmail label scan
  const lblRes = await gmail.users.labels.list({ userId:'me' });
  const allLabels = lblRes.data.labels || [];
  const lbl = name => allLabels.find(l=>l.name.toLowerCase()===name.toLowerCase());

  const queries = [
    { q:'label:PROSPECTS newer_than:30d', source:'gmail', type:'prospects', priority:1 },
    { q:'label:"Realtor Builder emails" newer_than:30d', source:'gmail', type:'realtors', priority:1 },
    { q:'label:"Client emails" newer_than:30d', source:'gmail', type:'clients', priority:1 },
    { q:'subject:(missed call OR voicemail OR "tried to reach") newer_than:30d', source:'missed', type:'missed', priority:0 },
    { q:'in:inbox newer_than:30d', source:'gmail', type:'inbox', priority:2 },
  ];
  // Only add labels that exist
  const activeQueries = queries.filter(q => {
    if (q.type==='inbox' || q.type==='missed') return true;
    const labelName = q.type==='prospects'?'PROSPECTS':q.type==='realtors'?'Realtor Builder emails':'Client emails';
    return !!lbl(labelName);
  });

  for (const { q, source, type, priority } of activeQueries) {
    try {
      const r = await gmail.users.threads.list({ userId:'me', q, maxResults:40 });
      for (const thread of (r.data.threads||[]).slice(0,25)) {
        try {
          const td = await gmail.users.threads.get({ userId:'me', id:thread.id, format:'metadata', metadataHeaders:['From','To','Subject'] });
          const msgs = td.data.messages||[];
          if (!msgs.length) continue;
          const m = msgs[0];
          const snippet = m.snippet||'';
          const subject = getHdr(m,'Subject');
          const fromRaw = getHdr(m,'From');
          const fromEmail = extractEmail(fromRaw);
          const fromName  = cleanName(fromRaw.split('<')[0]) || fromEmail.split('@')[0];
          const phone = extractPhone(snippet+fromRaw);

          if (type==='missed') {
            enrichOrAdd(fromName, fromEmail, phone, `Missed call/voicemail: "${subject.slice(0,60)}". Call back ASAP.`, 'missed', 0);
            continue;
          }
          if (skipEmail(fromEmail)) continue;
          // For inbox, must be mortgage-related OR in Google Contacts
          const inContacts = !!(contactsByEmail[fromEmail] || contactsByName[normName(fromName)]);
          if (type==='inbox' && !inContacts && !isMortgageRelated(subject, snippet, fromEmail)) continue;
          const syn = subject
            ? `Reached out about "${subject.slice(0,60)}". ${snippet.slice(0,100).replace(/<[^>]+>/g,'')} — follow up.`
            : snippet.slice(0,180).replace(/<[^>]+>/g,'') + ' — follow up.';
          enrichOrAdd(fromName, fromEmail, phone, syn, source, priority);
        } catch(e) {}
      }
    } catch(e) { console.log('Query error:', type, e.message); }
  }

  // ── STEP 4: Sort by priority & recency ───────────────────────────
  // Priority: 0=missed call, 1=in prospect/realtor folder, 2=inbox, 3=contacts only, 4=recently sent
  // Within same priority: no recent contact first
  function sortContacts(list) {
    return list.sort((a,b) => {
      const pa = a.recentlySent ? (a.priority||9)+10 : (a.priority||9);
      const pb = b.recentlySent ? (b.priority||9)+10 : (b.priority||9);
      return pa - pb;
    });
  }

  const sortedProspects = sortContacts(prospects);
  const sortedReferrals = sortContacts(referrals);

  // Mark top 5 prospects and top 3 referrals as priority
  sortedProspects.slice(0,5).forEach((c,i) => { c.isPriority = true; c.priorityRank = i+1; });
  sortedReferrals.slice(0,3).forEach((c,i) => { c.isPriority = true; c.priorityRank = i+1; });

  const result = {
    success:true,
    contacts:{ prospects:sortedProspects, referrals:sortedReferrals },
    stats:{
      prospects:sortedProspects.length, referrals:sortedReferrals.length,
      total:sortedProspects.length+sortedReferrals.length,
      recentlySentCount:Object.keys(recentlySent).length,
      scannedAt:new Date().toISOString()
    }
  };
  saveCache(result);
  console.log(`Scan done: ${sortedProspects.length} prospects, ${sortedReferrals.length} referrals, ${Object.keys(recentlySent).length} recently contacted`);
  return result;
}

// ── SCHEDULED 7AM SCAN ───────────────────────────────────────────────
function scheduleMorningScan() {
  function msUntil7am() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(11, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate()+1);
    return next - now;
  }
  function scheduleNext() {
    const ms = msUntil7am();
    console.log(`Next auto-scan in ~${Math.round(ms/3600000)}h`);
    setTimeout(async () => {
      console.log('Running 7am scan...');
      try { await runScan(); console.log('Morning scan done'); }
      catch(e) { console.log('Morning scan error:', e.message); }
      scheduleNext();
    }, ms);
  }
  scheduleNext();
}

// ── AUTH ─────────────────────────────────────────────────────────────
app.get('/auth/login', (req,res) => {
  res.redirect(oauth2Client.generateAuthUrl({
    access_type:'offline',
    scope:['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/contacts.readonly'],
    prompt:'consent'
  }));
});
app.get('/auth/callback', async (req,res) => {
  try {
    const {tokens} = await oauth2Client.getToken(req.query.code);
    saveTokens(tokens); oauth2Client.setCredentials(tokens);
    setTimeout(()=>runScan().catch(e=>console.log(e.message)), 2000);
    res.send(`<html><body style="font-family:-apple-system,sans-serif;background:#071530;color:#fff;text-align:center;padding:60px">
      <div style="font-size:60px">&#11088;</div>
      <h1 style="color:#5dade2">Gmail + Contacts Connected!</h1>
      <p style="color:#85c1e9">Running scan now...</p>
      <script>setTimeout(()=>window.close(),4000)</script>
    </body></html>`);
  } catch(e) { res.status(500).send('Auth failed: '+e.message); }
});
app.get('/auth/status', (req,res) => res.json({authenticated:loadTokens()}));

// ── SCAN ─────────────────────────────────────────────────────────────
app.get('/scan', async (req,res) => {
  if (!loadTokens()) {
    const base = process.env.BACKEND_URL||`http://localhost:${PORT}`;
    return res.status(401).json({error:'Not authenticated', authUrl:base+'/auth/login'});
  }
  if (req.query.force !== 'true') {
    const cache = loadCache();
    if (cache?.stats?.scannedAt) {
      const ageHrs = (Date.now()-new Date(cache.stats.scannedAt).getTime())/3600000;
      if (ageHrs < 4) return res.json({...cache, cached:true, cacheAge:Math.round(ageHrs*10)/10});
    }
  }
  try {
    const result = await runScan();
    res.json(result);
  } catch(e) {
    const cache = loadCache();
    if (cache) return res.json({...cache, cached:true, warning:'Live scan failed'});
    res.status(500).json({error:e.message});
  }
});

app.get('/health', (req,res) => {
  const cache = loadCache();
  res.json({status:'ok', authenticated:loadTokens(), lastScan:cache?.stats?.scannedAt||null, cachedContacts:cache?cache.stats.total:0, version:'4.0'});
});

app.get('/', (req,res) => {
  const auth=loadTokens(), cache=loadCache();
  const base=process.env.BACKEND_URL||`http://localhost:${PORT}`;
  const lastScan=cache?.stats?.scannedAt?new Date(cache.stats.scannedAt).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Never';
  res.send(`<html><body style="font-family:-apple-system,sans-serif;background:#071530;color:#fff;text-align:center;padding:60px 20px;max-width:500px;margin:0 auto">
    <div style="font-size:60px">&#11088;</div>
    <h1 style="color:#5dade2">NSMN Dialer Backend v4.0</h1>
    <p style="color:${auth?'#30d158':'#ff453a'};font-size:18px;font-weight:700">${auth?'&#9989; Connected':'&#10060; Not Connected'}</p>
    ${auth?`<p style="color:rgba(255,255,255,.5);font-size:13px">Last scan: ${lastScan} ET</p>
    <p style="color:rgba(255,255,255,.4);font-size:12px">${cache?cache.stats.total+' contacts · '+cache.stats.recentlySentCount+' recently contacted':''}</p>
    <p style="color:rgba(255,255,255,.3);font-size:11px;margin-top:8px">&#9200; Auto-scans 7am ET daily</p>
    <a href="/scan?force=true" style="display:inline-block;background:rgba(46,134,193,.3);color:#85c1e9;padding:10px 20px;border-radius:16px;text-decoration:none;font-size:13px;font-weight:700;margin-top:14px;border:1px solid rgba(93,173,226,.4)">&#128260; Run Manual Scan</a>`
    :`<a href="/auth/login" style="display:inline-block;background:#2e86c1;color:#fff;padding:14px 28px;border-radius:24px;text-decoration:none;font-weight:700;margin-top:12px">&#128274; Connect Gmail</a>`}
  </body></html>`);
});

app.listen(PORT, () => {
  console.log(`NSMN Dialer Backend v4.0 on port ${PORT}`);
  if (!loadTokens()) { console.log(`Connect: http://localhost:${PORT}/auth/login`); }
  else { console.log('Connected!'); scheduleMorningScan(); if(!loadCache()){console.log('Initial scan...'); runScan().catch(e=>console.log(e.message));} }
});

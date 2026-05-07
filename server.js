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

// ── SKIP INTERNAL NSMN STAFF ─────────────────────────────────────────
const SKIP_EMAILS = [
  'kdooli12@gmail.com','nhyoung5150@gmail.com','karla@nsmn.com','nathan@nsmn.com',
  'bking.nsmn@gmail.com','brian@nsmn.com','tavern89@gmail.com',
  'pipermackllc@gmail.com','jaxmortgageguy@gmail.com'
];
const SKIP_DOMAINS = [
  'noreply','no-reply','donotreply','mailer-daemon',
  'service@my220','loans@arive','noreply-mortgage','neptunewholesale',
  'newrez','dcrlaw','homegauge','ice.com','myhomeiq.report','zendesk',
  'listreports','dartappraisal','arive.com','my1003app',
  'ringcentral','quo.com','notify.railway','updates.ringcentral',
  'livenation','facebookmail','backcountry','511tactical','marketing@',
  'newsletter@','unsubscribe','hello@notify','email@updates',
  'levitate','constantcontact','mailchimp','hubspot',
  'twitter','instagram','linkedin','tiktok','youtube','facebook',
  'amazon','apple.com','google.com','microsoft','netflix',
  'doordash','ubereats','grubhub','instacart','railway.app',
  'fanatics','mlbshop','petsuper','momentumwatch','royals.com',
  'scotsmanguide','motto','evergoods','regg'
];

const skipEmail = e => {
  const em = (e||'').toLowerCase();
  if (SKIP_EMAILS.includes(em)) return true;
  return SKIP_DOMAINS.some(s => em.includes(s));
};

// Labels that go to Referral Partners tab
const REFERRAL_LABELS = [
  'realtors','realtor','agents','agent','builders','builder',
  'brokers','broker','cpas','cpa','attorneys','attorney',
  'appraisers','appraiser','financial advisors','financial advisor',
  'bankers','banker','title','insurance','businesses','referrals','referral'
];

// Labels that go to Prospects tab
const PROSPECT_LABELS = [
  'clients','client','prospects','prospect','leads','lead',
  'buyers','buyer','borrowers','borrower','cloze','aa'
];

const isReferralLabel = name => REFERRAL_LABELS.some(r => name.toLowerCase().includes(r));
const isProspectLabel = name => PROSPECT_LABELS.some(p => name.toLowerCase().includes(p));

const extractPhone = txt => {
  if (!txt) return '';
  const patterns = [
    /(?:cell|mobile|direct|phone|ph|tel|c:|m:|d:|p:)[\s:]*(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/i,
    /(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/
  ];
  for (const p of patterns) {
    const m = txt.match(p);
    if (m) {
      const num = (m[1]||m[0]).replace(/\D/g,'');
      if (num.length === 10) return '('+num.slice(0,3)+') '+num.slice(3,6)+'-'+num.slice(6);
      if (num.length === 11 && num[0]==='1') return '('+num.slice(1,4)+') '+num.slice(4,7)+'-'+num.slice(7);
    }
  }
  return '';
};

const extractEmail = raw => { const m=(raw||'').match(/<([^>]+)>/); return (m?m[1]:raw||'').toLowerCase().trim(); };
const cleanName = raw => (raw||'').replace(/<[^>]+>/g,'').replace(/"/g,'').trim();
const normName = n => (n||'').toLowerCase().replace(/[^a-z]/g,'');
const getHdr = (msg,name) => { const h=(msg.payload?.headers||[]).find(h=>h.name.toLowerCase()===name.toLowerCase()); return h?.value||''; };

const MORTGAGE_KEYWORDS = ['mortgage','loan','realt','real estate','home','house','property','buyer','seller','purchase','refinan','heloc','rate','lender','title','escrow','closing','pre-approv','pre-qual','va loan','fha','usda','conventional','dscr','invest','apprais','contract','addendum'];
const isMortgageRelated = (subject, snippet, email) => MORTGAGE_KEYWORDS.some(kw => (subject+' '+snippet+' '+email).toLowerCase().includes(kw));

// ── CORE SCAN ────────────────────────────────────────────────────────
async function runScan() {
  if (!loadTokens()) throw new Error('Not authenticated');
  const gmail  = google.gmail({ version:'v1', auth:oauth2Client });
  const people = google.people({ version:'v1', auth:oauth2Client });

  const prospects = [], referrals = [], seen = new Set();
  const contactsByEmail = {}, contactsByName = {}, recentlySent = {};

  // ── STEP 1: Load ALL Google Contacts with labels ──────────────────
  console.log('Loading all Google Contacts...');
  try {
    // First get all contact groups/labels
    const groupsRes = await people.contactGroups.list({ pageSize: 100 });
    const groups = groupsRes.data.contactGroups || [];
    const groupMap = {}; // resourceName -> label name
    for (const g of groups) {
      if (g.groupType === 'USER_CONTACT_GROUP') {
        groupMap[g.resourceName] = g.name;
      }
    }
    console.log('Contact groups found:', Object.keys(groupMap).length);

    // Load all contacts
    let pageToken = null;
    let totalLoaded = 0;
    do {
      const params = {
        resourceName: 'people/me',
        pageSize: 1000,
        personFields: 'names,emailAddresses,phoneNumbers,organizations,memberships',
      };
      if (pageToken) params.pageToken = pageToken;
      const cr = await people.people.connections.list(params);
      pageToken = cr.data.nextPageToken || null;
      const connections = cr.data.connections || [];
      totalLoaded += connections.length;

      for (const p of connections) {
        const name  = p.names?.[0]?.displayName || '';
        const phone = p.phoneNumbers?.[0]?.value || '';
        const org   = p.organizations?.[0]?.name || '';
        const title = p.organizations?.[0]?.title || '';
        const role  = [title, org].filter(Boolean).join(' @ ');
        const emails = (p.emailAddresses || []).map(e => e.value?.toLowerCase()).filter(Boolean);

        if (!name || name.length < 2) continue;

        // Get contact labels
        const memberLabels = (p.memberships || [])
          .map(m => groupMap[m.contactGroupMembership?.contactGroupResourceName] || '')
          .filter(Boolean);

        // Skip internal NSMN staff
        if (emails.some(e => SKIP_EMAILS.includes(e))) continue;
        if (org && org.toLowerCase().includes('north star mortgage') && 
            (title.toLowerCase().includes('loan officer') || title.toLowerCase().includes('assistant'))) continue;

        // Determine tab from labels
        let tab = null;
        for (const lbl of memberLabels) {
          if (isReferralLabel(lbl)) { tab = 'referrals'; break; }
        }
        if (!tab) {
          for (const lbl of memberLabels) {
            if (isProspectLabel(lbl)) { tab = 'prospects'; break; }
          }
        }
        // If no matching label, use role/org to determine
        if (!tab) {
          const ctx = (name+' '+org+' '+title+' '+(emails[0]||'')).toLowerCase();
          tab = /realtor|realty|real.?estate|\bagent\b|broker|builder|financial.?advisor|\bcpa\b|attorney|title.?co|insurance.?agent|appraiser/.test(ctx) ? 'referrals' : 'prospects';
        }

        const email = emails[0] || '';
        const key = (email || normName(name));

        // Index for cross-referencing
        for (const em of emails) contactsByEmail[em] = { name, phone, role, org, title };
        if (name) contactsByName[normName(name)] = { name, phone, role, org, title, email };

        // Add to dialer
        if (!seen.has(key) && !skipEmail(email)) {
          seen.add(key);
          const labelStr = memberLabels.length ? memberLabels.join(', ') : '';
          const synopsis = role
            ? `${name} — ${role}.${phone ? ' Phone: '+phone+'.' : ''}${labelStr ? ' ['+labelStr+']' : ''}`
            : `${name}.${phone ? ' Phone: '+phone+'.' : ''}${email ? ' Email: '+email+'.' : ''}`;
          const contact = {
            id: 's'+Date.now().toString(36)+Math.random().toString(36).slice(2,5),
            name, email, phone, role,
            synopsis: synopsis.slice(0, 280),
            labels: labelStr,
            tab, source: 'contacts',
            priority: tab === 'referrals' ? 2 : 3,
            skipped: false, isNew: true, log: [],
            scannedAt: new Date().toISOString()
          };
          tab === 'referrals' ? referrals.push(contact) : prospects.push(contact);
        }
      }
    } while (pageToken);
    console.log(`Loaded ${totalLoaded} contacts → ${prospects.length} prospects, ${referrals.length} referrals`);
  } catch(e) { console.log('Contacts error:', e.message); }

  // ── STEP 2: Check sent mail — who did Nathan contact last 7 days ──
  console.log('Scanning sent mail...');
  try {
    const sentRes = await gmail.users.threads.list({ userId:'me', q:'in:sent newer_than:7d', maxResults:50 });
    for (const thread of (sentRes.data.threads||[]).slice(0,40)) {
      try {
        const td = await gmail.users.threads.get({ userId:'me', id:thread.id, format:'metadata', metadataHeaders:['To','Subject','Date'] });
        const msgs = td.data.messages||[];
        if (!msgs.length) continue;
        const m = msgs[msgs.length-1];
        const toRaw = getHdr(m,'To');
        const subject = getHdr(m,'Subject');
        const date = getHdr(m,'Date');
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

  // ── STEP 3: Gmail inbox for NEW people not yet in contacts ────────
  console.log('Scanning Gmail for new contacts...');
  const lblRes = await gmail.users.labels.list({ userId:'me' });
  const allLabels = lblRes.data.labels || [];
  const lbl = name => allLabels.find(l=>l.name.toLowerCase()===name.toLowerCase());

  function enrichOrAdd(name, email, phone, synopsis, source, priority) {
    const key = (email || normName(name)).toLowerCase().trim();
    if (!key || !name || name.length < 2 || skipEmail(email||'')) return;

    // Cross-reference contacts
    const contactData = contactsByEmail[email] || contactsByName[normName(name)] || {};
    const finalPhone = phone || contactData.phone || '';
    const finalRole  = contactData.role || '';
    const finalName  = contactData.name || name;

    // Mark recently contacted
    const recentContact = recentlySent[email];
    if (recentContact) synopsis = `Recently emailed: "${recentContact.subject}". ${synopsis}`;

    // Update existing
    const allContacts = [...prospects, ...referrals];
    const existing = allContacts.find(c =>
      (email && c.email === email) ||
      normName(c.name) === normName(finalName)
    );
    if (existing) {
      if (finalPhone && !existing.phone) existing.phone = finalPhone;
      if (finalRole && !existing.role) existing.role = finalRole;
      if (recentContact) existing.recentlySent = recentContact;
      return;
    }

    if (seen.has(key)) return;
    seen.add(key);

    const ctx = (finalName+' '+email+' '+synopsis+finalRole).toLowerCase();
    const tab = /realtor|realty|real.?estate|\bagent\b|broker|builder|financial.?advisor|\bcpa\b|attorney|title.?co|insurance.?agent/.test(ctx) ? 'referrals' : 'prospects';
    const contact = {
      id: 's'+Date.now().toString(36)+Math.random().toString(36).slice(2,5),
      name: finalName.slice(0,60), email:email||'', phone:finalPhone,
      role:finalRole, synopsis:(synopsis||'').slice(0,280),
      tab, source, priority,
      recentlySent: recentContact||null,
      skipped:false, isNew:true, log:[],
      scannedAt:new Date().toISOString()
    };
    tab==='referrals' ? referrals.push(contact) : prospects.push(contact);
  }

  const queries = [
    { q:'subject:(missed call OR voicemail OR "tried to reach") newer_than:30d', source:'missed', type:'missed', priority:0 },
    { q:'label:PROSPECTS newer_than:30d', source:'gmail', type:'prospects', priority:1 },
    { q:'label:"Realtor Builder emails" newer_than:30d', source:'gmail', type:'realtors', priority:1 },
    { q:'label:"Client emails" newer_than:30d', source:'gmail', type:'clients', priority:1 },
    { q:'in:inbox newer_than:30d', source:'gmail', type:'inbox', priority:2 },
  ];

  for (const { q, source, type, priority } of queries) {
    try {
      const r = await gmail.users.threads.list({ userId:'me', q, maxResults:30 });
      for (const thread of (r.data.threads||[]).slice(0,20)) {
        try {
          const td = await gmail.users.threads.get({ userId:'me', id:thread.id, format:'full' });
          const msgs = td.data.messages||[];
          if (!msgs.length) continue;
          const m = msgs[0];
          const snippet = m.snippet||'';
          const subject = getHdr(m,'Subject');
          const fromRaw = getHdr(m,'From');
          const fromEmail = extractEmail(fromRaw);
          const fromName  = cleanName(fromRaw.split('<')[0])||fromEmail.split('@')[0];

          // Extract phone from body/signature
          let bodyText = snippet;
          try {
            const parts = m.payload?.parts||[m.payload];
            for (const part of parts) {
              if (part?.mimeType==='text/plain'&&part?.body?.data) {
                bodyText += ' '+Buffer.from(part.body.data,'base64').toString('utf8').slice(0,500);
              }
            }
          } catch(e) {}
          const phone = extractPhone(bodyText+fromRaw);

          if (type==='missed') { enrichOrAdd(fromName,fromEmail,phone,`Missed call: "${subject.slice(0,60)}". Call back ASAP.`,'missed',0); continue; }
          if (skipEmail(fromEmail)) continue;
          const inContacts = !!(contactsByEmail[fromEmail]||contactsByName[normName(fromName)]);
          if (type==='inbox'&&!inContacts&&!isMortgageRelated(subject,snippet,fromEmail)) continue;
          const syn = subject ? `Reached out about "${subject.slice(0,60)}". ${snippet.slice(0,100).replace(/<[^>]+>/g,'')}` : snippet.slice(0,180).replace(/<[^>]+>/g,'');
          enrichOrAdd(fromName,fromEmail,phone,syn,source,priority);
        } catch(e) {}
      }
    } catch(e) { console.log('Query error:', type, e.message); }
  }

  // ── STEP 4: Sort — missed first, then by label priority, recently sent last ──
  function sortContacts(list) {
    return list.sort((a,b) => {
      const pa = a.recentlySent ? (a.priority||9)+20 : (a.priority||9);
      const pb = b.recentlySent ? (b.priority||9)+20 : (b.priority||9);
      return pa - pb;
    });
  }

  const sortedProspects = sortContacts(prospects);
  const sortedReferrals = sortContacts(referrals);

  // Top 5 / top 3 priority badges
  sortedProspects.filter(c=>!c.recentlySent).slice(0,5).forEach((c,i)=>{c.isPriority=true;c.priorityRank=i+1;});
  sortedReferrals.filter(c=>!c.recentlySent).slice(0,3).forEach((c,i)=>{c.isPriority=true;c.priorityRank=i+1;});

  const result = {
    success:true,
    contacts:{prospects:sortedProspects,referrals:sortedReferrals},
    stats:{
      prospects:sortedProspects.length,
      referrals:sortedReferrals.length,
      total:sortedProspects.length+sortedReferrals.length,
      recentlySentCount:Object.keys(recentlySent).length,
      scannedAt:new Date().toISOString()
    }
  };
  saveCache(result);
  console.log(`Done: ${sortedProspects.length} prospects, ${sortedReferrals.length} referrals`);
  return result;
}

// ── SCHEDULED 7AM SCAN ───────────────────────────────────────────────
function scheduleMorningScan() {
  function msUntil7am(){const now=new Date(),next=new Date(now);next.setUTCHours(11,0,0,0);if(next<=now)next.setUTCDate(next.getUTCDate()+1);return next-now;}
  function scheduleNext(){const ms=msUntil7am();console.log(`Next scan in ~${Math.round(ms/3600000)}h`);setTimeout(async()=>{console.log('7am scan...');try{await runScan();console.log('Done');}catch(e){console.log('Error:',e.message);}scheduleNext();},ms);}
  scheduleNext();
}

// ── AUTH ─────────────────────────────────────────────────────────────
app.get('/auth/login',(req,res)=>res.redirect(oauth2Client.generateAuthUrl({access_type:'offline',scope:['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/contacts.readonly'],prompt:'consent'})));
app.get('/auth/callback',async(req,res)=>{
  try{const{tokens}=await oauth2Client.getToken(req.query.code);saveTokens(tokens);oauth2Client.setCredentials(tokens);setTimeout(()=>runScan().catch(e=>console.log(e.message)),2000);
  res.send('<html><body style="font-family:-apple-system,sans-serif;background:#071530;color:#fff;text-align:center;padding:60px"><div style="font-size:60px">&#11088;</div><h1 style="color:#5dade2">Connected!</h1><p style="color:#85c1e9">Scanning all 7,000+ contacts now...</p><script>setTimeout(()=>window.close(),4000)</script></body></html>');}
  catch(e){res.status(500).send('Auth failed: '+e.message);}
});
app.get('/auth/status',(req,res)=>res.json({authenticated:loadTokens()}));
app.get('/tokens',(req,res)=>{const t=loadTokensSafe();if(!t)return res.json({error:'Not authenticated'});res.json({GMAIL_TOKENS:JSON.stringify(t),instruction:'Copy GMAIL_TOKENS value into Railway Variables'});});

// ── SCAN ─────────────────────────────────────────────────────────────
app.get('/scan',async(req,res)=>{
  if(!loadTokens()){const base=process.env.BACKEND_URL||`http://localhost:${PORT}`;return res.status(401).json({error:'Not authenticated',authUrl:base+'/auth/login'});}
  if(req.query.force!=='true'){const cache=loadCache();if(cache?.stats?.scannedAt){const age=(Date.now()-new Date(cache.stats.scannedAt).getTime())/3600000;if(age<4)return res.json({...cache,cached:true,cacheAge:Math.round(age*10)/10});}}
  try{const result=await runScan();res.json(result);}
  catch(e){const cache=loadCache();if(cache)return res.json({...cache,cached:true,warning:'Live scan failed'});res.status(500).json({error:e.message});}
});

app.get('/health',(req,res)=>{const cache=loadCache();res.json({status:'ok',authenticated:loadTokens(),lastScan:cache?.stats?.scannedAt||null,cachedContacts:cache?cache.stats.total:0,version:'5.0'});});

app.get('/',(req,res)=>{
  const auth=loadTokens(),cache=loadCache(),base=process.env.BACKEND_URL||`http://localhost:${PORT}`;
  const lastScan=cache?.stats?.scannedAt?new Date(cache.stats.scannedAt).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Never';
  res.send(`<html><body style="font-family:-apple-system,sans-serif;background:#071530;color:#fff;text-align:center;padding:60px 20px;max-width:500px;margin:0 auto">
    <div style="font-size:60px">&#11088;</div><h1 style="color:#5dade2">NSMN Dialer v5.0</h1>
    <p style="color:${auth?'#30d158':'#ff453a'};font-size:18px;font-weight:700">${auth?'&#9989; Connected':'&#10060; Not Connected'}</p>
    ${auth?`<p style="color:rgba(255,255,255,.5);font-size:13px">Last scan: ${lastScan} ET</p>
    <p style="color:rgba(255,255,255,.4);font-size:12px">${cache?cache.stats.total+' contacts':''}</p>
    <p style="color:rgba(255,255,255,.3);font-size:11px;margin-top:4px">Pulling all 7,000+ Google Contacts by label</p>
    <a href="/scan?force=true" style="display:inline-block;background:rgba(46,134,193,.3);color:#85c1e9;padding:10px 20px;border-radius:16px;text-decoration:none;font-size:13px;font-weight:700;margin-top:14px;border:1px solid rgba(93,173,226,.4)">&#128260; Run Manual Scan</a>`
    :`<a href="/auth/login" style="display:inline-block;background:#2e86c1;color:#fff;padding:14px 28px;border-radius:24px;text-decoration:none;font-weight:700;margin-top:12px">&#128274; Connect Gmail</a>`}
  </body></html>`);
});

app.listen(PORT,()=>{
  console.log(`NSMN Dialer Backend v5.0 on port ${PORT}`);
  if(!loadTokens())console.log(`Connect: http://localhost:${PORT}/auth/login`);
  else{console.log('Connected! Scheduling scans...');scheduleMorningScan();if(!loadCache()){console.log('Initial scan...');runScan().catch(e=>console.log(e.message));}}
});

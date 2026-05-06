require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const TOKEN_FILE  = path.join(__dirname, 'tokens.json');
const CACHE_FILE  = path.join(__dirname, 'scan_cache.json');
const PORT = process.env.PORT || 3001;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

function loadTokensSafe() {
  try {
    if (fs.existsSync(TOKEN_FILE)) return JSON.parse(fs.readFileSync(TOKEN_FILE));
    if (process.env.GMAIL_TOKENS)  return JSON.parse(process.env.GMAIL_TOKENS);
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
loadTokens();
oauth2Client.on('tokens', t => oauth2Client.setCredentials(saveTokens(t)));

function loadCache() {
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE)); } catch(e) {}
  return null;
}
function saveCache(data) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data)); } catch(e) {}
}

const SKIP = ['noreply','no-reply','donotreply','mailer-daemon','kdooli12@gmail','nhyoung5150@gmail','karla@nsmn','nathan@nsmn','service@my220','loans@arive','notify@','noreply-mortgage','neptunewholesale','newrez','dcrlaw','homegauge','ice.com','myhomeiq.report','zendesk','listreports'];
const skipEmail = e => SKIP.some(s => (e||'').includes(s));
const extractEmail = raw => { const m=(raw||'').match(/<([^>]+)>/); return (m?m[1]:raw||'').toLowerCase().trim(); };
const cleanName = raw => (raw||'').replace(/<[^>]+>/g,'').replace(/"/g,'').trim();
const extractPhone = txt => { const m=(txt||'').match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/); return m?m[0]:''; };
const isRef = (n,e,ctx) => /realtor|realty|real estate|\bagent\b|broker|builder|financial.?advisor|\bcpa\b|attorney|title.?co|insurance.?agent/.test((n+e+ctx).toLowerCase());
const getHdr = (msg,name) => { const h=(msg.payload?.headers||[]).find(h=>h.name.toLowerCase()===name.toLowerCase()); return h?.value||''; };

async function runScan() {
  if (!loadTokens()) throw new Error('Not authenticated');
  const gmail = google.gmail({ version:'v1', auth:oauth2Client });
  const people = google.people({ version:'v1', auth:oauth2Client });
  const prospects=[], referrals=[], seen=new Set();

  function add(name,email,phone,role,synopsis,source,tab) {
    const key=(email||name).toLowerCase().trim();
    if(!key||seen.has(key)||!name||name.length<2||name.includes('@')) return;
    if(skipEmail(email||'')) return;
    seen.add(key);
    const c={id:'s'+Date.now().toString(36)+Math.random().toString(36).slice(2,5),name:name.slice(0,60),email:email||'',phone:phone||'',role:role||'',synopsis:(synopsis||'').slice(0,280),tab,source,skipped:false,isNew:true,log:[],scannedAt:new Date().toISOString()};
    tab==='referrals'?referrals.push(c):prospects.push(c);
  }

  const lblRes = await gmail.users.labels.list({userId:'me'});
  const allLabels = lblRes.data.labels||[];
  const lbl = name => allLabels.find(l=>l.name.toLowerCase()===name.toLowerCase());

  const queries = [
    {q:'in:inbox newer_than:30d',source:'gmail',type:'inbox'},
    {q:'in:sent newer_than:30d',source:'replied',type:'sent'},
    {q:'subject:(missed call OR voicemail OR "tried to reach") newer_than:30d',source:'missed',type:'missed'},
  ];
  if(lbl('PROSPECTS')) queries.push({q:'label:PROSPECTS newer_than:30d',source:'gmail',type:'prospects'});
  if(lbl('Realtor Builder emails')) queries.push({q:'label:"Realtor Builder emails" newer_than:30d',source:'gmail',type:'realtors'});
  if(lbl('Client emails')) queries.push({q:'label:"Client emails" newer_than:30d',source:'gmail',type:'clients'});

  for(const {q,source,type} of queries) {
    try {
      const r = await gmail.users.threads.list({userId:'me',q,maxResults:40});
      for(const thread of (r.data.threads||[]).slice(0,25)) {
        try {
          const td = await gmail.users.threads.get({userId:'me',id:thread.id,format:'metadata',metadataHeaders:['From','To','Subject']});
          const msgs = td.data.messages||[];
          if(!msgs.length) continue;
          const m=msgs[0],snippet=m.snippet||'',subject=getHdr(m,'Subject'),fromRaw=getHdr(m,'From');
          const fromEmail=extractEmail(fromRaw),fromName=cleanName(fromRaw.split('<')[0])||fromEmail.split('@')[0];
          const phone=extractPhone(snippet+fromRaw);
          if(type==='sent'){const toRaw=getHdr(m,'To');if(!toRaw)continue;for(const entry of toRaw.split(',').slice(0,3)){const te=extractEmail(entry),tn=cleanName(entry.split('<')[0])||te.split('@')[0];if(skipEmail(te))continue;add(tn,te,'','',`Nathan emailed about: "${subject.slice(0,60)}". Check response and follow up.`,'replied',isRef(tn,te,subject)?'referrals':'prospects');}continue;}
          if(type==='missed'){add(fromName,fromEmail,phone,'',`Missed call/voicemail: "${subject.slice(0,60)}". Call back ASAP.`,'missed',isRef(fromName,fromEmail,subject)?'referrals':'prospects');continue;}
          if(skipEmail(fromEmail))continue;
          const tab=isRef(fromName,fromEmail,subject+snippet)?'referrals':'prospects';
          const syn=subject?`Reached out about "${subject.slice(0,60)}". ${snippet.slice(0,120).replace(/<[^>]+>/g,'')} — follow up.`:snippet.slice(0,200).replace(/<[^>]+>/g,'')+' — follow up.';
          add(fromName,fromEmail,phone,'',syn,source,tab);
        }catch(e){}
      }
    }catch(e){console.log(`Query error (${type}):`,e.message);}
  }

  try {
    const cr=await people.people.connections.list({resourceName:'people/me',pageSize:200,personFields:'names,emailAddresses,phoneNumbers,organizations'});
    for(const p of cr.data.connections||[]){const name=p.names?.[0]?.displayName||'',email=(p.emailAddresses?.[0]?.value||'').toLowerCase(),phone=p.phoneNumbers?.[0]?.value||'',org=p.organizations?.[0]?.name||'',title=p.organizations?.[0]?.title||'';if(!name||(!email&&!phone))continue;const role=[title,org].filter(Boolean).join(' @ ');add(name,email,phone,role,`${name}${role?' — '+role:''}. ${phone?'📞 '+phone:''} From Google Contacts.`,'contacts',isRef(name,email,org+title)?'referrals':'prospects');}
  }catch(e){console.log('Contacts:',e.message);}

  const pri={missed:0,voicemail:1,replied:2,gmail:3,contacts:4};
  prospects.sort((a,b)=>(pri[a.source]||9)-(pri[b.source]||9));
  referrals.sort((a,b)=>(pri[a.source]||9)-(pri[b.source]||9));
  const result={success:true,contacts:{prospects,referrals},stats:{prospects:prospects.length,referrals:referrals.length,total:prospects.length+referrals.length,scannedAt:new Date().toISOString()}};
  saveCache(result);
  console.log(`✅ Scan: ${prospects.length} prospects, ${referrals.length} referrals`);
  return result;
}

function scheduleMorningScan() {
  function msUntil7am(){const now=new Date(),next=new Date(now);next.setUTCHours(12,0,0,0);if(next<=now)next.setUTCDate(next.getUTCDate()+1);return next-now;}
  function scheduleNext(){const ms=msUntil7am();console.log(`⏰ Next scan in ~${Math.round(ms/3600000)}h`);setTimeout(async()=>{console.log('⏰ Running 7am scan...');try{await runScan();console.log('✅ Done');}catch(e){console.log('⚠️',e.message);}scheduleNext();},ms);}
  scheduleNext();
}

app.get('/auth/login',(req,res)=>res.redirect(oauth2Client.generateAuthUrl({access_type:'offline',scope:['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/contacts.readonly'],prompt:'consent'})));

app.get('/auth/callback',async(req,res)=>{try{const{tokens}=await oauth2Client.getToken(req.query.code);saveTokens(tokens);oauth2Client.setCredentials(tokens);setTimeout(()=>runScan().catch(e=>console.log(e.message)),2000);res.send('<html><body style="font-family:-apple-system,sans-serif;background:#071530;color:#fff;text-align:center;padding:60px"><div style="font-size:60px">⭐</div><h1 style="color:#5dade2">Gmail Connected!</h1><p style="color:#85c1e9">Running first scan... close this window.</p><script>setTimeout(()=>window.close(),4000)</script></body></html>');}catch(e){res.status(500).send('Auth failed: '+e.message);}});

app.get('/auth/status',(req,res)=>res.json({authenticated:loadTokens()}));

app.get('/scan',async(req,res)=>{
  if(!loadTokens()){const base=process.env.BACKEND_URL||`http://localhost:${PORT}`;return res.status(401).json({error:'Not authenticated',authUrl:base+'/auth/login'});}
  if(req.query.force!=='true'){const cache=loadCache();if(cache?.stats?.scannedAt){const age=(Date.now()-new Date(cache.stats.scannedAt).getTime())/3600000;if(age<4)return res.json({...cache,cached:true,cacheAge:Math.round(age*10)/10});}}
  try{const result=await runScan();res.json(result);}catch(e){const cache=loadCache();if(cache)return res.json({...cache,cached:true,warning:'Live scan failed'});res.status(500).json({error:e.message});}
});

app.get('/health',(req,res)=>{const cache=loadCache();res.json({status:'ok',authenticated:loadTokens(),lastScan:cache?.stats?.scannedAt||null,cachedContacts:cache?cache.stats.total:0,name:'NSMN Dialer Backend',version:'2.1'});});

app.get('/',(req,res)=>{const auth=loadTokens(),base=process.env.BACKEND_URL||`http://localhost:${PORT}`,cache=loadCache(),lastScan=cache?.stats?.scannedAt?new Date(cache.stats.scannedAt).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Never';res.send(`<html><body style="font-family:-apple-system,sans-serif;background:#071530;color:#fff;text-align:center;padding:60px 20px;max-width:500px;margin:0 auto"><div style="font-size:60px">⭐</div><h1 style="color:#5dade2">NSMN Dialer Backend</h1><p style="color:${auth?'#30d158':'#ff453a'};font-size:18px;font-weight:700">${auth?'✅ Gmail Connected':'❌ Gmail Not Connected'}</p>${auth?`<p style="color:rgba(255,255,255,.5);font-size:13px">Last scan: ${lastScan} ET</p><a href="/scan?force=true" style="display:inline-block;background:rgba(46,134,193,.3);color:#85c1e9;padding:10px 20px;border-radius:16px;text-decoration:none;font-size:13px;font-weight:700;margin-top:12px;border:1px solid rgba(93,173,226,.4)">🔄 Manual Scan</a>`:`<a href="/auth/login" style="display:inline-block;background:#2e86c1;color:#fff;padding:14px 28px;border-radius:24px;text-decoration:none;font-weight:700;font-size:15px;margin-top:12px">🔐 Connect Gmail</a>`}<p style="color:rgba(255,255,255,.2);font-size:11px;margin-top:24px">⏰ Auto-scans 7am ET daily</p></body></html>`);});

app.listen(PORT,()=>{console.log(`\n⭐ NSMN Dialer Backend v2.1 on port ${PORT}`);if(!loadTokens())console.log(`🔐 Connect: http://localhost:${PORT}/auth/login`);else{console.log('✅ Gmail connected!');scheduleMorningScan();if(!loadCache()){console.log('📬 Running initial scan...');runScan().catch(e=>console.log(e.message));}}});

// v13 service worker with Scenes ("Seances"), Exam Mode, Focus/Lock, YouTube/Doodles via policy

const STATE = {
  studentId: "student@school.org",
  studentName: "",
  backendBase: "https://gschool.gdistrict.org",
  paused: false,
  focusMode: false,
  examMode: false,
  examUrl: "",
  categories: {}, // fixed
  blocked_redirect: "https://blocked.gdistrict.org/Gschool%20block",
  allowlist: [],
  teacher_blocks: [],
  bypass_enabled: false,
  bypass_urls: {},
  chat_enabled: true,
  classInfo: { id: "period1", name: "Period 1", active: true },
  lockApplied: false
};

// Cache of last-seen screenshots per tabId (string keys)
const TAB_SHOTS = {};

async function captureActiveTabShot(tabId) {
  try {
    if (!tabId) return;
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
    if (dataUrl) TAB_SHOTS[String(tabId)] = dataUrl;
  } catch (e) { /* ignore */ }
}

// Keep TAB_SHOTS up-to-date when the active tab changes / loads / focus shifts
chrome.tabs.onActivated.addListener(async (info) => {
  if (info && info.tabId) await captureActiveTabShot(info.tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo && changeInfo.status === "complete" && tab && tab.active) {
    setTimeout(() => { captureActiveTabShot(tabId); }, 250);
  }
});
chrome.windows.onFocusChanged.addListener(async (winId) => {
  if (winId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const tabs = await chrome.tabs.query({ active: true, windowId: winId });
    if (tabs && tabs.length) await captureActiveTabShot(tabs[0].id);
  } catch (e) { /* ignore */ }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  try { delete TAB_SHOTS[String(tabId)]; } catch (e) { /* ignore */ }
});

const URLS = {
  tabClosed:   "https://blocked.gdistrict.org/tab_closed",
  locked:      "https://blocked.gdistrict.org/locked",
  zeroTrust:   "https://blocked.gdistrict.org/Zerotrust",
  teacherBlock:"https://blocked.gdistrict.org/G_schools_Teacher_block",
  blocked:     "https://blocked.gdistrict.org/Gschool%20block"
};

function persistState(){ try{ chrome.storage.local.set({ STATE }); }catch(e){} }
function nowMs(){ return Date.now(); }

// ===================== OAUTH EMAIL (SERVICE WORKER) ======================
function getAccessToken(interactive = false) {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        console.warn("[OAuth] getAuthToken:", chrome.runtime.lastError.message);
        return resolve("");
      }
      resolve(token || "");
    });
  });
}
function revokeCachedToken(token) {
  return new Promise((resolve) => {
    if (!token) return resolve();
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}
async function fetchEmailFromGoogle(token) {
  if (!token) return "";
  try {
    const resp = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: "Bearer " + token }
    });
    if (!resp.ok) return "";
    const data = await resp.json();
    return data?.email || "";
  } catch {
    return "";
  }
}
async function resolveEmailViaOAuth() {
  // silent
  let token = await getAccessToken(false);
  let email = await fetchEmailFromGoogle(token);

  // interactive fallback
  if (!email) {
    if (token) { try { await revokeCachedToken(token); } catch(_){} }
    token = await getAccessToken(true);
    email = await fetchEmailFromGoogle(token);
  }
  return email || "";
}
async function resolveIdentityAndSetState() {
  // Prefer OAuth email from the account that signed in
  let email = await resolveEmailViaOAuth();
  console.log("[Identity] OAuth email:", email || "none");

  // Fallback: Chrome profile identity (managed devices)
  if (!email) {
    const info = await new Promise((resolve) => {
      try {
        chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }, (data) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(data);
        });
      } catch (_) { resolve(null); }
    });
    email = info?.email || "";
    console.log("[Identity] Fallback profile email:", email || "none");
  }

  if (email) {
    STATE.studentId = email;
    STATE.studentName = email.split("@")[0].replace(/[._]+/g, " ");
    persistState();
    return true;
  }

  // No identity → leave defaults
  return false;
}
// ========================================================================

chrome.storage.local.get(["STATE"], async (res)=>{
  if(res && res.STATE) Object.assign(STATE, res.STATE);
  persistState();

  // Resolve identity at startup (OAuth-first)
  const ok = await resolveIdentityAndSetState();

  // Optional: restrict to organization
  if (ok && !STATE.studentId.endsWith("@gdistrict.org")) {
    console.warn("[Identity] Non-Gdistrict account blocked:", STATE.studentId);
    try {
      chrome.action.setPopup({ popup: "" });
      chrome.action.setIcon({
        path: { "16":"icons/disabled_16.png","48":"icons/disabled_48.png","128":"icons/disabled_128.png" }
      });
      STATE.backendBase = "";
      persistState();
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/disabled_48.png",
        title: "Extension Disabled",
        message: "This extension only works with subscribed users' accounts."
      });
    } catch(e){}
  } else {
    // kick off loops regardless; identity will be present if OAuth/profile succeeded
    startLoops();
  }
});

async function showNotification(title, message, require=true){
  try{
    const id = "gschool-"+String(Date.now());
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icons/128.png",
      title: title||"G School",
      message: message||"",
      requireInteraction: !!require,
      priority: 2
    });
    return id;
  }catch(e){}
  return null;
}

function startLoops(){
  (async function loop(){
    try{ await syncPolicy(); }catch(e){}
    try{ await pullCommands(); }catch(e){}
    setTimeout(loop, 5000);
  })();
  (async function loop2(){
    try{ await heartbeat(); }catch(e){}
    setTimeout(loop2, 8000);
  })();
}

chrome.runtime.onMessage.addListener((msg,sender,send)=>{
  if(!msg) return;
  if(msg.type==="SET_BASE"){ STATE.backendBase=msg.base||STATE.backendBase; persistState(); send&&send({ok:true}); }
  if(msg.type==="SET_STUDENT_ID"){ STATE.studentId=msg.studentId||STATE.studentId; persistState(); send&&send({ok:true}); }
  if(msg.type==="CHAT_ENABLED"){ STATE.chat_enabled=!!msg.enabled; persistState(); }
  if(msg.type==="ANNOUNCE_DISMISSED" && msg.message){
    chrome.storage.local.get("dismissedAnnouncements",res=>{
      const dismissed=res.dismissedAnnouncements||{}; dismissed[msg.message]=true;
      chrome.storage.local.set({dismissedAnnouncements:dismissed});
    });
  }
  if(msg.type === "POLL_ANSWER"){
    (async () => {
      try{
        await fetch(`${STATE.backendBase}/api/poll_response`, {
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body: JSON.stringify({poll_id: msg.id, answer: msg.answer, student: STATE.studentId||""})
        });
      }catch(e){}
    })();
    send && send({ok:true});
  }


  if (msg.type === "GSCHOOLS_BYPASS_ATTEMPT") {
    (async () => {
      try {
        const detail = msg.detail || {};
        const code = detail.code || "";
        const origUrl = detail.url || "";
        if (!code || !origUrl) {
          send && send({ ok: false, error: "missing" });
          return;
        }
        const base = STATE.backendBase || "https://gschool.gdistrict.org";
        const r = await fetch(`${base}/api/bypass`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            url: origUrl,
            user: STATE.studentId || detail.user || ""
          })
        });
        if (!r.ok) {
          send && send({ ok: false });
          return;
        }
        const jr = await r.json();
        const allowed = !!(jr && jr.ok && jr.allow);
        if (allowed) {
          // mark URL as bypassed for future checks
          STATE.bypass_urls = STATE.bypass_urls || {};
          STATE.bypass_urls[origUrl] = Date.now();
          // redirect this tab back to the original URL
          try {
            if (sender && sender.tab && sender.tab.id) {
              chrome.tabs.update(sender.tab.id, { url: origUrl });
            }
          } catch (e) {}
        }
        send && send({ ok: allowed });
      } catch (e) {
        send && send({ ok: false });
      }
    })();
    return true; // async
  }

  // Allow UI to explicitly re-run OAuth sign-in
  if (msg.type === "GOOGLE_SIGN_IN") {
    (async () => {
      const ok = await resolveIdentityAndSetState();
      send && send({ ok, email: STATE.studentId || "" });
    })();
    return true; // keep channel open
  }
});

async function syncPolicy(){
  const r = await fetch(`${STATE.backendBase}/api/policy`, {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({student: STATE.studentId||""})
  });
  if(!r.ok) return;
  const j = await r.json();

  Object.assign(STATE, {
    paused: !!j.paused,
    focusMode: !!j.focus_mode,
    categories: j.categories || {},
    blocked_redirect: j.blocked_redirect || STATE.blocked_redirect || URLS.teacherBlock,
    allowlist: j.allowlist || [],
    teacher_blocks: j.teacher_blocks || [],
    chat_enabled: !!j.chat_enabled,
    classInfo: j["class"] || STATE.classInfo,
    bypass_enabled: !!j.bypass_enabled,
    bypass_ttl_minutes: (typeof j.bypass_ttl_minutes === "number" ? j.bypass_ttl_minutes : 10),
    activePolicyId: j.active_policy && j.active_policy.id,
    activePolicyName: j.active_policy && j.active_policy.name,
    activePolicy: j.active_policy || null,
    activePolicyBlockedCategories: (j.active_policy && j.active_policy.blocked_categories) || []
  });;

  // Handle any one-shot pending per-student actions (open_tabs, restore_tabs, close_tabs, etc.)
  const pending = Array.isArray(j.pending) ? j.pending : [];
  for(const item of pending){
    if(!item || !item.type) continue;
    if(item.type==="open_tabs" && Array.isArray(item.urls) && item.urls.length){
      for(const u of item.urls){
        try{ chrome.tabs.create({url:String(u), active:false}); }catch(e){}
      }
      continue;
    }
    if(item.type==="restore_tabs"){
      chrome.storage.local.get(["gschool_savedTabs","gschool_pauseStartedAt"], (res)=>{
        const savedTabs=res.gschool_savedTabs||[];
        const pausedAt=res.gschool_pauseStartedAt||0;
        const withinHour=(nowMs()-pausedAt) <= 60*60*1000;
        if(savedTabs.length && withinHour){
          for(const t of savedTabs){
            try{ chrome.tabs.create({url:t.url, pinned:!!t.pinned, active:!!t.active}); }catch(e){}
          }
        }
        chrome.storage.local.remove(["gschool_savedTabs","gschool_pauseStartedAt"]);
      });
      continue;
    }
    if(item.type==="close_tabs"){
      chrome.tabs.query({url:["http://*/*","https://*/*"]}, (tabs)=>{
        for(const t of tabs){
          if(!t.url) continue;
          if(t.url.startsWith("chrome://")) continue;
          try{ chrome.tabs.remove(t.id); }catch(e){}
        }
      });
      continue;
    }
  }

  // scenes current is surfaced at j.scenes.current; no local storage needed here
  persistState();

  try{
    const prev = (await chrome.storage.local.get("gschool_lastActive")).gschool_lastActive;
    const cur = !!(STATE.classInfo && STATE.classInfo.active);
    if(cur && !prev){
      await showNotification("Class session is active", "Please open your class tab now. Stay until dismissed.", true);
    }
    await chrome.storage.local.set({gschool_lastActive: cur});
  }catch(e){}

  // Update DNR rules
  await applyRules();

  // NEW: enforce blocking on already-open tabs
  try {
    await enforceBlockingOnExistingTabs();
  } catch(e) {
    console.warn("enforceBlockingOnExistingTabs error", e);
  }

  // Broadcast updated policy + scenes to all existing tabs so content scripts can re-apply UI
  try{
    chrome.tabs.query({url:["http://*/*","https://*/*"]}, (tabs)=>{
      for(const t of tabs){
        try{ chrome.tabs.sendMessage(t.id, {type:"POLICY_PUSH", policy:j, scenes:j.scenes||null}); }catch(e){}
      }
    });
  }catch(e){}

  if(j.announcement){ handleAnnouncementOnce(j.announcement); }

  if(STATE.paused){
    if(!STATE.lockApplied){
      STATE.lockApplied = true; persistState();
      chrome.tabs.query({url:["http://*/*","https://*/*"]}, (tabs)=>{
        const filtered = tabs.filter(t=>!t.url.startsWith("chrome://") && !includesBlockedHost(t.url));
        const savedTabs = filtered.map(t=>({ url: t.url, pinned: !!t.pinned, active: !!t.active }));
        chrome.storage.local.set({ gschool_savedTabs: savedTabs, gschool_pauseStartedAt: nowMs() });
        try{ chrome.tabs.remove(filtered.map(t=>t.id)); }catch(e){}
        chrome.tabs.create({url: URLS.locked, active:true});
      });
    } else {
      chrome.tabs.query({url:["http://*/*","https://*/*"]}, (tabs)=>{
        for(const t of tabs){ if(!includesBlockedHost(t.url)){ try{ chrome.tabs.remove(t.id); }catch(e){} } }
      });
      chrome.tabs.query({url:[URLS.locked]}, (existing)=>{ if(!(existing && existing.length)){ chrome.tabs.create({url: URLS.locked, active:true}); } });
    }
  } else {
    if(STATE.lockApplied){
      STATE.lockApplied=false; persistState();
      chrome.tabs.query({url:[URLS.locked]}, (lockeds)=>{ if(lockeds && lockeds.length){ try{ chrome.tabs.remove(lockeds.map(t=>t.id)); }catch(e){} } });
      chrome.storage.local.get(["gschool_savedTabs","gschool_pauseStartedAt"], (res)=>{
        const savedTabs=res.gschool_savedTabs||[]; const pausedAt=res.gschool_pauseStartedAt||0;
        const withinHour=(nowMs()-pausedAt) <= 60*60*1000;
        if(savedTabs.length && withinHour){
          for(const t of savedTabs){ try{ chrome.tabs.create({url:t.url, pinned:!!t.pinned, active:!!t.active}); }catch(e){} }
        }
        chrome.storage.local.remove(["gschool_savedTabs","gschool_pauseStartedAt"]);
      });
    }
  }
}

async function pullCommands(){
  if(!STATE.studentId) return;
  const r = await fetch(`${STATE.backendBase}/api/commands/${encodeURIComponent(STATE.studentId)}`);
  if(!r.ok) return;
  const j = await r.json();

  for(const cmd of (j.commands||[])){
    if(cmd.type==="notify" && (cmd.title||cmd.message)){
      await showNotification(cmd.title||"G School", String(cmd.message||""), true);
      continue;
    }
    if(cmd.type==="announce" && (cmd.message||cmd.title)){
      const msg = String(cmd.message || cmd.title || "");
      try{ handleAnnouncementOnce(msg); }catch(e){}
      continue;
    }
    if(cmd.type==="poll"){
      chrome.tabs.query({url:["http://*/*","https://*/*"]}, (tabs)=>{
        for(const t of tabs){
          try{ chrome.tabs.sendMessage(t.id, {type:"POLL", id:cmd.id, question:cmd.question, options:cmd.options}); }
          catch(e){}
        }
      });
      continue;
    }
    if(cmd.type==="exam_start" && cmd.url){
      STATE.examMode = true; STATE.examUrl = String(cmd.url); persistState();
      chrome.tabs.query({url:["http://*/*","https://*/*"]}, (tabs)=>{
        const filtered = tabs.filter(t=>!t.url.startsWith("chrome://") && !includesBlockedHost(t.url));
        const savedTabs = filtered.map(t=>({ url: t.url, pinned: !!t.pinned, active: !!t.active }));
        chrome.storage.local.set({ gschool_examSavedTabs: savedTabs, gschool_examStartedAt: nowMs() });
        try{ chrome.tabs.remove(filtered.map(t=>t.id)); }catch(e){}
        chrome.tabs.create({url: STATE.examUrl, active:true}, (tab)=>{
          if(!tab) return;
          setTimeout(()=>{
            try{
              chrome.scripting.executeScript({
                target:{tabId: tab.id},
                func: ()=>{
                  const ensureBottomBanner = ()=>{
                    if(!document.getElementById("gschool-exam-banner")){
                      const b=document.createElement('div'); b.id="gschool-exam-banner";
                      Object.assign(b.style,{position:"fixed",bottom:"0",left:"0",right:"0",padding:"6px",background:"#111",color:"#fff",textAlign:"center",fontSize:"14px",zIndex:"2147483647",fontFamily:"system-ui,sans-serif"});
                      b.textContent="Exam Mode — do not close this tab"; document.body.appendChild(b);
                    }
                  };
                  if(!document.getElementById("gschool-exam-overlay")){
                    const overlay = document.createElement("div"); overlay.id = "gschool-exam-overlay";
                    Object.assign(overlay.style,{position:"fixed",top:0,left:0,width:"100%",height:"100%",background:"#000",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",zIndex:"2147483647",fontFamily:"system-ui,sans-serif"});
                    const msg = document.createElement("div"); msg.textContent = "Click to start your exam in fullscreen"; msg.style.marginBottom = "16px";
                    const btn = document.createElement("button"); btn.textContent = "Start Exam";
                    Object.assign(btn.style,{padding:"12px 24px",fontSize:"16px",border:"none",borderRadius:"8px",background:"#0b57d0",color:"#fff",cursor:"pointer"});
                    btn.onclick = async ()=>{
                      try{ await document.documentElement.requestFullscreen(); }catch(e){}
                      overlay.remove(); ensureBottomBanner();
                      document.addEventListener("fullscreenchange", ()=>{ if(!document.fullscreenElement){ setTimeout(()=>{ document.documentElement.requestFullscreen().catch(()=>{}); }, 500); } }, {passive:true});
                    };
                    overlay.appendChild(msg); overlay.appendChild(btn); document.body.appendChild(overlay);
                  } else { ensureBottomBanner(); }
                }
              });
            }catch(e){}
          }, 500);
        });
      });
      await applyRules(); continue;
    }
    if(cmd.type==="exam_end"){
      STATE.examMode=false; STATE.examUrl=""; persistState();
      chrome.tabs.query({}, (tabs)=>{
        for(const t of tabs){
          try{
            chrome.scripting.executeScript({target:{tabId: t.id},func: ()=>{
              if(document.fullscreenElement){ try{ document.exitFullscreen(); }catch(e){} }
              const b=document.getElementById("gschool-exam-banner"); if(b) b.remove();
              const o=document.getElementById("gschool-exam-overlay"); if(o) o.remove();
            }});
          }catch(e){}
        }
      });
      chrome.tabs.query({url:["http://*/*","https://*/*"]}, (tabs)=>{
        for(const t of tabs){ if(t.url && t.url.startsWith("http") && !includesBlockedHost(t.url)){ try{ chrome.tabs.remove(t.id); }catch(e){} } }
      });
      chrome.storage.local.get(["gschool_examSavedTabs","gschool_examStartedAt"], (res)=>{
        const savedTabs=res.gschool_examSavedTabs||[]; const startedAt=res.gschool_examStartedAt||0; const within2h=(nowMs()-startedAt)<=2*60*60*1000;
        if(savedTabs.length && within2h){ for(const t of savedTabs){ try{ chrome.tabs.create({url:t.url, pinned:!!t.pinned, active:!!t.active}); }catch(e){} } }
        chrome.storage.local.remove(["gschool_examSavedTabs","gschool_examStartedAt"]);
      });
      await applyRules(); continue;
    }
    if(cmd.type==="close_tabs" && cmd.pattern){
      chrome.tabs.query({}, (tabs)=>{ for(const t of tabs){ if(matchPatternSafe(t.url, cmd.pattern)){ chrome.tabs.update(t.id, {url: URLS.tabClosed}); } } });
      continue;
    }
    if (cmd.type === "screencap" && cmd.tabId) {
      try {
        chrome.tabs.update(cmd.tabId, { active: true }, () => {
          setTimeout(async () => {
            try {
              const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
              TAB_SHOTS[String(cmd.tabId)] = dataUrl;
              const pl = { student: STATE.studentId || "", tabshots: { [String(cmd.tabId)]: dataUrl } };
              await fetch(`${STATE.backendBase}/api/heartbeat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(pl)
              });
            } catch (e) {}
          }, 300);
        });
      } catch (e) {}
      continue;
    }
    if(cmd.type==="open_tabs" && Array.isArray(cmd.urls) && cmd.urls.length){
      for(const u of cmd.urls){ try{ chrome.tabs.create({url:String(u), active:false}); }catch(e){} }
      continue;
    }
  }
}

async function applyRules(){
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if(existing.length){ await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds: existing.map(r=>r.id)}); }
  let id=1; const rules=[];
  const add=(pattern,url)=>rules.push({ id:id++, priority:1, action:{type:"redirect", redirect:{url}}, condition:{urlFilter:pattern, resourceTypes:["main_frame"]} });

  const ALWAYS_ALLOW="blocked.gdistrict.org";

  if(STATE.examMode && STATE.examUrl){
    let examHosts=[];
    try{ const u=new URL(STATE.examUrl); const host=u.hostname||""; if(host){ const parts=host.split("."); const variants=new Set([host]); if(parts.length>=2){ variants.add(parts.slice(-2).join(".")); } examHosts=Array.from(variants); } }catch(e){}
    const excluded=[...examHosts]; if(!excluded.includes(ALWAYS_ALLOW)) excluded.push(ALWAYS_ALLOW);
    rules.push({ id:id++, priority:1, action:{type:"redirect", redirect:{url: URLS.zeroTrust}}, condition:{urlFilter:"|http*", resourceTypes:["main_frame"], excludedRequestDomains: excluded } });
  } else if(STATE.paused){
    rules.push({ id:id++, priority:1, action:{type:"redirect", redirect:{url:URLS.locked}}, condition:{urlFilter:"|http*", resourceTypes:["main_frame"]} });
  } else if(STATE.focusMode){
    const allowed=[];
    for(const patt of (STATE.allowlist||[])){ const host=patternToHost(patt); if(host) allowed.push(host); }
    if(!allowed.includes(ALWAYS_ALLOW)) allowed.push(ALWAYS_ALLOW);
    rules.push({ id:id++, priority:1, action:{type:"redirect", redirect:{url: URLS.zeroTrust}}, condition:{urlFilter:"|http*", resourceTypes:["main_frame"], excludedRequestDomains: allowed} });
    // teacher_blocks handled by enforceBlockingOnExistingTabs; no DNR rule here.

  } else {
    // teacher_blocks handled by enforceBlockingOnExistingTabs; no DNR rule here.

    // category-based blocks handled by enforceBlockingOnExistingTabs; no DNR rule here.

  }
  if(rules.length){ await chrome.declarativeNetRequest.updateDynamicRules({addRules: rules}); }
}

async function enforceBlockingOnExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    const ALWAYS_ALLOW = "blocked.gdistrict.org";

    // Precompute exam and focus allowlists like applyRules
    let examHosts = [];
    if (STATE.examMode && STATE.examUrl) {
      try {
        const u = new URL(STATE.examUrl);
        const host = u.hostname || "";
        if (host) {
          const parts = host.split(".");
          const variants = new Set([host]);
          if (parts.length >= 2) {
            variants.add(parts.slice(-2).join("."));
          }
          examHosts = Array.from(variants);
        }
      } catch (e) {}
    }

    let allowedHosts = [];
    if (STATE.focusMode) {
      const allowed = [];
      for (const patt of (STATE.allowlist || [])) {
      const host = patternToHost(patt);
      if (host) allowed.push(host);
    }
      if (!allowed.includes(ALWAYS_ALLOW)) allowed.push(ALWAYS_ALLOW);
      allowedHosts = allowed;
    }

    outer: for (const t of tabs) {
      const url = t.url || "";
      if (!url || !/^https?:/.test(url)) continue;
      if (STATE.bypass_urls && STATE.bypass_urls[url]) {
        try {
          const ts = STATE.bypass_urls[url];
          const mins = (typeof STATE.bypass_ttl_minutes === "number" ? STATE.bypass_ttl_minutes : 10);
          const TTL = mins * 60 * 1000;
          if (typeof ts === "number" && (Date.now() - ts) < TTL) continue;
        } catch (e) {}
      }

      let host = "";
      let hostBase = "";
      try {
        const u = new URL(url);
        host = u.hostname || "";
        const parts = host.split(".");
        hostBase = parts.length >= 2 ? parts.slice(-2).join(".") : host;
      } catch (e) {
        continue;
      }

      // Exam mode: only exam host(s) and ALWAYS_ALLOW are allowed
      if (STATE.examMode && STATE.examUrl) {
        const allowedExam =
          examHosts.includes(host) ||
          examHosts.includes(hostBase) ||
          host === ALWAYS_ALLOW ||
          hostBase === ALWAYS_ALLOW;
        if (!allowedExam) {
          try { chrome.tabs.update(t.id, { url: URLS.zeroTrust }); } catch (e) {}
          continue;
        }
      } else if (STATE.paused) {
        try { chrome.tabs.update(t.id, { url: URLS.locked }); } catch (e) {}
        continue;
      } else if (STATE.focusMode) {
        const allowedFocus =
          allowedHosts.includes(host) ||
          allowedHosts.includes(hostBase) ||
          host === ALWAYS_ALLOW ||
          hostBase === ALWAYS_ALLOW;
        if (!allowedFocus) {
          try { chrome.tabs.update(t.id, { url: URLS.zeroTrust }); } catch (e) {}
          continue;
        }
      }


      // Teacher blocks
      for (const p of (STATE.teacher_blocks || [])) {
        if (p.includes(ALWAYS_ALLOW)) continue;
        if (matchPatternSafe(url, p)) {
          try {
            const q = new URLSearchParams({
              url,
              user: STATE.studentId || ""
            });
            if (STATE && STATE.activePolicyName) {
              q.set("policy", STATE.activePolicyName);
            }
            const target = URLS.teacherBlock + "?" + q.toString();
            chrome.tabs.update(t.id, { url: target });
          } catch (e) {}
          continue outer;
        }
      }

      // Category-based blocks
      for (const [_nm, cat] of Object.entries(STATE.categories || {})) {
        for (const p of (cat.urls || [])) {
          if (p.includes(ALWAYS_ALLOW)) continue;
          if (matchPatternSafe(url, p)) {
            try {
              const base = STATE.blocked_redirect || URLS.blocked || URLS.teacherBlock;
              const categoryName = _nm || (cat && (cat.name || cat.displayName || "")) || "";
              const activePolicyName = (STATE && STATE.activePolicyName) ? STATE.activePolicyName : "";
              let encodedPolicy = "";
              try {
                if (activePolicyName) encodedPolicy = btoa(activePolicyName);
              } catch (e) {}

              const path = (cat && (cat.path || cat.id || "")) || "";
              const qp = new URLSearchParams({
                url,
                user: STATE.studentId || ""
              });
              if (encodedPolicy) {
                qp.set("rule", encodedPolicy);
              }
              if (path) {
                qp.set("path", path);
              }
              if (categoryName) {
                qp.set("cat", categoryName);
              }
              if (activePolicyName) {
                qp.set("policy", activePolicyName);
              }
              if (STATE.bypass_enabled) {
                qp.set("bypass", "1");
              } else {
                qp.set("bypass", "0");
              }

              const target = base + "?" + qp.toString();
              chrome.tabs.update(t.id, { url: target });
            } catch (e) {}
            continue outer;
          }
        }
      }
    }

    // If teacher scene is no longer active, restore any teacher-block page back to its original URL
    try {
      const noTeacherBlocks = !STATE.teacher_blocks || STATE.teacher_blocks.length === 0;
      if (noTeacherBlocks) {
        try {
          const curUrl = url || t.url || "";
          if (curUrl && includesBlockedHost(curUrl) && curUrl.includes("G_schools_Teacher_block")) {
            const u = new URL(curUrl);
            const params = new URLSearchParams(u.search || "");
            const orig = params.get("url");
            if (orig && /^https?:/i.test(orig)) {
              chrome.tabs.update(t.id, { url: orig });
            }
          }
        } catch (e) {}
      }
    } catch (e) {}

  } catch (e) {
    console.warn("enforceBlockingOnExistingTabs failed", e);
  }
}

function includesBlockedHost(url){ try{ return (url||"").includes("blocked.gdistrict.org"); }catch(e){ return false; } }
function matchPatternSafe(url, pattern){
  if(!pattern) return false;
  try{
    const esc = String(pattern).replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("^"+esc+"$","i").test(url||"");
  }catch(e){ return false; }
}
function patternToHost(pattern){
  if(!pattern) return null;
  try{
    let s = String(pattern).trim();
    if(s.startsWith("*://")) s = s.slice(4);
    if(s.startsWith("*.")) s = s.slice(2);
    const slash = s.indexOf("/");
    if(slash !== -1) s = s.slice(0, slash);
    const colon = s.indexOf(":");
    if(colon !== -1) s = s.slice(0, colon);
    s = s.toLowerCase().trim();
    return s || null;
  }catch(e){
    console.warn("[patternToHost] bad pattern", pattern, e);
    return null;
  }
}


function isUrlAllowedByTeacher(url){
  try{
    const patterns = STATE && Array.isArray(STATE.allowlist) ? STATE.allowlist : [];
    if(!patterns.length) return false;
    for(const p of patterns){
      if(matchPatternSafe(url, p)) return true;
    }
  }catch(e){
    console.warn("[Allowlist] error checking allowlist", e);
  }
  return false;
}
async function heartbeat() {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let dataUrl = "";
    try { dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" }); } catch (e) {}

    const allTabs = await chrome.tabs.query({});
    const pl = {
      student: STATE.studentId || "",
      tab: activeTab ? { title: activeTab.title, url: activeTab.url, favicon: activeTab.favIconUrl } : {},
      tabs: allTabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active, favIconUrl: t.favIconUrl })),
      screenshot: dataUrl || "",
      tabshots: (() => {
        const out = {};
        for (const t of allTabs) {
          const k = String(t.id);
          if (TAB_SHOTS[k]) out[k] = TAB_SHOTS[k];
        }
        return out;
      })()
    };

    await fetch(`${STATE.backendBase}/api/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pl)
    });
  } catch(e) {
    // non-fatal
  }
}

function handleAnnouncementOnce(message){
  if(!message) return;
  chrome.storage.local.get(["dismissedAnnouncements","shownAnnouncements"], (res)=>{
    const dismissed = res.dismissedAnnouncements||{}; const shown = res.shownAnnouncements||{};
    if(dismissed[message]) return; if(shown[message]) return;
    chrome.tabs.query({active:true, currentWindow:true}, (tabs)=>{
      if(!tabs || !tabs.length) return; const tabId=tabs[0].id;
      chrome.scripting.executeScript({ target:{tabId}, func:(msg)=>{
          if(document.getElementById("gschool-announcement")) return;
          const banner=document.createElement("div"); banner.id="gschool-announcement"; banner.textContent=msg;
          Object.assign(banner.style,{ position:"fixed", top:"0", left:"0", width:"100%", padding:"10px", background:"#ffec99", color:"#111", fontSize:"18px", textAlign:"center", zIndex:"2147483647", boxShadow:"0 2px 10px rgba(0,0,0,.15)" });
          const closeBtn=document.createElement("span"); closeBtn.textContent=" ✕"; closeBtn.style.marginLeft="12px"; closeBtn.style.cursor="pointer";
          closeBtn.onclick=()=>{ banner.remove(); chrome.runtime.sendMessage({type:"ANNOUNCE_DISMISSED", message: msg}); };
          banner.appendChild(closeBtn); document.documentElement.appendChild(banner);
        }, args:[message] });
      shown[message]=Date.now(); chrome.storage.local.set({shownAnnouncements: shown});
    });
  });
}

// Optional lightweight AI hook: classify and maybe block
async function gscFetchJSON(url, opts){
  try{
    const res = await fetch(url, Object.assign({headers:{"Content-Type":"application/json"}}, opts||{}));
    return await res.json();
  }catch(e){ return {ok:false, error:String(e)}; }
}


async function classifyAndMaybeBlock(tabId, url){
  try{
    // First enforce any non-AI policy rules (teacher blocks, focus/exam/paused, etc.).
    try {
      await enforceBlockingOnExistingTabs();
    } catch (e) {
      console.warn("enforceBlockingOnExistingTabs error", e);
    }

    // If URL is explicitly allowed by teacher/policy, do not AI-block it.
    if (isUrlAllowedByTeacher(url)) return;

    // We need an active policy with blocked_categories to do AI-based blocking.
    const policy = STATE.activePolicy || null;
    const blockedCats = (policy && Array.isArray(policy.blocked_categories))
      ? policy.blocked_categories
      : (STATE.activePolicyBlockedCategories || []);
    if (!blockedCats || !blockedCats.length) return;

    const baseApi = (STATE && STATE.backendBase) ? STATE.backendBase : "https://gschool.gdistrict.org";
    const resp = await gscFetchJSON(baseApi + "/api/ai/classify", {
      method: "POST",
      body: JSON.stringify({ url })
    });
    if (!resp || !resp.ok || !resp.result) return;

    const result = resp.result || {};
    const cats = [];
    if (result.category) cats.push(result.category);
    if (Array.isArray(result.categories)) {
      for (const c of result.categories) cats.push(c);
    }

    if (!cats.length) return;

    const blockSet = new Set(
      blockedCats
        .filter(Boolean)
        .map(c => String(c).trim().toLowerCase())
    );

    let matchedCat = "";
    for (const c of cats) {
      const key = String(c || "").trim().toLowerCase();
      if (blockSet.has(key)) {
        matchedCat = c;
        break;
      }
    }

    if (!matchedCat) return;

    // Build a block URL similar to manual category/teacher blocks.
    const base = STATE.blocked_redirect || URLS.blocked || URLS.teacherBlock;
    const policyName = STATE.activePolicyName || (policy && policy.name) || "";
    let encodedRule = "";
    try {
      if (policyName) encodedRule = btoa(policyName);
    } catch (e) {}

    const qp = new URLSearchParams({
      url: url || "",
      user: STATE.studentId || ""
    });
    if (encodedRule) qp.set("rule", encodedRule);
    if (matchedCat) qp.set("cat", matchedCat);
    if (policyName) qp.set("policy", policyName);
    qp.set("source", "ai_category");
    qp.set("bypass", STATE.bypass_enabled ? "1" : "0");

    const target = base + "?" + qp.toString();
    chrome.tabs.update(tabId, { url: target });
  } catch (e) {
    console.warn("classifyAndMaybeBlock(policy+AI) error", e);
  }
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab)=>{
  if(changeInfo.status === "loading" && tab && tab.url && /^https?:/.test(tab.url) && !includesBlockedHost(tab.url)){
    let skipClassify = false;
    if (STATE.bypass_urls && STATE.bypass_urls[tab.url]) {
      try {
        const ts = STATE.bypass_urls[tab.url];
        const mins = (typeof STATE.bypass_ttl_minutes === "number" ? STATE.bypass_ttl_minutes : 10);
        const TTL = mins * 60 * 1000;
        if (typeof ts === "number" && (Date.now() - ts) < TTL) {
          skipClassify = true;
        }
      } catch (e) {}
    }
    if (!skipClassify) {
      classifyAndMaybeBlock(tabId, tab.url);
    }
  }
});


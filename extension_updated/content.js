// ===== Exam Bootstrap Overlay (only for active exam tab) =====
(async () => {
  try {
    // Wait for stored exam state
    const res = await chrome.storage.local.get(["examActive", "examUrl"]);
    const active = !!res.examActive;
    const examUrl = res.examUrl || "";

    // Only show if this tab URL matches the pushed exam URL
    if (!active || !location.href.startsWith(examUrl)) return;

    // Create overlay
    const overlay = document.createElement("div");
    overlay.id = "examBootstrapOverlay";
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(0,0,0,0.88)",
      color: "#fff",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "2147483647",
      fontFamily: "system-ui,sans-serif",
      fontSize: "18px",
      transition: "opacity .4s ease"
    });
    overlay.innerHTML = `
      <div style="text-align:center;max-width:480px;">
        <h2 style="margin-bottom:10px;">Exam Mode Initializing…</h2>
        <p>Preparing your secure exam environment.<br>Please do not close this tab.</p>
      </div>`;
    document.documentElement.appendChild(overlay);

    // Auto-remove after 15s or if exam mode turns off
    const cleanup = () => {
      overlay.style.opacity = "0";
      setTimeout(() => overlay.remove(), 400);
    };
    setTimeout(cleanup, 15000);

    // Expose manual removal
    window.__removeExamBootstrap = cleanup;

    // If exam mode deactivates, remove immediately
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.examActive && changes.examActive.newValue === false) cleanup();
    });
  } catch (e) {
    console.warn("[Exam Bootstrap] Error:", e);
  }
})();


// unblock overlay page during exam start
if (window.location.href.includes("exam_mode_ready")) {
  chrome.runtime.sendMessage({ type: "EXAM_READY" });
}


// Try to get student email cached by service worker
chrome.storage?.local?.get?.(["STATE"], (res)=>{ 
  if(res && res.STATE){ window.STATE_EMAIL = res.STATE.studentId || ""; }
});

// v11 content script: chat bubble on <all_urls>, only when enabled
let BACKEND = "https://gschool.gdistrict.org";
let CHAT_ENABLED = false;
let pollTimer = null;

// --- Scene / policy re-application for existing pages ---
function applyPolicyToPage(payload){
  if(!payload) return;
  const policy = payload.policy || {};
  const scenes = payload.scenes || null;

  // chat_enabled from policy
  if(Object.prototype.hasOwnProperty.call(policy,"chat_enabled")){
    CHAT_ENABLED = !!policy.chat_enabled;
    if(CHAT_ENABLED) ensureIcon();
    else {
      const i=$("chatIcon"); if(i) i.remove();
      const w=$("chatBubble"); if(w) w.remove();
    }
  }

  let currentScenes = null;
  if(scenes){
    if(Array.isArray(scenes.current)){
      currentScenes = scenes.current.slice();
    } else if(scenes.current){
      currentScenes = [scenes.current];
    } else if(Array.isArray(scenes)){
      currentScenes = scenes.slice();
    } else {
      currentScenes = [scenes];
    }
  }

  if(currentScenes && currentScenes.length){
    let doodleOn = false;
    for(const sc of currentScenes){
      if(!sc) continue;
      if(Object.prototype.hasOwnProperty.call(sc,"doodle_block") && sc.doodle_block){
        doodleOn = true;
        break;
      }
    }
    if(doodleOn){
      if(typeof window.__gschoolStartDoodleBlock==="function"){
        window.__gschoolStartDoodleBlock();
      }
    } else {
      if(typeof window.__gschoolStopDoodleBlock==="function"){
        window.__gschoolStopDoodleBlock();
      }
    }
    // additional per-scene behaviors can be added here in future
  }
}

function $(id){ return document.getElementById(id); }

function ensureIcon(){
  if(!CHAT_ENABLED){
    const i=$("chatIcon"); if(i) i.remove();
    const w=$("chatBubble"); if(w) w.remove();
    return;
  }
  if($("chatIcon")) return;
  const icon=document.createElement("div"); icon.id="chatIcon";
  Object.assign(icon.style,{
    position:"fixed", right:"20px", bottom:"20px",
    width:"60px", height:"60px", cursor:"pointer",
    borderRadius:"50%", boxShadow:"0 6px 16px rgba(0,0,0,.3)", zIndex:"2147483647",
    backgroundImage:`url(${chrome.runtime.getURL("bubble-icon.png")})`,
    backgroundSize:"contain", backgroundPosition:"center", backgroundRepeat:"no-repeat"
  });
  icon.addEventListener("click", ()=>{
    if($("chatBubble")){
      $("chatBubble").remove();
      if(pollTimer){ clearInterval(pollTimer); pollTimer=null; }
    } else {
      openChat();
    }
  });
  document.documentElement.appendChild(icon);
  console.log("v11: chat bubble injected on", location.href);
}

function openChat(){
  const w=document.createElement("div"); w.id="chatBubble";
  Object.assign(w.style,{
    position:"fixed", right:"20px", bottom:"90px",
    width:"350px", height:"400px", background:"#fff",
    border:"1px solid #ccc", boxShadow:"0 10px 24px rgba(0,0,0,.35)",
    borderRadius:"12px", zIndex:"2147483647",
    display:"flex", flexDirection:"column"
  });

  const h=document.createElement("div");
  h.style.display="flex"; h.style.alignItems="center";
  h.style.justifyContent="space-between"; h.style.padding="8px 10px";
  h.style.background="#f3f3f3";
  h.style.borderTopLeftRadius="12px"; h.style.borderTopRightRadius="12px";
  const hTitle=document.createElement("span");
  hTitle.textContent="Class Chat"; hTitle.style.fontWeight="700";

  const handBtn=document.createElement("button");
  handBtn.textContent="✋ Raise hand";
  Object.assign(handBtn.style,{
    padding:"6px 10px", border:"1px solid #ddd",
    borderRadius:"10px", background:"#fff",
    cursor:"pointer", fontSize:"12px"
  });
  handBtn.onclick=async()=>{
    try{
      const note=prompt("Optional note for teacher:")||"";
      await fetch(BACKEND+"/api/raise_hand",{
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({student:(window.STATE_EMAIL||""), note})
      });
      alert("Hand raised");
    }catch(e){}
  };

  h.appendChild(hTitle); h.appendChild(handBtn);

  const msgs=document.createElement("div"); msgs.id="chatMsgs";
  Object.assign(msgs.style,{
    flex:"1", overflow:"auto", padding:"8px",
    fontFamily:"system-ui,sans-serif", fontSize:"13px"
  });

  const f=document.createElement("div");
  Object.assign(f.style,{display:"flex",gap:"6px",padding:"8px"});
  const inp=document.createElement("input");
  inp.id="chatInput"; inp.placeholder="Type a message...";
  Object.assign(inp.style,{
    flex:"1", padding:"8px", border:"1px solid #ddd", borderRadius:"10px"
  });
  const send=document.createElement("button"); send.textContent="Send";
  Object.assign(send.style,{
    padding:"8px 12px", border:"1px solid #ddd",
    borderRadius:"10px", background:"#fff"
  });
  send.onclick=sendChat;
  inp.addEventListener("keydown",e=>{ if(e.key==="Enter") sendChat(); });
  f.appendChild(inp); f.appendChild(send);

  w.appendChild(h); w.appendChild(msgs); w.appendChild(f);
  document.documentElement.appendChild(w);

  loadMsgs(true);
  pollTimer=setInterval(()=>{
    if($("chatBubble")) loadMsgs(true);
    else { clearInterval(pollTimer); pollTimer=null; }
  }, 4000);
}

async function loadMsgs(scroll){
  try{
    if(!window.STATE_EMAIL) return;
    const r=await fetch(BACKEND+"/api/dm/me?student="+encodeURIComponent(window.STATE_EMAIL));
    if(!r.ok) return;
    const j=await r.json();

    CHAT_ENABLED = true; // if /api/dm/me worked
    ensureIcon();

    const wrap=$("chatMsgs");
    if(!wrap) return;
    wrap.innerHTML="";

    for(const m of j){
      const me=(m.from==="student");
      const row=document.createElement("div");
      Object.assign(row.style,{
        display:"flex", margin:"6px 0", justifyContent:me?"flex-end":"flex-start"
      });
      const bub=document.createElement("div");
      bub.textContent=m.text||"";
      Object.assign(bub.style,{
        maxWidth:"70%", padding:"8px 10px", borderRadius:"14px",
        lineHeight:"1.25", wordBreak:"break-word",
        background:me?"#0b57d0":"#f0f1f5", color:me?"#fff":"#000"
      });
      row.appendChild(bub);
      wrap.appendChild(row);
    }
    if(scroll) wrap.scrollTop = wrap.scrollHeight;
  }catch(e){
    console.error("loadMsgs error", e);
  }
}

async function sendChat(){
  const el=$("chatInput");
  if(!el) return;
  const text=el.value.trim();
  if(!text) return;
  el.value="";
  try{
    await fetch(BACKEND+"/api/dm/send",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        from:"student",
        student: window.STATE_EMAIL || "me",
        text
      })
    });
    await loadMsgs(true);
  }catch(e){
    console.error("sendChat error", e);
  }
}

// Init backend base
chrome.storage?.local?.get?.(["STATE"], res=>{
  if(res && res.STATE && res.STATE.backendBase) BACKEND=res.STATE.backendBase;
});

// Respect teacher toggle for this chat (legacy endpoint)
(async()=>{
  try{
    const r=await fetch(BACKEND+"/api/chat/period1");
    if(r.ok){
      const j=await r.json();
      CHAT_ENABLED=!!j.enabled;
      if(CHAT_ENABLED) ensureIcon();
    }
  }catch(e){}
})();

// Reflect runtime toggle from SW
chrome.runtime.onMessage.addListener((m)=>{
  if(!m) return;
  if(m.type==="CHAT_ENABLED"){
    CHAT_ENABLED=!!m.enabled;
    if(CHAT_ENABLED) ensureIcon();
    else {
      const i=$("chatIcon"); if(i) i.remove();
      const w=$("chatBubble"); if(w) w.remove();
    }
  }
});
chrome.runtime.onMessage.addListener((m)=>{
  if(!m) return;
  if(m.type==="POLICY_PUSH"){
    applyPolicyToPage({policy:m.policy, scenes:m.scenes});
  }
});



// ---------- Google Doodles / Games blocker ----------
(async function(){
  let doodleObserver = null;

  async function isDoodleBlockingEnabled(){
    try{
      let base = BACKEND;
      if(!base){
        const r = await chrome.storage.local.get(["STATE"]);
        base = r.STATE?.backendBase || "https://gschool.gdistrict.org";
      }
      const res = await fetch(`${base}/api/doodle_block`);
      if(!res.ok) return false;
      const j = await res.json();
      return !!j.enabled;
    }catch(e){
      console.warn("Could not check doodle block state", e);
      return false;
    }
  }

  function blockGoogleDoodles(){
    document.querySelectorAll("div.xpdopen").forEach(box=>{
      const text = (box.innerText||"").toLowerCase();
      if(text.includes("doodle") || text.includes("game")){
        box.style.display="none";
      }
    });
    document.querySelectorAll('iframe[src*="google.com/doodles/"]').forEach(iframe=>{
      if(!iframe.dataset.blocked){
        iframe.dataset.blocked="true";
        iframe.style.display="none";
        const overlay=document.createElement("div");
        overlay.style.cssText="position:absolute;top:0;left:0;width:100%;height:100%;background:black;color:white;display:flex;align-items:center;justify-content:center;font-size:20px;z-index:999999;";
        overlay.textContent="🚫 This Google Doodle is blocked by your teacher.";
        if(iframe.parentElement){
          iframe.parentElement.style.position="relative";
          iframe.parentElement.appendChild(overlay);
        }
      }
    });
  }

  function startDoodleBlocker(){
    if(doodleObserver) return;
    blockGoogleDoodles();
    doodleObserver = new MutationObserver(blockGoogleDoodles);
    doodleObserver.observe(document.body, {childList:true, subtree:true});
  }

  function stopDoodleBlocker(){
    if(doodleObserver){
      doodleObserver.disconnect();
      doodleObserver = null;
    }
  }

  // expose for scenes / POLICY_PUSH
  window.__gschoolStartDoodleBlock = startDoodleBlocker;
  window.__gschoolStopDoodleBlock = stopDoodleBlocker;

  // legacy behavior: obey /api/doodle_block on first load
  if(await isDoodleBlockingEnabled()){
    startDoodleBlocker();
  }
})();

// ---------- Attention Check overlay ----------
function showAttentionCheck(cmd) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:999999;display:flex;align-items:center;justify-content:center";
  const card = document.createElement("div");
  card.style.cssText = "background:#fff;padding:20px;border-radius:10px;text-align:center;font-size:18px;max-width:400px";
  card.innerHTML = `<p>${cmd.title || "Are you here?"}</p>`;
  const yes = document.createElement("button");
  yes.textContent = "✅ I'm here";
  yes.style.cssText = "margin-top:12px;padding:8px 16px;font-size:16px;background:#0b57d0;color:white;border:none;border-radius:8px;cursor:pointer";
  yes.onclick = async () => {
    try {
      await fetch(`${BACKEND}/api/attention_response`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ student: (window.STATE_EMAIL || "me"), response: "yes" })
      });
    } catch (e) {
      console.warn("Failed to send attention response", e);
    }
    wrap.remove();
  };
  card.appendChild(yes);
  wrap.appendChild(card);
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), (cmd.timeout || 30) * 1000);
}

// ---------- Announcement ----------
function __gschool_announce_once(message){
  if(!message) return;
  if(document.getElementById("gschool-announcement")) return;
  const banner = document.createElement("div");
  banner.id = "gschool-announcement";
  banner.textContent = message;
  banner.style.cssText = "position:fixed;top:0;left:0;width:100%;padding:10px;background:#fffa65;color:black;font-size:16px;text-align:center;z-index:2147483647";
  const closeBtn = document.createElement("span");
  closeBtn.textContent = " ✕";
  closeBtn.style.marginLeft = "12px";
  closeBtn.style.cursor = "pointer";
  closeBtn.onclick = () => banner.remove();
  banner.appendChild(closeBtn);
  document.documentElement.appendChild(banner);
}

// Runtime messages
chrome.runtime.onMessage.addListener((msg)=>{
  if(!msg) return;
  if(msg.type==="ANNOUNCE" && msg.message){ __gschool_announce_once(msg.message); }
  if(msg.type==="ATTENTION_CHECK"){ showAttentionCheck(msg); }
  if(msg.type==='exam_overlay_on'){ examOverlay.set(true); }
  if(msg.type==='exam_overlay_off'){ examOverlay.set(false); }
});

// ---------- Auto-Re-Enter Fullscreen Exam Overlay (Esc Block + Persistent Warning) ----------
(function(){
  let overlay = null;
  let inExam = false;
  let reenterTimer = null;
  let hasUserGesture = false;
  let violationBanner = null;

  function makeOverlay(){
    if (window.__removeExamBootstrap) window.__removeExamBootstrap();
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'gschoolExamOverlay';
    Object.assign(overlay.style, {
      position:'fixed', inset:'0',
      background:'rgba(0,0,0,.9)', color:'#fff',
      display:'flex', flexDirection:'column',
      alignItems:'center', justifyContent:'center',
      zIndex:'2147483647',
      fontFamily:'system-ui,sans-serif',
      transition:'opacity .3s ease'
    });
    overlay.innerHTML = `
      <div style="max-width:520px;text-align:center">
        <h2 style="margin-bottom:8px;">Exam Mode</h2>
        <p>Click below to enter fullscreen and begin your secure exam.</p>
        <button id="gscStartExam"
          style="margin-top:12px;padding:10px 16px;border-radius:10px;
          border:none;background:#2563eb;color:#fff;font-weight:600;cursor:pointer;font-size:16px">
          Start Exam
        </button>
      </div>`;
    document.documentElement.appendChild(overlay);
    overlay.querySelector('#gscStartExam').onclick = async ()=>{
      hasUserGesture = true;
      await tryEnterFullscreen(true);
    };
    return overlay;
  }

  function showOverlay(){
    makeOverlay();
    overlay.style.display = 'flex';
    overlay.style.opacity = '1';
    document.body.style.visibility = 'hidden';
  }
  function hideOverlay(){
    if (overlay){ overlay.style.display = 'none'; overlay.style.opacity = '0'; }
    document.body.style.visibility = 'visible';
  }

  async function tryEnterFullscreen(fromUser=false){
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        console.log('[Exam] entered fullscreen');
        hideOverlay();
      }
    } catch(e){
      console.warn('[Exam] fullscreen request failed', e);
      if (!fromUser) showOverlay();
    }
  }

  // 🚫 Prevent Escape key from exiting fullscreen
  document.addEventListener('keydown', (ev)=>{
    if (!inExam) return;
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      ev.preventDefault();
      ev.stopPropagation();
      console.warn('[Exam] Esc key blocked');
      showViolationBanner('⚠ Escape key is disabled during exam.');
    }
  }, true);

  function startAutoReenter(){
    if (reenterTimer) return;
    reenterTimer = setInterval(()=>{
      if (inExam && hasUserGesture && !document.fullscreenElement) {
        tryEnterFullscreen(false);
      }
    }, 1000);
  }
  function stopAutoReenter(){
    if (reenterTimer){ clearInterval(reenterTimer); reenterTimer=null; }
  }

  function showViolationBanner(customText){
    if (violationBanner) return; // keep one persistent
    violationBanner=document.createElement('div');
    violationBanner.textContent=customText || '⚠ You must stay in fullscreen mode during the exam';
    Object.assign(violationBanner.style,{
      position:'fixed',top:'0',left:'0',width:'100%',padding:'10px',
      background:'#d32f2f',color:'#fff',textAlign:'center',
      fontSize:'16px',fontWeight:'600',zIndex:'2147483647',
      boxShadow:'0 2px 8px rgba(0,0,0,.3)',display:'flex',
      justifyContent:'center',alignItems:'center',gap:'10px'
    });
    const close=document.createElement('button');
    close.textContent='✕ Close';
    Object.assign(close.style,{
      background:'transparent',color:'#fff',border:'1px solid rgba(255,255,255,.6)',
      borderRadius:'6px',padding:'2px 8px',cursor:'pointer',fontSize:'14px'
    });
    close.onclick=()=>{ violationBanner.remove(); violationBanner=null; };
    violationBanner.appendChild(close);
    document.body.appendChild(violationBanner);
  }

  function onFs(){
    if (!document.fullscreenElement && inExam){
      console.warn('[Exam] exited fullscreen → re-entering');
      chrome.runtime.sendMessage({type:'EXAM_VIOLATION',reason:'fullscreen_exit',url:location.href});
      showViolationBanner();
      showOverlay();
      if (hasUserGesture) tryEnterFullscreen(false);
      startAutoReenter();
    } else if (document.fullscreenElement && inExam){
      hideOverlay();
      stopAutoReenter();
    }
  }
  document.addEventListener('fullscreenchange', onFs);

  chrome.runtime.onMessage.addListener((msg)=>{
    if (!msg) return;
    if (msg.type === 'exam_overlay_on'){
      inExam = true;
      showOverlay();
      startAutoReenter();
    } else if (msg.type === 'exam_overlay_off'){
      inExam = false;
      hideOverlay();
      stopAutoReenter();
      if (document.fullscreenElement){ try{ document.exitFullscreen(); }catch(e){} }
    }
  });

  chrome.storage.local.get(['examActive'], (res)=>{
    if (res.examActive){
      inExam = true;
      showOverlay();
      startAutoReenter();
    }
  });
})();
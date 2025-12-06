
(async function(){
  try{ const st = await chrome.storage.local.get('FEATURES'); const feats = st && st.FEATURES ? st.FEATURES : {}; if(!feats['youtube_filter']) return; }catch(e){ return; }
  
function readRules(feats){
  const y = (feats.youtube_rules||{});
  return {
    channels: (y.blocked_channels||[]).map(s=>s.toLowerCase().trim()).filter(Boolean),
    keywords: (y.blocked_keywords||[]).map(s=>s.toLowerCase().trim()).filter(Boolean)
  };
}
function hideBad(){
  chrome.storage.local.get('FEATURES', st=>{
    const feats = (st && st.FEATURES) || {};
    const rules = readRules(feats);
    const items = document.querySelectorAll('ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer');
    items.forEach(it=>{
      const title = (it.querySelector('#video-title')?.textContent||'').toLowerCase();
      const owner = (it.querySelector('ytd-channel-name')?.textContent||'').toLowerCase();
      const matchCh = rules.channels.some(c=> owner.includes(c));
      const matchKw = rules.keywords.some(k=> title.includes(k));
      if(matchCh || matchKw){ it.style.display='none'; }
    });
  });
}
hideBad(); new MutationObserver(hideBad).observe(document.documentElement,{subtree:true,childList:true});

})();

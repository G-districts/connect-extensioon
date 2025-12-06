
(async function(){
  try{
    const st = await chrome.storage.local.get('FEATURES');
    const feats = st && st.FEATURES ? st.FEATURES : {};
    if(!feats['doodle_block']) return;
  }catch(e){ return; }
  const kill = ()=>{
    document.querySelectorAll('a[href*="doodles"], a[href*="/doodles/"]').forEach(a=>{
      const p = a.closest('div,section,header') || a; p.style.display='none';
    });
    const maybe = document.querySelectorAll('#hplogo, img[alt*="Doodle" i], img[src*="/logos/doodles/"], div[aria-label*="Doodle" i]');
    maybe.forEach(n=> n.remove());
  };
  kill(); new MutationObserver(kill).observe(document.documentElement,{childList:true,subtree:true,attributes:true});
})();
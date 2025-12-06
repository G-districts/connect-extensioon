
(async function(){
  try{
    const st = await chrome.storage.local.get('FEATURES');
    const feats = st && st.FEATURES ? st.FEATURES : {};
    if(!feats['prevent_close_tabs']) return;
    window.addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = ''; });
  }catch(e){}
})();
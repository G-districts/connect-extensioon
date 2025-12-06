(function() {
  function onMessageEvent(ev) {
    try {
      if (ev.source !== window) return;
      const data = ev.data || {};
      if (data.type !== "gschools-bypass-attempt") return;
      const detail = data.detail || {};
      chrome.runtime.sendMessage({ type: "GSCHOOLS_BYPASS_ATTEMPT", detail });
    } catch (e) {}
  }
  window.addEventListener("message", onMessageEvent);
})();
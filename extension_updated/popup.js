// Kid-friendly GSchools popup
(function () {
  const $ = (sel) => document.querySelector(sel);

  function setText(sel, text) {
    const el = $(sel);
    if (el) el.textContent = text;
  }

  function setDotClass(sel, colorClass) {
    const el = $(sel);
    if (!el) return;
    el.classList.remove("gs-dot-green", "gs-dot-gray", "gs-dot-red", "gs-dot-yellow");
    el.classList.add(colorClass);
  }

  function getState() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["STATE"], (res) => resolve(res.STATE || {}));
    });
  }

  async function ensureBackendBase() {
    const st = await getState();
    if (!st.backendBase || st.backendBase.includes("localhost")) {
      st.backendBase = "https://gschool.gdistrict.org";
      chrome.storage.local.set({ STATE: st });
    }
    return st;
  }

  async function renderStatus() {
    const st = await ensureBackendBase();

    const email = st.studentId || "Not signed in";
    const name = st.studentName || "Guest User";
    const backend = st.backendBase || "";
    const host = (() => {
      try {
        return backend ? new URL(backend).host : "not configured";
      } catch {
        return backend || "not configured";
      }
    })();

    const classInfo = st.classInfo || {};
    const classActive = !!classInfo.active;
    const className = classInfo.name || "No class in session";

    // Student info
    setText("#studentName", name);
    setText("#studentEmail", email);
    setText("#backendHost", host);

    // Header avatar changes when class is active
    const avatar = $("#gsAvatar");
    if (avatar) {
      avatar.textContent = classActive ? "🎓" : "🎒";
    }

    // Filter / online status (always visible)
    const paused = !!st.paused;
    const focusMode = !!st.focusMode;

    if (paused) {
      setText("#filterMode", "⏸ Internet paused by your teacher");
      setDotClass("#filterDot", "gs-dot-red");
    } else if (focusMode && classActive) {
      setText("#filterMode", "🎯 Focus mode is ON for class");
      setDotClass("#filterDot", "gs-dot-yellow");
    } else {
      setText("#filterMode", "✅ Normal filtering");
      setDotClass("#filterDot", "gs-dot-green");
    }

    // Policy meta if available
    if (typeof st.policyVersion !== "undefined") {
      setText("#policyVersion", "Policy v" + String(st.policyVersion));
    }
    if (st.lastPolicyUpdate) {
      try {
        const d = new Date(st.lastPolicyUpdate);
        setText("#policyUpdatedAt", "Updated " + d.toLocaleTimeString());
      } catch (e) {}
    }

    // Class + tools only when class is active
    const classCard = $("#classCard");
    const actionsCard = $("#actionsCard");

    if (classCard) {
      if (classActive) {
        classCard.style.display = "block";
        setText("#className", className);
        setText("#sessionText", "Class is in session. Stay with your teacher.");
        setDotClass("#sessionDot", "gs-dot-green");
      } else {
        classCard.style.display = "none";
        setDotClass("#sessionDot", "gs-dot-gray");
        setText("#sessionText", "No active class session.");
      }
    }

    if (actionsCard) {
      actionsCard.style.display = classActive ? "block" : "none";
    }
  }

  async function raiseHand() {
    const st = await ensureBackendBase();
    const backend = st.backendBase || "https://gschool.gdistrict.org";
    const student = st.studentId || "guest@local";

    await fetch(backend + "/api/raise_hand", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ student, note: "" })
    });
  }

  async function openPresentation() {
    const st = await ensureBackendBase();
    const backend = st.backendBase || "https://gschool.gdistrict.org";
    let room = "classroom";

    try {
      if (st.classInfo && st.classInfo.name) {
        room = st.classInfo.name
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9_-]/g, "");
      } else if (st.studentId) {
        room = (st.studentId.split("@")[0] || "classroom").replace(/[^a-zA-Z0-9_-]/g, "");
      }
    } catch (e) {
      console.warn("[Popup] could not derive room name", e);
    }

    const url = backend + "/present/" + room;
    const hint = $("#presentHint");
    if (hint) hint.style.display = "block";

    if (chrome && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url });
    } else {
      window.open(url, "_blank");
    }
  }

  async function openAdminPresentation() {
    const st = await ensureBackendBase();
    const backend = st.backendBase || "https://gschool.gdistrict.org";
    const url = backend + "/present/admin";
    const hint = $("#presentHintAdmin");
    if (hint) hint.style.display = "block";

    if (chrome && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url });
    } else {
      window.open(url, "_blank");
    }
  }

  function bindButtons() {
    const refreshBtn = $("#refresh");
    if (refreshBtn) {
      refreshBtn.onclick = () => {
        renderStatus();
      };
    }

    const raiseBtn = $("#raiseHand");
    const raiseMsg = $("#raiseMsg");
    if (raiseBtn) {
      raiseBtn.onclick = async () => {
        if (raiseMsg) {
          raiseMsg.textContent = "Sending a help signal to your teacher...";
        }
        try {
          await raiseHand();
          if (raiseMsg) {
            raiseMsg.textContent =
              "Your teacher has been notified • " + new Date().toLocaleTimeString();
          }
        } catch (e) {
          console.warn("[Popup] raiseHand failed", e);
          if (raiseMsg) {
            raiseMsg.textContent = "Could not send. Check your connection.";
          }
        }
      };
    }

    const presentBtn = $("#viewPresent");
    if (presentBtn) {
      presentBtn.onclick = async () => {
        try {
          await openPresentation();
        } catch (e) {
          console.warn("[Popup] openPresentation failed", e);
        }
      };
    }

    const presentAdminBtn = $("#viewPresentAdmin");
    if (presentAdminBtn) {
      presentAdminBtn.onclick = async () => {
        try {
          await openAdminPresentation();
        } catch (e) {
          console.warn("[Popup] openAdminPresentation failed", e);
        }
      };
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    renderStatus();
    bindButtons();
  });
})();

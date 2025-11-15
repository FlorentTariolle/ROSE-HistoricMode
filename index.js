/**
 * LU-HistoricMode Plugin
 * Shows historic flag at rewards location based on Python state
 */
(function initHistoricMode() {
  const LOG_PREFIX = "[LU-HistoricMode]";
  const REWARDS_SELECTOR = ".skin-selection-item-information.loyalty-reward-icon--rewards";
  const HISTORIC_FLAG_IMAGE = "rcp-fe-lol-champ-select/global/default/images/config/champ-free-to-play-rgm-flag.png";
  
  // WebSocket bridge for receiving historic state from Python
  const BRIDGE_URL = "ws://localhost:3000";
  let bridgeSocket = null;
  let bridgeReady = false;
  let bridgeQueue = [];
  
  let historicModeActive = false;
  let currentRewardsElement = null;
  
  const CSS_RULES = `
    .skin-selection-item-information.loyalty-reward-icon--rewards.lu-historic-flag-active {
      background-image: url("/${HISTORIC_FLAG_IMAGE}") !important;
      background-repeat: no-repeat !important;
      background-size: contain !important;
      height: 32px !important;
      width: 32px !important;
      position: absolute !important;
      right: -14px !important;
      top: -14px !important;
      pointer-events: none !important;
      cursor: default !important;
      -webkit-user-select: none !important;
      list-style-type: none !important;
      content: " " !important;
    }
  `;
  
  function log(level, message, data = null) {
    const payload = {
      type: "chroma-log",
      source: "LU-HistoricMode",
      level: level,
      message: message,
      timestamp: Date.now(),
    };
    if (data) payload.data = data;
    
    if (bridgeReady && bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
      bridgeSocket.send(JSON.stringify(payload));
    } else {
      bridgeQueue.push(JSON.stringify(payload));
    }
    
    // Also log to console for debugging
    const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    consoleMethod(`${LOG_PREFIX} ${message}`, data || "");
  }
  
  function setupBridgeSocket() {
    if (bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
      return;
    }
    
    try {
      bridgeSocket = new WebSocket(BRIDGE_URL);
      
      bridgeSocket.onopen = () => {
        log("info", "WebSocket bridge connected");
        bridgeReady = true;
        flushBridgeQueue();
      };
      
      bridgeSocket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          handleBridgeMessage(payload);
        } catch (e) {
          log("error", "Failed to parse bridge message", { error: e.message });
        }
      };
      
      bridgeSocket.onerror = (error) => {
        log("warn", "WebSocket bridge error", { error: error.message || "Unknown error" });
      };
      
      bridgeSocket.onclose = () => {
        log("info", "WebSocket bridge closed, reconnecting...");
        bridgeReady = false;
        bridgeSocket = null;
        scheduleBridgeRetry();
      };
    } catch (e) {
      log("error", "Failed to setup WebSocket bridge", { error: e.message });
      scheduleBridgeRetry();
    }
  }
  
  function scheduleBridgeRetry() {
    setTimeout(() => {
      if (!bridgeReady) {
        setupBridgeSocket();
      }
    }, 3000);
  }
  
  function flushBridgeQueue() {
    if (bridgeQueue.length > 0 && bridgeReady && bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
      bridgeQueue.forEach((message) => {
        bridgeSocket.send(message);
      });
      bridgeQueue = [];
    }
  }
  
  function handleBridgeMessage(payload) {
    if (payload.type === "historic-state") {
      handleHistoricStateUpdate(payload);
    }
  }
  
  function handleHistoricStateUpdate(data) {
    const wasActive = historicModeActive;
    historicModeActive = data.active === true;
    
    log("debug", "Received historic state update", { 
      active: historicModeActive, 
      wasActive: wasActive 
    });
    
    if (historicModeActive !== wasActive) {
      updateHistoricFlag();
    }
  }
  
  function findRewardsElement() {
    // Try to find the rewards element
    const element = document.querySelector(REWARDS_SELECTOR);
    if (element) {
      return element;
    }
    
    // If not found, try to find it in the skin selection carousel
    const carousel = document.querySelector(".skin-selection-carousel");
    if (carousel) {
      const items = carousel.querySelectorAll(".skin-selection-item");
      for (const item of items) {
        const info = item.querySelector(".skin-selection-item-information");
        if (info && info.classList.contains("loyalty-reward-icon--rewards")) {
          return info;
        }
      }
    }
    
    return null;
  }
  
  function updateHistoricFlag() {
    const element = findRewardsElement();
    
    if (!element) {
      log("debug", "Rewards element not found, will retry");
      // Retry after a short delay
      setTimeout(updateHistoricFlag, 500);
      return;
    }
    
    currentRewardsElement = element;
    
    if (historicModeActive) {
      element.classList.add("lu-historic-flag-active");
      log("info", "Historic flag shown");
    } else {
      element.classList.remove("lu-historic-flag-active");
      log("info", "Historic flag hidden");
    }
  }
  
  function init() {
    log("info", "Initializing LU-HistoricMode plugin");
    
    // Inject CSS
    const style = document.createElement("style");
    style.textContent = CSS_RULES;
    document.head.appendChild(style);
    
    // Setup WebSocket bridge
    setupBridgeSocket();
    
    // Watch for DOM changes to find rewards element
    const observer = new MutationObserver(() => {
      if (historicModeActive && !currentRewardsElement) {
        updateHistoricFlag();
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    
    // Initial check
    setTimeout(() => {
      if (historicModeActive) {
        updateHistoricFlag();
      }
    }, 1000);
    
    log("info", "LU-HistoricMode plugin initialized");
  }
  
  // Start when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();


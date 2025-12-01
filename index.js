/**
 * @name ROSE-HistoricMode
 * @author Rose Team
 * @description Historic mode for Pengu Loader
 * @link https://github.com/FlorentTariolle/Rose-HistoricMode
 */
(function initHistoricMode() {
  const LOG_PREFIX = "[ROSE-HistoricMode]";
  const REWARDS_SELECTOR = ".skin-selection-item-information.loyalty-reward-icon--rewards";
  const HISTORIC_FLAG_ASSET_PATH = "historic_flag.png";
  const SHOW_SKIN_NAME_ID = "historic-popup-layer";
  // WebSocket bridge for receiving historic state from Python
  let BRIDGE_PORT = 50000; // Default, will be updated from /bridge-port endpoint
  let BRIDGE_URL = `ws://localhost:${BRIDGE_PORT}`;
  const BRIDGE_PORT_STORAGE_KEY = "rose_bridge_port";
  const DISCOVERY_START_PORT = 50000;
  const DISCOVERY_END_PORT = 50010;
  let bridgeSocket = null;
  let bridgeReady = false;
  let bridgeQueue = [];
  
  // Load bridge port with file-based discovery and localStorage caching
  async function loadBridgePort() {
    try {
      // First, check localStorage for cached port
      const cachedPort = localStorage.getItem(BRIDGE_PORT_STORAGE_KEY);
      if (cachedPort) {
        const port = parseInt(cachedPort, 10);
        if (!isNaN(port) && port > 0) {
          // Verify cached port is still valid with shorter timeout
          try {
            const response = await fetch(`http://localhost:${port}/bridge-port`, {
              signal: AbortSignal.timeout(200)
            });
            if (response.ok) {
              const portText = await response.text();
              const fetchedPort = parseInt(portText.trim(), 10);
              if (!isNaN(fetchedPort) && fetchedPort > 0) {
                BRIDGE_PORT = fetchedPort;
                BRIDGE_URL = `ws://localhost:${BRIDGE_PORT}`;
                console.log(`${LOG_PREFIX} Loaded bridge port from cache: ${BRIDGE_PORT}`);
                return true;
              }
            }
          } catch (e) {
            // Cached port invalid, continue to discovery
            localStorage.removeItem(BRIDGE_PORT_STORAGE_KEY);
          }
        }
      }
      
      // OPTIMIZATION: Try default port 50000 FIRST before scanning all ports
      try {
        const response = await fetch(`http://localhost:50000/bridge-port`, {
          signal: AbortSignal.timeout(200)
        });
        if (response.ok) {
          const portText = await response.text();
          const fetchedPort = parseInt(portText.trim(), 10);
          if (!isNaN(fetchedPort) && fetchedPort > 0) {
            BRIDGE_PORT = fetchedPort;
            BRIDGE_URL = `ws://localhost:${BRIDGE_PORT}`;
            localStorage.setItem(BRIDGE_PORT_STORAGE_KEY, String(BRIDGE_PORT));
            console.log(`${LOG_PREFIX} Loaded bridge port: ${BRIDGE_PORT}`);
            return true;
          }
        }
      } catch (e) {
        // Port 50000 not ready, continue to discovery
      }
      
      // OPTIMIZATION: Parallel port discovery instead of sequential
      // Start at DISCOVERY_START_PORT + 1 since 50000 was already tested above
      const portPromises = [];
      for (let port = DISCOVERY_START_PORT + 1; port <= DISCOVERY_END_PORT; port++) {
        portPromises.push(
          fetch(`http://localhost:${port}/bridge-port`, {
            signal: AbortSignal.timeout(300)
          })
          .then(response => {
            if (response.ok) {
              return response.text().then(portText => {
                const fetchedPort = parseInt(portText.trim(), 10);
                if (!isNaN(fetchedPort) && fetchedPort > 0) {
                  return { port: fetchedPort, sourcePort: port };
                }
                return null;
              });
            }
            return null;
          })
          .catch(() => null)
        );
      }
      
      // Wait for first successful response
      const results = await Promise.allSettled(portPromises);
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          BRIDGE_PORT = result.value.port;
          BRIDGE_URL = `ws://localhost:${BRIDGE_PORT}`;
          localStorage.setItem(BRIDGE_PORT_STORAGE_KEY, String(BRIDGE_PORT));
          console.log(`${LOG_PREFIX} Loaded bridge port: ${BRIDGE_PORT}`);
          return true;
        }
      }
      
      // Fallback: try old /port endpoint (parallel as well)
      // Start at DISCOVERY_START_PORT + 1 since 50000 was already tested above
      const legacyPromises = [];
      for (let port = DISCOVERY_START_PORT + 1; port <= DISCOVERY_END_PORT; port++) {
        legacyPromises.push(
          fetch(`http://localhost:${port}/port`, {
            signal: AbortSignal.timeout(300)
          })
          .then(response => {
            if (response.ok) {
              return response.text().then(portText => {
                const fetchedPort = parseInt(portText.trim(), 10);
                if (!isNaN(fetchedPort) && fetchedPort > 0) {
                  return { port: fetchedPort, sourcePort: port };
                }
                return null;
              });
            }
            return null;
          })
          .catch(() => null)
        );
      }
      
      const legacyResults = await Promise.allSettled(legacyPromises);
      for (const result of legacyResults) {
        if (result.status === 'fulfilled' && result.value) {
          BRIDGE_PORT = result.value.port;
          BRIDGE_URL = `ws://localhost:${BRIDGE_PORT}`;
          localStorage.setItem(BRIDGE_PORT_STORAGE_KEY, String(BRIDGE_PORT));
          console.log(`${LOG_PREFIX} Loaded bridge port (legacy): ${BRIDGE_PORT}`);
          return true;
        }
      }
      
      console.warn(`${LOG_PREFIX} Failed to load bridge port, using default (50000)`);
      return false;
    } catch (e) {
      console.warn(`${LOG_PREFIX} Error loading bridge port:`, e);
      return false;
    }
  }
  
  let historicModeActive = false;
  let currentRewardsElement = null;
  let historicFlagImageUrl = null; // HTTP URL from Python
  const pendingHistoricFlagRequest = new Map(); // Track pending requests
  let isInChampSelect = false; // Track if we're in ChampSelect phase
  
  const CSS_RULES = `
    .skin-selection-item-information.loyalty-reward-icon--rewards.lu-historic-flag-active {
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
    } else if (payload.type === "local-asset-url") {
      handleLocalAssetUrl(payload);
    } else if (payload.type === "phase-change") {
      handlePhaseChange(payload);
    }
  }
  
  function handlePhaseChange(data) {
    const wasInChampSelect = isInChampSelect;
    // Check if we're entering ChampSelect phase
    isInChampSelect = data.phase === "ChampSelect" || data.phase === "FINALIZATION";
    
    if (isInChampSelect && !wasInChampSelect) {
      log("debug", "Entered ChampSelect phase - enabling plugin");
      // Try to update flag when entering ChampSelect
      if (historicModeActive) {
        setTimeout(() => {
          updateHistoricFlag();
        }, 100);
      }
    } else if (!isInChampSelect && wasInChampSelect) {
      log("debug", "Left ChampSelect phase - disabling plugin");
      // Hide flag when leaving ChampSelect
      if (currentRewardsElement) {
        hideFlagOnElement(currentRewardsElement);
        currentRewardsElement = null;
      }
      // Reset retry counters
      if (updateHistoricFlag._retryCount) {
        updateHistoricFlag._retryCount = 0;
      }
    }
  }
  
  function handleLocalAssetUrl(data) {
    const assetPath = data.assetPath;
    const url = data.url;
    
    if (assetPath === HISTORIC_FLAG_ASSET_PATH && url) {
      historicFlagImageUrl = url;
      pendingHistoricFlagRequest.delete(HISTORIC_FLAG_ASSET_PATH);
      log("info", "Received historic flag image URL from Python", { url: url });
      
      // Update the flag if it's currently active and we're in ChampSelect
      if (isInChampSelect && historicModeActive) {
        updateHistoricFlag();
      }
    }
  }
  
  function handleHistoricStateUpdate(data) {
    handleHistoricSkinNameUpdate(data);
    const wasActive = historicModeActive;
    historicModeActive = data.active === true;
    
    log("info", "Received historic state update", { 
      active: historicModeActive, 
      wasActive: wasActive,
      historicSkinId: data.historicSkinId
    });
    
    // Always update the flag when we receive a state update (even if state didn't change)
    // This ensures the flag is shown even if the element wasn't found initially
    // Use a small delay to ensure DOM is ready
    setTimeout(() => {
      updateHistoricFlag();
    }, 100);
    
    // Also try again after a longer delay in case DOM updates are delayed
    if (historicModeActive) {
      setTimeout(() => {
        updateHistoricFlag();
      }, 1000);
    }
  }
  
  function findRewardsElement() {
    // Only try to find elements when in ChampSelect
    if (!isInChampSelect) {
      return null;
    }
    
    // Try to find the rewards element in the selected skin item first
    const selectedItem = document.querySelector(".skin-selection-item.skin-selection-item-selected");
    if (selectedItem) {
      const info = selectedItem.querySelector(".skin-selection-item-information.loyalty-reward-icon--rewards");
      if (info) {
        log("debug", "Found rewards element in selected skin item");
        return info;
      }
    }
    
    // Try direct selector
    const element = document.querySelector(REWARDS_SELECTOR);
    if (element) {
      log("debug", "Found rewards element via direct selector");
      return element;
    }
    
    // If not found, try to find it in the skin selection carousel
    const carousel = document.querySelector(".skin-selection-carousel");
    if (carousel) {
      const items = carousel.querySelectorAll(".skin-selection-item");
      for (const item of items) {
        const info = item.querySelector(".skin-selection-item-information");
        if (info && info.classList.contains("loyalty-reward-icon--rewards")) {
          log("debug", "Found rewards element in carousel item");
          return info;
        }
      }
    }
    
    // Only log if we're actually in ChampSelect (to avoid spam before entering)
    log("debug", "Rewards element not found anywhere");
    removeHistoricSkinName();
    return null;
  }
  function showSkinName(skinName) {
    const id = SHOW_SKIN_NAME_ID;
    let text = skinName;
    // If an element with the same id already exists, directly update the content and reset the timer
    let popup = document.getElementById(id);
    if (popup) {
      popup.querySelector('.popup-text').textContent = text;
      resetTimer(popup);
      return;
    }

    // Create container
    popup = document.createElement('div');
    popup.id = id;

    // Set styles
    Object.assign(popup.style, {
      position: 'fixed',
      bottom:'10%',
      left: '55%',
      zIndex: '999999',
      background: '#1e2328',
      color: '#b2a580',
      padding: '7px 10px',
      borderRadius: '4px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      fontSize: '14px',
      lineHeight: '1.4',
      display: 'flex',
      alignItems: 'center',
      maxWidth: '300px',
      fontWeight: 'bolder'
    });

    // Text
    const textSpan = document.createElement('span');
    textSpan.className = 'popup-text';
    textSpan.textContent = text;
    popup.appendChild(textSpan);

    // Close button
    const closeBtn = document.createElement('span');
    closeBtn.textContent = 'x';
    Object.assign(closeBtn.style, {
      marginLeft: '10px',
      cursor: 'pointer',
      fontWeight: 'bold'
    });
    closeBtn.onclick = () => popup.remove();
    popup.appendChild(closeBtn);

    // Add to page rcp-fe-viewport-root
    document.body.appendChild(popup);

    // Auto close timer
    resetTimer(popup);

    function resetTimer(el) {
      if (el._timer) clearTimeout(el._timer);
      el._timer = setTimeout(() => el.remove(), 125000); // Remove after 125 seconds
    }
  }

  const handleHistoricSkinNameUpdate = (payload)=>{
    if(payload.historicSkinName && payload.historicSkinName !== "None"){
      showSkinName(payload.historicSkinName);
    } else {
      removeHistoricSkinName();
    }
  }
  function removeHistoricSkinName() {
    document.getElementById(SHOW_SKIN_NAME_ID)?.remove();
  }
  function requestHistoricFlagImage() {
    // Request historic flag image from Python (same way as Elementalist Lux icons)
    if (!historicFlagImageUrl && !pendingHistoricFlagRequest.has(HISTORIC_FLAG_ASSET_PATH)) {
      pendingHistoricFlagRequest.set(HISTORIC_FLAG_ASSET_PATH, true);
      
      const payload = {
        type: "request-local-asset",
        assetPath: HISTORIC_FLAG_ASSET_PATH,
        timestamp: Date.now(),
      };
      
      log("debug", "Requesting historic flag image from Python", { assetPath: HISTORIC_FLAG_ASSET_PATH });
      
      if (bridgeReady && bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
        bridgeSocket.send(JSON.stringify(payload));
      } else {
        bridgeQueue.push(JSON.stringify(payload));
      }
    }
  }
  
  function updateHistoricFlag() {
    // Only try to update if we're in ChampSelect
    if (!isInChampSelect) {
      return;
    }
    
    // Always find the element in the currently selected skin (don't use cached element)
    const element = findRewardsElement();
    
    if (!element) {
      // Only retry if we're still in ChampSelect
      if (!isInChampSelect) {
        return;
      }
      log("debug", "Rewards element not found, will retry");
      // Retry after a short delay (max 5 retries to avoid infinite loop)
      if (!updateHistoricFlag._retryCount) {
        updateHistoricFlag._retryCount = 0;
      }
      if (updateHistoricFlag._retryCount < 5) {
        updateHistoricFlag._retryCount++;
        setTimeout(() => {
          if (isInChampSelect) { // Check again before retrying
            updateHistoricFlag();
          } else {
            updateHistoricFlag._retryCount = 0; // Reset if we left ChampSelect
          }
        }, 500);
      } else {
        log("warn", "Rewards element not found after 5 retries, giving up");
        updateHistoricFlag._retryCount = 0; // Reset for next attempt
      }
      return;
    }
    
    // Reset retry count on success
    updateHistoricFlag._retryCount = 0;
    
    // If we have a previously cached element that's different from the current one, hide it first
    if (currentRewardsElement && currentRewardsElement !== element) {
      log("debug", "Selected skin changed - hiding flag on previous element");
      hideFlagOnElement(currentRewardsElement);
    }
    
    currentRewardsElement = element;
    
    // Log element state for debugging
    const computedStyle = window.getComputedStyle(element);
    const isVisible = computedStyle.display !== "none" && computedStyle.visibility !== "hidden" && computedStyle.opacity !== "0";
    log("debug", "Found rewards element", {
      display: computedStyle.display,
      visibility: computedStyle.visibility,
      opacity: computedStyle.opacity,
      isVisible: isVisible,
      classes: Array.from(element.classList)
    });
    
    if (historicModeActive) {
      // Request image if we don't have it yet
      if (!historicFlagImageUrl) {
        requestHistoricFlagImage();
        // Wait for image URL before applying
        return;
      }
      
      // Force element to be visible (rewards icon is usually hidden)
      element.style.setProperty("display", "block", "important");
      element.style.setProperty("visibility", "visible", "important");
      element.style.setProperty("opacity", "1", "important");
      
      // Apply the image URL from Python
      element.classList.add("lu-historic-flag-active");
      element.style.setProperty("background-image", `url("${historicFlagImageUrl}")`, "important");
      element.style.setProperty("background-repeat", "no-repeat", "important");
      element.style.setProperty("background-size", "contain", "important");
      element.style.setProperty("height", "32px", "important");
      element.style.setProperty("width", "32px", "important");
      element.style.setProperty("position", "absolute", "important");
      element.style.setProperty("right", "-14px", "important");
      element.style.setProperty("top", "-14px", "important");
      element.style.setProperty("pointer-events", "none", "important");
      element.style.setProperty("cursor", "default", "important");
      element.style.setProperty("-webkit-user-select", "none", "important");
      element.style.setProperty("list-style-type", "none", "important");
      element.style.setProperty("content", " ", "important");
      
      log("info", "Historic flag shown on rewards element", { 
        url: historicFlagImageUrl,
        display: element.style.display,
        visibility: element.style.visibility
      });
    } else {
      // Historic mode is inactive - hide the flag
      hideFlagOnElement(element);
      log("info", "Historic flag hidden on rewards element");
    }
  }
  
  function hideFlagOnElement(element) {
    if (!element) return;
    
    // Only remove our flag class
    element.classList.remove("lu-historic-flag-active");
    
    // Check if random flag is active - if so, don't remove shared styles
    const hasRandomFlag = element.classList.contains("lu-random-flag-active");
    
    if (!hasRandomFlag) {
      // No other flag is active - safe to remove all styles
      element.style.removeProperty("background-image");
      element.style.removeProperty("background-repeat");
      element.style.removeProperty("background-size");
      element.style.removeProperty("height");
      element.style.removeProperty("width");
      element.style.removeProperty("position");
      element.style.removeProperty("right");
      element.style.removeProperty("top");
      element.style.removeProperty("pointer-events");
      element.style.removeProperty("cursor");
      element.style.removeProperty("-webkit-user-select");
      element.style.removeProperty("list-style-type");
      element.style.removeProperty("content");
      // Explicitly hide the element (rewards icon is usually hidden by default)
      element.style.setProperty("display", "none", "important");
      element.style.setProperty("visibility", "hidden", "important");
      element.style.setProperty("opacity", "0", "important");
    } else {
      // Random flag is active - only remove our background image, keep shared styles
      // Check if the background-image is ours (contains historic_flag.png)
      const bgImage = element.style.getPropertyValue("background-image");
      if (bgImage && bgImage.includes("historic_flag.png")) {
        element.style.removeProperty("background-image");
      }
      // Don't remove other styles as random flag needs them
    }
  }
  
  async function init() {
    log("info", "Initializing LU-HistoricMode plugin");
    
    // Load bridge port before initializing socket
    await loadBridgePort();
    
    // Ensure historic mode starts as inactive
    historicModeActive = false;
    
    // Inject CSS
    const style = document.createElement("style");
    style.textContent = CSS_RULES;
    document.head.appendChild(style);
    
    // Setup WebSocket bridge
    setupBridgeSocket();
    
    // Watch for DOM changes to find rewards element (only when in ChampSelect)
    const observer = new MutationObserver(() => {
      // Only try to update if in ChampSelect and historic mode is active
      if (isInChampSelect && historicModeActive) {
        updateHistoricFlag();
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    
    // Request historic flag image on init (for when it's needed)
    requestHistoricFlagImage();
    
    // Don't try to update flag on init - wait for phase-change message to know if we're in ChampSelect
    
    log("info", "LU-HistoricMode plugin initialized");
  }
  
  // Start when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();


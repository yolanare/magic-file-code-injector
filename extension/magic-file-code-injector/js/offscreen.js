(() => {
  // The offscreen document owns the WebSocket because MV3 service workers are allowed to sleep.
  const LR_PROTOCOLS = [
    "http://livereload.com/protocols/official-7",
    "http://livereload.com/protocols/official-8",
    "http://livereload.com/protocols/official-9",
  ];
  const RECONNECT_FAST_INTERVAL_MS = 2000;
  const RECONNECT_SLOW_INTERVAL_MS = 10000;
  const RECONNECT_FAST_WINDOW_MS = 20000;
  const SOCKET_KEEPALIVE_INTERVAL_MS = 15000;
  const SOCKET_RECYCLE_AGE_MS = 10 * 60 * 1000;
  const BACKGROUND_DELIVERY_RETRY_MS = 500;
  const MAX_PENDING_BACKGROUND_MESSAGES = 100;

  let socket = null;
  let socketUrl = "";
  let socketConnected = false;
  let socketError = "";
  let socketOpenedAt = 0;
  let socketKeepaliveTimer = null;
  let reconnectTimer = null;
  let reconnectStartedAt = 0;
  let hasConnectedAtLeastOnce = false;
  let connectionLossLogged = false;
  let lastReason = "startup";
  let statusWaiters = [];
  let pendingBackgroundMessages = [];
  let backgroundDeliveryInFlight = false;
  let backgroundDeliveryRetryTimer = null;

  function getStatusSnapshot() {
    return {
      ok: true,
      connected: socketConnected,
      error: socketError,
      url: socketUrl,
      reason: lastReason,
    };
  }

  function resolveStatusWaiters() {
    const waiters = statusWaiters;
    statusWaiters = [];

    for (const resolve of waiters) {
      resolve(getStatusSnapshot());
    }
  }

  /**
   * Send one message to the background service worker and normalize failures for retryable queues.
   * @param {any} message - Runtime message sent to the background script.
   * @returns {Promise<{ok:boolean,error?:string,response?:any}>} Delivery status.
   */
  function sendToBackground(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            resolve({ ok: false, error: runtimeError.message });
            return;
          }

          if (response && response.ok === false) {
            resolve({ ok: false, error: response.error || "Background rejected the message." });
            return;
          }

          resolve({ ok: true, response });
        });
      } catch (error) {
        resolve({ ok: false, error: String(error.message || error) });
      }
    });
  }

  function postStatus(reason) {
    void sendToBackground({
      type: "MFCI_OFFSCREEN_SOCKET_STATUS",
      target: "background",
      connected: socketConnected,
      error: socketError,
      url: socketUrl,
      reason,
    });
    resolveStatusWaiters();
  }

  function waitForSocketStatus(timeoutMs = 2500) {
    if (socketConnected || socketError || !socket || socket.readyState !== WebSocket.CONNECTING) {
      return Promise.resolve(getStatusSnapshot());
    }

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        statusWaiters = statusWaiters.filter((waiter) => waiter !== resolveOnce);
        resolve(getStatusSnapshot());
      }, timeoutMs);

      function resolveOnce(status) {
        clearTimeout(timeoutId);
        resolve(status);
      }

      statusWaiters.push(resolveOnce);
    });
  }

  function logToBrowserConsole(level, message) {
    void sendToBackground({
      type: "MFCI_OFFSCREEN_LOG",
      target: "background",
      level,
      message,
    });
  }

  function stopSocketKeepalive() {
    if (socketKeepaliveTimer) {
      clearInterval(socketKeepaliveTimer);
      socketKeepaliveTimer = null;
    }
  }

  function stopReconnectLoop() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectStartedAt = 0;
  }

  function logConnectionLoss(reason) {
    if (connectionLossLogged || !hasConnectedAtLeastOnce) {
      return;
    }

    connectionLossLogged = true;
    logToBrowserConsole("warn", `[mfci] WebSocket connection lost (${reason}). Reconnecting automatically.`);
  }

  /**
   * Reconnect forever: fast first for local-server restarts, then slow to avoid noisy background work.
   * @returns {void} Schedules the next reconnect attempt.
   */
  function scheduleReconnect() {
    if (socketConnected || !socketUrl) {
      stopReconnectLoop();
      return;
    }

    if (!reconnectStartedAt) {
      reconnectStartedAt = Date.now();
    }

    if (reconnectTimer) {
      return;
    }

    const elapsedMs = Date.now() - reconnectStartedAt;
    const delayMs = elapsedMs < RECONNECT_FAST_WINDOW_MS ? RECONNECT_FAST_INTERVAL_MS : RECONNECT_SLOW_INTERVAL_MS;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!socketConnected) {
        connectSocket({ url: socketUrl, reason: "reconnect" });
      }
    }, delayMs);
  }

  function sendSocketPayload(currentSocket, payload, failureReason) {
    if (socket !== currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      currentSocket.send(JSON.stringify(payload));
      return true;
    } catch (_error) {
      failSocket(currentSocket, failureReason);
      return false;
    }
  }

  function sendSocketHello(currentSocket) {
    sendSocketPayload(
      currentSocket,
      {
        command: "hello",
        protocols: LR_PROTOCOLS,
        ver: "3.0.0",
      },
      "hello"
    );
  }

  /**
   * Send LiveReload `info` frames as an application-level keepalive.
   * Browser WebSocket readyState can stay OPEN after network sleep, so writes are the useful health check.
   * @param {WebSocket} currentSocket - Socket instance currently owned by the offscreen document.
   * @returns {void}
   */
  function sendSocketInfo(currentSocket) {
    sendSocketPayload(
      currentSocket,
      {
        command: "info",
        url: chrome.runtime.getURL("offscreen.html"),
      },
      "keepalive"
    );
  }

  function failSocket(currentSocket, reason) {
    if (socket !== currentSocket) {
      return;
    }

    stopSocketKeepalive();
    socketConnected = false;
    socketError = `WebSocket ${reason} failed. Reconnecting...`;
    postStatus(reason);

    try {
      currentSocket.close();
    } catch (_error) {
      // Closing is best effort; reconnect scheduling below is the important part.
    }

    scheduleReconnect();
  }

  /**
   * Keep long-lived sockets healthy and recycle old connections before stale OPEN states accumulate.
   * @param {WebSocket} currentSocket - Socket instance currently owned by the offscreen document.
   * @returns {void}
   */
  function runSocketHealthCheck(currentSocket) {
    if (socket !== currentSocket) {
      return;
    }

    if (currentSocket.readyState !== WebSocket.OPEN) {
      failSocket(currentSocket, "keepalive");
      return;
    }

    if (socketOpenedAt && Date.now() - socketOpenedAt >= SOCKET_RECYCLE_AGE_MS) {
      connectSocket({ url: socketUrl, reason: "health-check", forceReconnect: true });
      return;
    }

    sendSocketInfo(currentSocket);
  }

  function startSocketKeepalive(currentSocket) {
    stopSocketKeepalive();
    socketKeepaliveTimer = setInterval(() => {
      runSocketHealthCheck(currentSocket);
    }, SOCKET_KEEPALIVE_INTERVAL_MS);
  }

  function scheduleBackgroundDeliveryRetry() {
    if (backgroundDeliveryRetryTimer || pendingBackgroundMessages.length === 0) {
      return;
    }

    backgroundDeliveryRetryTimer = setTimeout(() => {
      backgroundDeliveryRetryTimer = null;
      void flushBackgroundMessages();
    }, BACKGROUND_DELIVERY_RETRY_MS);
  }

  /**
   * Deliver socket messages sequentially and wait for the background batch to finish before dropping them.
   * @returns {Promise<void>}
   */
  async function flushBackgroundMessages() {
    if (backgroundDeliveryInFlight) {
      return;
    }

    backgroundDeliveryInFlight = true;
    try {
      while (pendingBackgroundMessages.length > 0) {
        const currentMessage = pendingBackgroundMessages[0];
        const result = await sendToBackground(currentMessage);
        if (!result.ok) {
          scheduleBackgroundDeliveryRetry();
          return;
        }

        if (pendingBackgroundMessages[0] === currentMessage) {
          pendingBackgroundMessages.shift();
          continue;
        }

        const deliveredMessageIndex = pendingBackgroundMessages.indexOf(currentMessage);
        if (deliveredMessageIndex >= 0) {
          pendingBackgroundMessages.splice(deliveredMessageIndex, 1);
        }
      }
    } finally {
      backgroundDeliveryInFlight = false;
      if (pendingBackgroundMessages.length > 0) {
        scheduleBackgroundDeliveryRetry();
      }
    }
  }

  /**
   * Queue LiveReload payloads so service-worker wakeup races do not lose refresh signals.
   * @param {string} data - Raw WebSocket payload.
   * @returns {void}
   */
  function queueBackgroundSocketMessage(data) {
    pendingBackgroundMessages.push({
      type: "MFCI_OFFSCREEN_SOCKET_MESSAGE",
      target: "background",
      data,
    });

    if (pendingBackgroundMessages.length > MAX_PENDING_BACKGROUND_MESSAGES) {
      pendingBackgroundMessages = pendingBackgroundMessages.slice(-MAX_PENDING_BACKGROUND_MESSAGES);
    }

    void flushBackgroundMessages();
  }

  function connectSocket(options = {}) {
    const nextSocketUrl = typeof options.url === "string" ? options.url : socketUrl;
    const reason = typeof options.reason === "string" ? options.reason : "auto";
    const forceReconnect = options.forceReconnect === true;
    const isManual = reason === "manual";

    if (!nextSocketUrl) {
      socketConnected = false;
      socketError = "WebSocket URL is missing.";
      postStatus(reason);
      return;
    }

    lastReason = reason;

    if (isManual) {
      socketError = "";
      connectionLossLogged = false;
      stopReconnectLoop();
    }

    if (
      !forceReconnect &&
      socket &&
      socketUrl === nextSocketUrl &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      if (socket.readyState === WebSocket.OPEN && !socketKeepaliveTimer) {
        startSocketKeepalive(socket);
      }
      postStatus(reason);
      return;
    }

    if (socket) {
      const previousSocket = socket;
      socket = null;
      stopSocketKeepalive();
      try {
        previousSocket.close();
      } catch (_error) {
        // Replacing the socket should continue even if the stale instance refuses to close.
      }
    }

    socketConnected = false;
    socketError = "";
    socketOpenedAt = 0;
    socketUrl = nextSocketUrl;

    const currentSocket = new WebSocket(nextSocketUrl);
    socket = currentSocket;
    postStatus(reason);

    currentSocket.addEventListener("open", () => {
      if (socket !== currentSocket) {
        return;
      }

      hasConnectedAtLeastOnce = true;
      socketConnected = true;
      socketError = "";
      socketOpenedAt = Date.now();
      stopReconnectLoop();
      connectionLossLogged = false;
      postStatus("open");

      if (reason === "manual" || reason === "reconnect") {
        logToBrowserConsole("log", "[mfci] WebSocket connection established.");
      }

      sendSocketHello(currentSocket);
      sendSocketInfo(currentSocket);
      startSocketKeepalive(currentSocket);
    });

    currentSocket.addEventListener("error", () => {
      if (socket !== currentSocket) {
        return;
      }

      stopSocketKeepalive();
      socketConnected = false;
      socketError = hasConnectedAtLeastOnce ? "WebSocket connection failed. Reconnecting..." : "WebSocket connection failed. Retrying...";
      postStatus("error");
      logConnectionLoss("error");
      scheduleReconnect();
    });

    currentSocket.addEventListener("close", () => {
      if (socket !== currentSocket) {
        return;
      }

      stopSocketKeepalive();
      socketConnected = false;
      socketOpenedAt = 0;
      socketError = hasConnectedAtLeastOnce ? "WebSocket disconnected. Reconnecting..." : "WebSocket connection failed. Retrying...";
      postStatus("close");
      logConnectionLoss("close");
      scheduleReconnect();
    });

    currentSocket.addEventListener("message", (event) => {
      if (socket !== currentSocket) {
        return;
      }

      queueBackgroundSocketMessage(event.data);
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== "offscreen" || message.type !== "MFCI_OFFSCREEN_CONNECT") {
      return false;
    }

    (async () => {
      connectSocket({
        url: message.url,
        reason: message.reason,
        forceReconnect: message.forceReconnect === true,
      });
      sendResponse(await waitForSocketStatus());
    })();

    return true;
  });
})();

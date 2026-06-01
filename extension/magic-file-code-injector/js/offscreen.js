(() => {
  const LR_PROTOCOLS = [
    "http://livereload.com/protocols/official-7",
    "http://livereload.com/protocols/official-8",
    "http://livereload.com/protocols/official-9",
  ];
  const RECONNECT_INTERVAL_MS = 2000;
  const RECONNECT_WINDOW_MS = 20000;

  let socket = null;
  let socketUrl = "";
  let socketConnected = false;
  let socketError = "";
  let reconnectTimer = null;
  let reconnectUntil = 0;
  let reconnectSuspended = false;
  let hasConnectedAtLeastOnce = false;
  let connectionLossLogged = false;
  let lastReason = "startup";
  let statusWaiters = [];

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

  function sendToBackground(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError;
      });
    } catch (_error) {
      // No-op
    }
  }

  function postStatus(reason) {
    sendToBackground({
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
    sendToBackground({
      type: "MFCI_OFFSCREEN_LOG",
      target: "background",
      level,
      message,
    });
  }

  function stopReconnectLoop() {
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectUntil = 0;
  }

  function logConnectionLoss(reason) {
    if (connectionLossLogged) {
      return;
    }

    connectionLossLogged = true;
    logToBrowserConsole("warn", `[mfci] WebSocket connection lost (${reason}). Retrying every ${RECONNECT_INTERVAL_MS / 1000}s.`);
  }

  function scheduleReconnect() {
    if (socketConnected || reconnectSuspended || !socketUrl) {
      stopReconnectLoop();
      return;
    }

    const now = Date.now();
    if (reconnectUntil <= now) {
      reconnectUntil = now + RECONNECT_WINDOW_MS;
    }

    if (reconnectTimer) {
      return;
    }

    reconnectTimer = setInterval(() => {
      if (socketConnected) {
        stopReconnectLoop();
        return;
      }

      if (Date.now() >= reconnectUntil) {
        socketError = "WebSocket reconnect timeout (20s). Use Refresh to retry.";
        reconnectSuspended = true;
        logToBrowserConsole("warn", "[mfci] Reconnect attempts stopped after 20s.");
        postStatus("reconnect-timeout");
        stopReconnectLoop();
        return;
      }

      connectSocket({ url: socketUrl, reason: "reconnect" });
    }, RECONNECT_INTERVAL_MS);

    connectSocket({ url: socketUrl, reason: "reconnect" });
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

    if (reconnectSuspended && !isManual && !forceReconnect) {
      postStatus(reason);
      return;
    }

    if (isManual) {
      reconnectSuspended = false;
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
      postStatus(reason);
      return;
    }

    if (socket) {
      socket.close();
      socket = null;
    }

    socketConnected = false;
    socketUrl = nextSocketUrl;
    const currentSocket = new WebSocket(nextSocketUrl);
    socket = currentSocket;
    postStatus(reason);

    currentSocket.addEventListener("open", () => {
      if (socket !== currentSocket) {
        return;
      }

      hasConnectedAtLeastOnce = true;
      reconnectSuspended = false;
      socketConnected = true;
      socketError = "";
      stopReconnectLoop();
      connectionLossLogged = false;
      postStatus("open");

      if (reason !== "startup" && reason !== "keepalive") {
        logToBrowserConsole("log", "[mfci] WebSocket connection established.");
      }

      try {
        currentSocket.send(
          JSON.stringify({
            command: "hello",
            protocols: LR_PROTOCOLS,
            ver: "3.0.0",
          })
        );
      } catch (_error) {
        // Ignore handshake failures and keep listening.
      }
    });

    currentSocket.addEventListener("error", () => {
      if (socket !== currentSocket) {
        return;
      }

      socketConnected = false;
      if (!hasConnectedAtLeastOnce) {
        socketError = "WebSocket connection failed at page load. Use Refresh to retry.";
        reconnectSuspended = true;
        postStatus("error");
        stopReconnectLoop();
        return;
      }

      socketError = "WebSocket connection failed. Reconnecting...";
      postStatus("error");
      logConnectionLoss("error");
      scheduleReconnect();
    });

    currentSocket.addEventListener("close", () => {
      if (socket !== currentSocket) {
        return;
      }

      socketConnected = false;
      if (!hasConnectedAtLeastOnce) {
        socketError = "WebSocket connection failed at page load. Use Refresh to retry.";
        reconnectSuspended = true;
        postStatus("close");
        stopReconnectLoop();
        return;
      }

      socketError = "WebSocket disconnected. Reconnecting...";
      postStatus("close");
      logConnectionLoss("close");
      scheduleReconnect();
    });

    currentSocket.addEventListener("message", (event) => {
      if (socket !== currentSocket) {
        return;
      }

      sendToBackground({
        type: "MFCI_OFFSCREEN_SOCKET_MESSAGE",
        target: "background",
        data: event.data,
      });
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

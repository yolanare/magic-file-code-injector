(() => {
  /**
   * Wrap `chrome.runtime.sendMessage` in Promise form so popup/options logic stays linear and testable.
   * @param {any} payload - Runtime message payload.
   * @returns {Promise<any>} Background response payload.
   */
  function sendRuntimeMessage(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  /**
   * Update one status element with optional error styling in popup/options UIs.
   * @param {HTMLElement} element - Target status element.
   * @param {string} message - Human-readable status text.
   * @param {boolean} isError - True when error style should be active.
   * @returns {void} Mutates status element in-place.
   */
  function setStatusMessage(element, message, isError) {
    element.textContent = message;
    element.classList.toggle("status-error", isError === true);
  }

  self.MfciRuntimeUtils = {
    sendRuntimeMessage,
    setStatusMessage,
  };
})();

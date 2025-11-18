const CONTEXT_MENU_ID = 'edge-read-aloud-selection';
const CONTROL_WINDOW_STORAGE_KEY = 'edge-read-aloud-control-window-id';
let controlWindowId = null;
let creatingWindow = null;
let windowStateReadyPromise = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: '朗读所选文本',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) {
    return;
  }
  queueSpeakText(info.selectionText).catch((error) => {
    console.error('朗读失败', error);
  });
});

chrome.action.onClicked.addListener(async () => {
  if (controlWindowId) {
    try {
      await chrome.windows.remove(controlWindowId);
    } catch (error) {
      console.warn('关闭窗口失败', error);
    }
    persistControlWindowId(null);
    return;
  }
  await openControlWindow();
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === controlWindowId) {
    persistControlWindowId(null);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'edge-read-aloud-request') {
    queueSpeakText(message.text).catch((error) => {
      console.error('朗读失败', error);
    });
  }
});

async function queueSpeakText(rawText) {
  const text = rawText?.trim();
  if (!text) {
    console.warn('未检测到朗读文本');
    return;
  }

  await persistSelectionText(text);
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  chrome.storage.local.set({
    autoSpeakRequest: { id: requestId, text }
  }, async () => {
    await openControlWindow();
    chrome.runtime.sendMessage({
      type: 'edge-read-aloud-auto-speak',
      requestId,
      text
    });
  });
}

function persistSelectionText(text) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ lastText: text }, () => {
      chrome.runtime.sendMessage({ type: 'edge-read-aloud-selection', text });
      resolve();
    });
  });
}

async function openControlWindow() {
  await ensureWindowStateReady();
  if (controlWindowId) {
    try {
      await chrome.windows.update(controlWindowId, { focused: true });
      return controlWindowId;
    } catch (error) {
      persistControlWindowId(null);
    }
  }

  if (creatingWindow) {
    return creatingWindow;
  }

  creatingWindow = chrome.windows.create({
    url: 'popup.html',
    type: 'popup',
    width: 360,
    height: 300,
    focused: true
  }).then((created) => {
    const windowId = created.id || created.windowId || null;
    persistControlWindowId(windowId);
    creatingWindow = null;
    return windowId;
  }).catch((error) => {
    console.error('无法创建控制窗口', error);
    persistControlWindowId(null);
    creatingWindow = null;
    return null;
  });

  return creatingWindow;
}

function ensureWindowStateReady() {
  if (windowStateReadyPromise) {
    return windowStateReadyPromise;
  }
  windowStateReadyPromise = new Promise((resolve) => {
    chrome.storage.local.get({ [CONTROL_WINDOW_STORAGE_KEY]: null }, (items) => {
      const storedId = items[CONTROL_WINDOW_STORAGE_KEY];
      controlWindowId = typeof storedId === 'number' ? storedId : null;
      resolve();
    });
  });
  return windowStateReadyPromise;
}

function persistControlWindowId(id) {
  controlWindowId = id ?? null;
  chrome.storage.local.set({ [CONTROL_WINDOW_STORAGE_KEY]: controlWindowId }, () => {});
}

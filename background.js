const CONTEXT_MENU_ID = 'edge-read-aloud-selection';
let controlWindowId = null;
let creatingWindow = null;

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
    controlWindowId = null;
    return;
  }
  await openControlWindow();
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === controlWindowId) {
    controlWindowId = null;
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
  if (controlWindowId) {
    try {
      await chrome.windows.update(controlWindowId, { focused: true });
      return controlWindowId;
    } catch (error) {
      controlWindowId = null;
    }
  }

  if (creatingWindow) {
    return creatingWindow;
  }

  creatingWindow = chrome.windows.create({
    url: 'popup.html',
    type: 'popup',
    width: 420,
    height: 720,
    focused: true
  }).then((created) => {
    controlWindowId = created.id || created.windowId || null;
    creatingWindow = null;
    return controlWindowId;
  }).catch((error) => {
    console.error('无法创建控制窗口', error);
    creatingWindow = null;
    return null;
  });

  return creatingWindow;
}

import { EdgeTtsClient } from './edgeTtsClient.js';

const voiceSelect = document.getElementById('voiceSelect');
const rateSlider = document.getElementById('rate');
const pitchSlider = document.getElementById('pitch');
const rateValue = document.getElementById('rateValue');
const pitchValue = document.getElementById('pitchValue');
const textInput = document.getElementById('textInput');
const selectionBtn = document.getElementById('selectionBtn');
const speakBtn = document.getElementById('speakBtn');
const pauseBtn = document.getElementById('pauseBtn');
const clearBtn = document.getElementById('clearBtn');
const statusEl = document.getElementById('status');
const player = document.getElementById('player');
const textOverlay = document.getElementById('textOverlay');
const textAreaWrapper = document.querySelector('.text-area-wrapper');
const themeToggle = document.getElementById('themeToggle');
const TEXT_PLAYING_CLASS = 'text-area--playing';
const MAX_SEGMENT_CHARS = 260;

const client = new EdgeTtsClient();
let currentObjectUrl = null;
let isPausedManually = false;
let externalPlayback = null;
let sentenceRanges = [];
let activeSentenceIndex = -1;
let highlightSource = null;
let playbackSessionId = 0;
let totalSegments = 0;
let generatingSegmentIndex = 0;
let audioSegmentsQueue = [];
let currentSegmentMeta = null;
let processedAutoSpeakId = null;
let completedSegmentBuffers = [];
let finalAudioReady = false;

initialize();

async function initialize() {
  await loadVoices();
  await restorePreferences();
  await initTheme();
  await loadLocalState();
  updateSentenceData(textInput.value);
  rateSlider.addEventListener('input', () => updateRangeLabel(rateSlider, rateValue));
  pitchSlider.addEventListener('input', () => updateRangeLabel(pitchSlider, pitchValue));
  textInput.addEventListener('input', handleTextChanged);
  textInput.addEventListener('scroll', syncOverlayScroll);
  selectionBtn.addEventListener('click', handleSelectionClick);
  speakBtn.addEventListener('click', handleSpeak);
  clearBtn.addEventListener('click', clearTextAndStop);
  pauseBtn.addEventListener('click', handlePauseToggle);
  player.addEventListener('ended', () => {
    if (highlightSource === 'local') {
      setTextPlayingState(false);
      currentSegmentMeta = null;
      playNextSegment();
    } else {
      setStatus('播放结束');
      resetPauseButton();
      setTextPlayingState(false);
      clearSentenceHighlight();
      highlightSource = null;
    }
  });
  player.addEventListener('timeupdate', () => {
    if (highlightSource !== 'local') return;
    if (!player.duration || Number.isNaN(player.duration) || !currentSegmentMeta) return;
    updateHighlightByProgress(
      player.currentTime,
      player.duration,
      currentSegmentMeta.start,
      currentSegmentMeta.end - currentSegmentMeta.start
    );
  });
  player.addEventListener('loadedmetadata', () => {
    if (highlightSource === 'local' && currentSegmentMeta) {
      updateHighlightByProgress(0, player.duration || 0, currentSegmentMeta.start, currentSegmentMeta.end - currentSegmentMeta.start);
    }
  });
  resetPauseButton();
  setupMessageListener();
}

async function loadVoices() {
  try {
    const response = await fetch('voices.json');
    const voices = await response.json();
    voiceSelect.innerHTML = '';
    voices.forEach((voice) => {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = `${voice.name} (${voice.locale})`;
      voiceSelect.appendChild(option);
    });
  } catch (error) {
    console.error('加载声音列表失败', error);
    setStatus('加载声音列表失败，可手动输入');
    const fallbackOption = document.createElement('option');
    fallbackOption.value = 'zh-CN-XiaochenMultilingualNeural';
    fallbackOption.textContent = 'zh-CN-XiaochenMultilingualNeural';
    voiceSelect.appendChild(fallbackOption);
  }
}

async function restorePreferences() {
  const defaults = {
    voice: 'zh-CN-XiaochenMultilingualNeural',
    rate: '0',
    pitch: '0'
  };

  try {
    const items = await storageGet(defaults);
    voiceSelect.value = items.voice || defaults.voice;
    rateSlider.value = items.rate;
    pitchSlider.value = items.pitch;
    updateRangeLabel(rateSlider, rateValue, false);
    updateRangeLabel(pitchSlider, pitchValue, false);
  } catch (error) {
    console.warn('读取偏好失败', error);
    rateSlider.value = defaults.rate;
    pitchSlider.value = defaults.pitch;
  }
}

function persistPreferences() {
  storageSet({
    voice: voiceSelect.value,
    rate: rateSlider.value,
    pitch: pitchSlider.value
  });
}

function updateRangeLabel(slider, label, shouldPersist = true) {
  label.textContent = `${slider.value}`;
  if (shouldPersist) {
    persistPreferences();
  }
}

function handleTextChanged() {
  updateSentenceData(textInput.value);
}

function isMultiSymbolRun(text) {
  if (!text) return false;
  const cleaned = text.replace(/\s/g, '');
  if (cleaned.length <= 1) {
    return false;
  }
  return !/[\p{L}\p{N}]/u.test(cleaned);
}

function cancelLocalPlayback(options = {}) {
  const { silent = false } = options;
  playbackSessionId++;
  if (player.src) {
    player.pause();
    player.currentTime = 0;
    player.removeAttribute('src');
    player.load();
  }
  audioSegmentsQueue.forEach(item => URL.revokeObjectURL(item.url));
  audioSegmentsQueue = [];
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  currentSegmentMeta = null;
  generatingSegmentIndex = 0;
  totalSegments = 0;
  completedSegmentBuffers = [];
  finalAudioReady = false;
  resetPauseButton();
  setTextPlayingState(false);
  clearSentenceHighlight();
  highlightSource = null;
  if (!silent) {
    setStatus('播放已停止');
  }
}

async function handleSelectionClick() {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) {
      setStatus('无法获取当前标签页');
      return;
    }

    if (!chrome.scripting?.executeScript) {
      setStatus('当前浏览器版本不支持脚本注入');
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection().toString()
    });
    const selection = results?.[0]?.result?.trim();

    if (selection) {
      textInput.value = selection;
      saveLastSelectionText(selection);
      updateSentenceData(selection);
      setStatus('已插入选中内容');
    } else {
      setStatus('没有检测到选中文本');
    }
  } catch (error) {
    console.error(error);
    setStatus('读取选中文本失败');
  }
}

async function handleSpeak() {
  const text = textInput.value.trim();
  if (!text) {
    setStatus('请先输入文本');
    return;
  }

  toggleBusyState(true);
  resetPauseButton();
  highlightSource = 'local';

  try {
    updateSentenceData(textInput.value);
    const segments = buildSegments(sentenceRanges, textInput.value);
    if (!segments.length) {
      setStatus('没有可朗读的文本');
      return;
    }
    startSegmentPlayback(segments);
  } catch (error) {
    console.error('生成失败', error);
    setStatus(error.message || '生成语音失败');
  } finally {
    toggleBusyState(false);
  }
}

function clearTextAndStop() {
  textInput.value = '';
  if (textOverlay) {
    textOverlay.innerHTML = '';
  }
  saveLastSelectionText('');
  updateSentenceData('');
  stopPlayback();
}

function stopPlayback() {
  if (usingExternalPlayback()) {
    controlExternalPlayback('stop')
      .then(() => {
        setStatus('播放已停止');
        setTextPlayingState(false);
        clearExternalPlaybackState();
      })
      .catch((error) => console.warn('停止外部播放失败', error));
    return;
  }
  cancelLocalPlayback();
}

function toggleBusyState(isBusy) {
  speakBtn.disabled = isBusy;
  selectionBtn.disabled = isBusy;
  pauseBtn.disabled = isBusy || (!player.src && !usingExternalPlayback());
}

function setStatus(message) {
  statusEl.textContent = message || '';
}

voiceSelect.addEventListener('change', persistPreferences);

function storageGet(defaults) {
  return new Promise((resolve, reject) => {
    if (!chrome.storage?.sync) {
      resolve(defaults);
      return;
    }
    chrome.storage.sync.get(defaults, (items) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(err);
      } else {
        resolve(items);
      }
    });
  });
}

function storageSet(payload) {
  return new Promise((resolve, reject) => {
    if (!chrome.storage?.sync) {
      resolve();
      return;
    }
    chrome.storage.sync.set(payload, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  }).catch((error) => console.warn('保存偏好失败', error));
}

function getActiveTab() {
  return new Promise((resolve, reject) => {
    if (!chrome.tabs?.query) {
      reject(new Error('当前环境不允许读取标签页'));
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(err);
      } else {
        resolve(tabs[0]);
      }
    });
  });
}

async function loadLocalState() {
  try {
    const { lastText, externalPlayback: storedPlayback, autoSpeakRequest } = await storageLocalGet({
      lastText: '',
      externalPlayback: null,
      autoSpeakRequest: null
    });
    if (lastText) {
      textInput.value = lastText;
    }
    if (storedPlayback?.tabId) {
      externalPlayback = storedPlayback;
      highlightSource = 'external';
      if (externalPlayback.state === 'paused') {
        isPausedManually = true;
        pauseBtn.textContent = '继续';
      } else {
        isPausedManually = false;
        pauseBtn.textContent = '暂停';
      }
      enablePauseButton();
      const statusText = externalPlayback.segmentNumber && externalPlayback.totalSegments
        ? `右键朗读：第 ${externalPlayback.segmentNumber}/${externalPlayback.totalSegments} 段`
        : '右键朗读中...';
      setStatus(statusText);
      const isPlaying = externalPlayback.state !== 'paused';
      setTextPlayingState(isPlaying);
      const duration = externalPlayback.duration || estimateDuration(textInput.value);
      const segmentStart = externalPlayback.segmentStart ?? 0;
      const segmentLength = externalPlayback.segmentEnd && externalPlayback.segmentStart != null
        ? externalPlayback.segmentEnd - externalPlayback.segmentStart
        : null;
      updateHighlightByProgress(externalPlayback.currentTime || 0, duration, segmentStart, segmentLength);
    }
    if (autoSpeakRequest?.id) {
      handleAutoSpeakRequest(autoSpeakRequest);
    }
  } catch (error) {
    console.warn('读取最近状态失败', error);
  }
}

async function initTheme() {
  try {
    const { theme } = await storageLocalGet({ theme: 'light' });
    applyTheme(theme);
    if (themeToggle) {
      themeToggle.checked = theme === 'dark';
      themeToggle.addEventListener('change', () => {
        const mode = themeToggle.checked ? 'dark' : 'light';
        applyTheme(mode);
        storageLocalSet({ theme: mode }).catch(() => {});
      });
    }
  } catch (error) {
    console.warn('读取主题失败', error);
    applyTheme('light');
  }
}

function saveLastSelectionText(text) {
  storageLocalSet({ lastText: text }).catch((error) => console.warn('保存最近文本失败', error));
}

function storageLocalGet(defaults) {
  return new Promise((resolve, reject) => {
    if (!chrome.storage?.local) {
      resolve(defaults);
      return;
    }
    chrome.storage.local.get(defaults, (items) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(err);
      } else {
        resolve(items);
      }
    });
  });
}

function storageLocalSet(payload) {
  return new Promise((resolve, reject) => {
    if (!chrome.storage?.local) {
      resolve();
      return;
    }
    chrome.storage.local.set(payload, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function applyTheme(mode) {
  document.body.classList.toggle('theme-dark', mode === 'dark');
}

function updateSentenceData(text) {
  sentenceRanges = computeSentenceRanges(text || '');
  activeSentenceIndex = -1;
  renderSentencePreview();
  clearSentenceHighlight();
}

function computeSentenceRanges(text) {
  const ranges = [];
  let start = 0;
  const len = text.length;
  const delimiters = new Set(['。', '！', '？', '!', '?', '；', ';', '.', '…', '\n']);
  for (let i = 0; i < len; i++) {
    const char = text[i];
    const isDelim = delimiters.has(char);
    const isLastChar = i === len - 1;
    if (isDelim) {
      let end = i + 1;
      while (end < len && delimiters.has(text[end])) {
        end++;
      }
      const slice = text.slice(start, end);
      const trimmed = slice.trim();
      const highlightable = trimmed.length > 0 && !isMultiSymbolRun(trimmed);
      ranges.push({ start, end, text: slice, highlightable });
      start = end;
      i = end - 1;
    } else if (isLastChar) {
      const end = len;
      const slice = text.slice(start, end);
      const trimmed = slice.trim();
      const highlightable = trimmed.length > 0 && !isMultiSymbolRun(trimmed);
      ranges.push({ start, end, text: slice, highlightable });
      start = end;
    }
  }
  if (ranges.length === 0 && text.trim().length > 0) {
    const trimmed = text.trim();
    ranges.push({ start: 0, end: len, text, highlightable: !isMultiSymbolRun(trimmed) });
  }
  return ranges;
}

function renderSentencePreview() {
  if (!textOverlay) {
    return;
  }
  if (!sentenceRanges.length) {
    textOverlay.innerHTML = '';
    syncOverlayScroll();
    return;
  }
  const html = sentenceRanges
    .map((sentence, index) =>
      `<span class="text-overlay__sentence" data-sentence-index="${index}">${escapeHtml(sentence.text)}</span>`
    )
    .join('');
  textOverlay.innerHTML = html;
  syncOverlayScroll();
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setupMessageListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'edge-read-aloud-selection' && message.text) {
      textInput.value = message.text;
      saveLastSelectionText(message.text);
      updateSentenceData(message.text);
      setStatus('已同步右键选中文本');
    }
    if (message?.type === 'edge-read-aloud-external-playback') {
      externalPlayback = {
        tabId: message.tabId,
        state: message.state || 'playing'
      };
      highlightSource = 'external';
      storageLocalSet({ externalPlayback }).catch(() => {});
      enablePauseButton();
      setStatus('右键朗读中...');
      if (message.state === 'stopped' || message.state === 'ended') {
        clearExternalPlaybackState();
        setTextPlayingState(false);
        return;
      }
      setTextPlayingState(message.state === 'playing');
      if (message.state === 'paused') {
        isPausedManually = true;
        pauseBtn.textContent = '继续';
      } else if (message.state === 'playing') {
        isPausedManually = false;
        pauseBtn.textContent = '暂停';
      }
    }
    if (message?.type === 'edge-read-aloud-external-progress') {
      externalPlayback = {
        tabId: message.tabId,
        state: message.state || 'playing',
        currentTime: message.currentTime || 0,
        duration: message.duration || 0,
        segmentStart: message.segmentStart,
        segmentEnd: message.segmentEnd,
        segmentNumber: message.segmentNumber,
        totalSegments: message.totalSegments
      };
      highlightSource = 'external';
      storageLocalSet({ externalPlayback }).catch(() => {});
      enablePauseButton();
      const statusText = message.segmentNumber && message.totalSegments
        ? `右键朗读：第 ${message.segmentNumber}/${message.totalSegments} 段`
        : '右键朗读中...';
      setStatus(statusText);
      if (message.state === 'stopped' || message.state === 'ended') {
        setTextPlayingState(false);
        clearExternalPlaybackState();
        return;
      }
      const isPlaying = message.state !== 'paused';
      setTextPlayingState(isPlaying);
      if (message.state === 'paused') {
        isPausedManually = true;
        pauseBtn.textContent = '继续';
      } else {
        isPausedManually = false;
        pauseBtn.textContent = '暂停';
      }
      const duration = message.duration || estimateDuration(textInput.value);
      const segmentStart = message.segmentStart ?? 0;
      const segmentLength = message.segmentEnd && message.segmentStart != null
        ? message.segmentEnd - message.segmentStart
        : null;
      updateHighlightByProgress(message.currentTime || 0, duration, segmentStart, segmentLength);
    }
    if (message?.type === 'edge-read-aloud-auto-speak') {
      handleAutoSpeakRequest({ id: message.requestId, text: message.text });
    }
  });
}

function handlePauseToggle() {
  if (usingExternalPlayback()) {
    toggleExternalPause();
    return;
  }
  if (!player.src) {
    return;
  }
  if (!isPausedManually) {
    player.pause();
    isPausedManually = true;
    pauseBtn.textContent = '继续';
    setStatus('播放已暂停');
    setTextPlayingState(false);
  } else {
    player.play().then(() => {
      isPausedManually = false;
      pauseBtn.textContent = '暂停';
      setStatus('继续播放');
      setTextPlayingState(true);
    }).catch((error) => {
      console.warn('无法继续播放', error);
    });
  }
}

function resetPauseButton() {
  isPausedManually = false;
  pauseBtn.textContent = '暂停';
  pauseBtn.disabled = !player.src && !usingExternalPlayback();
}

function enablePauseButton() {
  pauseBtn.disabled = false;
  pauseBtn.textContent = '暂停';
  isPausedManually = false;
}

function usingExternalPlayback() {
  return Boolean(externalPlayback?.tabId);
}

function toggleExternalPause() {
  if (!usingExternalPlayback()) return;
  if (!isPausedManually) {
    controlExternalPlayback('pause')
      .then(() => {
        isPausedManually = true;
        pauseBtn.textContent = '继续';
        setStatus('播放已暂停');
        updateExternalPlaybackState('paused');
        setTextPlayingState(false);
      })
      .catch((error) => console.warn('暂停外部播放失败', error));
  } else {
    controlExternalPlayback('resume')
      .then(() => {
        isPausedManually = false;
        pauseBtn.textContent = '暂停';
        setStatus('继续播放');
        updateExternalPlaybackState('playing');
        setTextPlayingState(true);
      })
      .catch((error) => console.warn('恢复外部播放失败', error));
  }
}

function controlExternalPlayback(action) {
  if (!usingExternalPlayback()) {
    return Promise.reject(new Error('无外部播放源'));
  }
  if (!chrome.scripting?.executeScript) {
    return Promise.reject(new Error('当前浏览器版本不支持控制播放'));
  }
  return chrome.scripting.executeScript({
    target: { tabId: externalPlayback.tabId },
    func: (act) => {
      const audioElement = window.__edgeReadAloudAudio;
      const queueState = window.__edgeReadAloudQueueState;
      const canSend = typeof chrome !== 'undefined' && chrome.runtime?.sendMessage;
      if (!audioElement) {
        return { success: false };
      }
      if (act === 'pause') {
        audioElement.pause();
      } else if (act === 'resume') {
        audioElement.play().catch(() => {});
      } else if (act === 'stop') {
        audioElement.pause();
        audioElement.currentTime = 0;
        if (queueState) {
          queueState.queue = [];
          queueState.currentMeta = null;
          queueState.playing = false;
          queueState.sessionId = null;
        }
        if (canSend) {
          chrome.runtime.sendMessage({ type: 'edge-read-aloud-external-finished' });
        }
      }
      return { success: true };
    },
    args: [action]
  });
}

function updateExternalPlaybackState(state) {
  if (!externalPlayback) return;
  externalPlayback.state = state;
  storageLocalSet({ externalPlayback }).catch(() => {});
  setTextPlayingState(state === 'playing');
}

function clearExternalPlaybackState(resetButton = true) {
  if (!externalPlayback) {
    if (resetButton) {
      resetPauseButton();
      if (!player.src) {
        setTextPlayingState(false);
        clearSentenceHighlight();
        highlightSource = null;
      }
    }
    return;
  }
  externalPlayback = null;
  storageLocalSet({ externalPlayback: null }).catch(() => {});
  if (resetButton) {
    resetPauseButton();
    if (!player.src) {
      setTextPlayingState(false);
      clearSentenceHighlight();
      highlightSource = null;
    }
  }
}

function setTextPlayingState(isPlaying) {
  if (textAreaWrapper) {
    textAreaWrapper.classList.toggle(TEXT_PLAYING_CLASS, Boolean(isPlaying));
  }
}

function updateHighlightByProgress(currentTime, duration, offset = 0, lengthOverride = null) {
  if (!sentenceRanges.length || !duration || Number.isNaN(duration) || duration <= 0) {
    return;
  }
  const textLength = lengthOverride ?? (textInput.value.length || 1);
  const ratio = Math.min(Math.max(currentTime / duration, 0), 1);
  const targetIndex = offset + Math.floor(ratio * textLength);
  let sentenceIndex = sentenceRanges.findIndex(range => targetIndex < range.end);
  if (sentenceIndex === -1) {
    sentenceIndex = sentenceRanges.length - 1;
  }
  sentenceIndex = findHighlightableIndex(sentenceIndex);
  if (sentenceIndex !== -1) {
    setActiveSentence(sentenceIndex);
  }
}

function setActiveSentence(index) {
  if (!textOverlay || index === activeSentenceIndex) {
    return;
  }
  const prev = textOverlay.querySelector('.text-overlay__sentence--active');
  prev?.classList.remove('text-overlay__sentence--active');
  activeSentenceIndex = index;
  const next = textOverlay.querySelector(`[data-sentence-index="${index}"]`);
  if (next) {
    next.classList.add('text-overlay__sentence--active');
    ensureSentenceVisible(next);
  }
}

function clearSentenceHighlight() {
  if (!textOverlay) return;
  const prev = textOverlay.querySelector('.text-overlay__sentence--active');
  prev?.classList.remove('text-overlay__sentence--active');
  activeSentenceIndex = -1;
}

function estimateDuration(text) {
  const length = text?.length || 1;
  const charsPerSecond = 8; // rough default
  return Math.max(length / charsPerSecond, 1);
}

function syncOverlayScroll() {
  if (!textOverlay) return;
  textOverlay.scrollTop = textInput.scrollTop;
  textOverlay.scrollLeft = textInput.scrollLeft;
}

function findHighlightableIndex(startIndex) {
  if (!sentenceRanges.length) return -1;
  const forward = sentenceRanges.slice(startIndex);
  const forwardIndex = forward.findIndex(range => range.highlightable);
  if (forwardIndex !== -1) {
    return startIndex + forwardIndex;
  }
  for (let i = startIndex - 1; i >= 0; i--) {
    if (sentenceRanges[i].highlightable) {
      return i;
    }
  }
  return -1;
}

function ensureSentenceVisible(element) {
  if (!textOverlay || !element) return;
  const overlayHeight = textOverlay.clientHeight;
  const scrollTop = textOverlay.scrollTop;
  const elementTop = element.offsetTop;
  const elementBottom = elementTop + element.offsetHeight;
  let targetScroll = scrollTop;

  if (elementTop < scrollTop) {
    targetScroll = elementTop - 8;
  } else if (elementBottom > scrollTop + overlayHeight) {
    targetScroll = elementBottom - overlayHeight + 8;
  }

  targetScroll = Math.max(0, targetScroll);
  textOverlay.scrollTop = targetScroll;
  textInput.scrollTop = targetScroll;
}

function handleAutoSpeakRequest(request) {
  if (!request?.id || processedAutoSpeakId === request.id) {
    return;
  }
  processedAutoSpeakId = request.id;
  const text = request.text?.trim();
  if (!text) {
    storageLocalSet({ autoSpeakRequest: null }).catch(() => {});
    return;
  }
  textInput.value = text;
  saveLastSelectionText(text);
  updateSentenceData(text);
  storageLocalSet({ autoSpeakRequest: null }).catch(() => {});
  setTimeout(() => {
    handleSpeak();
  }, 0);
}

function buildSegments(ranges, fullText) {
  if (!fullText) return [];
  const segments = [];

  const pushSegment = (start, end) => {
    if (start === null || end === null || end <= start) return;
    const text = fullText.slice(start, end);
    if (text.trim().length === 0) return;
    segments.push({ start, end, text });
  };

  ranges.forEach(range => {
    const partLength = range.end - range.start;
    if (partLength <= 0 || !range.highlightable) {
      return;
    }
    if (partLength > MAX_SEGMENT_CHARS) {
      for (let pos = range.start; pos < range.end; pos += MAX_SEGMENT_CHARS) {
        const sliceEnd = Math.min(pos + MAX_SEGMENT_CHARS, range.end);
        pushSegment(pos, sliceEnd);
      }
    } else {
      pushSegment(range.start, range.end);
    }
  });

  if (!segments.length && fullText.trim().length) {
    segments.push({ start: 0, end: fullText.length, text: fullText });
  }

  return segments;
}

function startSegmentPlayback(segments) {
  cancelLocalPlayback({ silent: true });
  clearExternalPlaybackState(false);
  highlightSource = 'local';
  const sessionId = ++playbackSessionId;
  totalSegments = segments.length;
  generatingSegmentIndex = 0;
  audioSegmentsQueue = [];
  currentSegmentMeta = null;
  completedSegmentBuffers = [];
  finalAudioReady = false;
  setTextPlayingState(false);
  clearSentenceHighlight();
  if (!totalSegments) {
    setStatus('没有可朗读内容');
    return;
  }

  setStatus(`正在生成第 1/${totalSegments} 段...`);

  const voice = voiceSelect.value;
  const rate = rateSlider.value;
  const pitch = pitchSlider.value;

  (async () => {
    for (let i = 0; i < segments.length; i++) {
      if (sessionId !== playbackSessionId) return;
      try {
        const audioBuffer = await synthesizeWithRetry({
          text: segments[i].text,
          voice,
          rate,
          pitch,
          segmentNumber: i + 1
        });
        if (sessionId !== playbackSessionId) return;
        completedSegmentBuffers.push(audioBuffer);
        const blob = new Blob([audioBuffer], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        audioSegmentsQueue.push({
          url,
          meta: segments[i],
          segmentNumber: i + 1
        });
        generatingSegmentIndex = i + 1;
        if (!currentSegmentMeta && !isPausedManually) {
          playNextSegment();
        }
        if (generatingSegmentIndex < totalSegments) {
          setStatus(`正在生成第 ${generatingSegmentIndex + 1}/${totalSegments} 段...`);
        }
      } catch (error) {
        if (sessionId !== playbackSessionId) return;
        console.error('生成失败', error);
        setStatus(error.message || `第 ${i + 1} 段生成失败`);
        break;
      }
    }
  })();
}

function playNextSegment() {
  if (!audioSegmentsQueue.length) {
    currentSegmentMeta = null;
    if (generatingSegmentIndex >= totalSegments) {
      setStatus('播放结束');
      resetPauseButton();
      setTextPlayingState(false);
      highlightSource = null;
      finalizeFullAudio();
    } else if (totalSegments > 0) {
      setStatus('等待下一段生成...');
    }
    return;
  }

  const next = audioSegmentsQueue.shift();
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
  }
  currentObjectUrl = next.url;
  currentSegmentMeta = next.meta;
  player.src = currentObjectUrl;
  player.play().then(() => {
    setTextPlayingState(true);
    setStatus(`播放第 ${next.segmentNumber}/${totalSegments} 段`);
    enablePauseButton();
  }).catch((error) => {
    console.warn('无法播放音频', error);
    setStatus('播放失败');
  });
}

async function synthesizeWithRetry({ text, voice, rate, pitch, segmentNumber }) {
  let attempt = 0;
  while (true) {
    try {
      attempt++;
      return await client.synthesize({ text, voice, rate, pitch });
    } catch (error) {
      console.warn(`第 ${segmentNumber} 段生成失败，正在重试`, error);
      setStatus(`第 ${segmentNumber} 段生成失败，正在重试(${attempt})...`);
      await delay(Math.min(5000, 1000 * attempt));
    }
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function finalizeFullAudio() {
  if (finalAudioReady || !completedSegmentBuffers.length) {
    return;
  }
  try {
    const totalLength = completedSegmentBuffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    completedSegmentBuffers.forEach(buffer => {
      merged.set(new Uint8Array(buffer), offset);
      offset += buffer.byteLength;
    });
    const blob = new Blob([merged], { type: 'audio/mpeg' });
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
    }
    currentObjectUrl = URL.createObjectURL(blob);
    player.src = currentObjectUrl;
    player.load();
    finalAudioReady = true;
  } catch (error) {
    console.warn('合并音频失败', error);
  }
}

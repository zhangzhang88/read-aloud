(function() {
  const BUTTON_CLASS = 'read-aloud-tweet-btn';
  const STYLE_ID = 'read-aloud-tweet-style';

  if (!/twitter\.com|x\.com/.test(location.hostname)) {
    return;
  }

  init();

  function init() {
    injectStyle();
    new MutationObserver(() => addButtons()).observe(document.body, {
      childList: true,
      subtree: true
    });
    addButtons();
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${BUTTON_CLASS} {
        position: absolute;
        top: 6px;
        right: 6px;
        width: 28px;
        height: 28px;
        border-radius: 999px;
        border: none;
        background: rgba(79,70,229,0.95);
        color: #fff;
        font-size: 16px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 8px rgba(15,23,42,0.28);
        z-index: 10;
        opacity: 0.85;
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .${BUTTON_CLASS}:hover {
        opacity: 1;
        transform: scale(1.05);
      }
    `;
    document.head.appendChild(style);
  }

  function addButtons() {
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');
    tweets.forEach(article => {
      if (article.dataset.readAloudBound) return;
      article.dataset.readAloudBound = '1';
      if (!['relative', 'absolute', 'fixed'].includes(getComputedStyle(article).position)) {
        article.style.position = 'relative';
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = BUTTON_CLASS;
      button.title = '朗读此推文';
      button.textContent = '🔊';
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        event.preventDefault();
        const text = extractTweetText(article);
        if (text) {
          chrome.runtime.sendMessage({
            type: 'edge-read-aloud-request',
            text
          });
        }
      });
      article.appendChild(button);
    });
  }

  function extractTweetText(article) {
    const nodes = getMainTweetNodes(article);
    const parts = [];
    nodes.forEach(node => {
      const cleanNode = node.cloneNode(true);
      cleanNode.querySelectorAll('a').forEach(link => link.remove());
      const content = cleanNode.innerText || cleanNode.textContent || '';
      const normalized = normalizeTextContent(content);
      if (normalized) {
        parts.push(normalized);
      }
    });
    return parts.join(' ').trim();
  }

  function getMainTweetNodes(article) {
    if (!article) return [];
    const primaryNode = article.querySelector('[data-testid="tweetText"]');
    const primaryArticle = primaryNode?.closest('article[data-testid="tweet"], article[role="article"]');
    if (primaryNode && primaryArticle === article) {
      return [primaryNode];
    }
    const selector = '[data-testid="tweetText"], [lang]';
    const allNodes = Array.from(article.querySelectorAll(selector));
    return allNodes.filter(node => {
      const closestArticle = node.closest('article[data-testid="tweet"], article[role="article"]');
      if (closestArticle !== article) {
        return false;
      }
      const tweetContainer = node.closest('[data-testid="tweet"]');
      if (tweetContainer && tweetContainer !== article) {
        return false;
      }
      const quoteLink = node.closest('a[role="link"][data-testid="tweet"]');
      if (quoteLink) {
        return false;
      }
      return true;
    });
  }

  function normalizeTextContent(text) {
    if (!text) return '';
    const withoutUrls = stripUrls(text);
    return withoutUrls.replace(/\s+/g, ' ').trim();
  }

  function stripUrls(text) {
    const patterns = [
      /https?:\/\/[^\s]+/gi,
      /\bwww\.[^\s]+/gi,
      /\bt\.co\/[^\s]+/gi,
      /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/gi
    ];
    return patterns.reduce((result, pattern) => result.replace(pattern, ' '), text);
  }
})();

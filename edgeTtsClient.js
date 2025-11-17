const ENDPOINT_URL = 'https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0';
const SIGNING_KEY = 'oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

export class EdgeTtsClient {
  constructor() {
    this.endpoint = null;
    this.expiredAt = 0;
    this.clientId = this.#uuid();
  }

  async synthesize({ text, voice, rate = 0, pitch = 0 }) {
    if (!text || !text.trim()) {
      throw new Error('请输入需要朗读的文本');
    }

    await this.#ensureEndpoint();

    const ssml = this.#buildSsml(text, voice, rate, pitch);
    const url = `https://${this.endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': this.endpoint.t,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
        'User-Agent': 'okhttp/4.5.0'
      },
      body: ssml
    });

    if (!response.ok) {
      throw new Error(`TTS 请求失败，状态码 ${response.status}`);
    }

    return await response.arrayBuffer();
  }

  async #ensureEndpoint() {
    const now = Date.now() / 1000;
    if (this.endpoint && now < this.expiredAt - 60) {
      return;
    }

    this.endpoint = await this.#fetchEndpoint();
    this.expiredAt = this.#parseExpiry(this.endpoint.t);
    this.clientId = this.#uuid();
  }

  async #fetchEndpoint() {
    const headers = {
      'Accept-Language': 'zh-Hans',
      'X-ClientVersion': '4.0.530a 5fe1dc6c',
      'X-UserId': '0f04d16a175c411e',
      'X-HomeGeographicRegion': 'zh-Hans-CN',
      'X-ClientTraceId': this.clientId,
      'X-MT-Signature': await this.#generateSignature(),
      'User-Agent': 'okhttp/4.5.0',
      'Content-Type': 'application/json; charset=utf-8'
    };

    const res = await fetch(ENDPOINT_URL, {
      method: 'POST',
      headers
    });

    if (!res.ok) {
      throw new Error(`获取 Edge Endpoint 失败，状态码 ${res.status}`);
    }

    return await res.json();
  }

  async #generateSignature() {
    const url = ENDPOINT_URL.split('://')[1];
    const encodedUrl = encodeURIComponent(url);
    const nonce = this.#uuid();
    const formattedDate = this.#formatDate();
    const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${nonce}`.toLowerCase();

    const keyMaterial = EdgeTtsClient.#base64ToBytes(SIGNING_KEY);
    const key = await crypto.subtle.importKey(
      'raw',
      keyMaterial,
      { name: 'HMAC', hash: { name: 'SHA-256' } },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bytesToSign));
    const signature = EdgeTtsClient.#bytesToBase64(new Uint8Array(signatureBuffer));

    return `MSTranslatorAndroidApp::${signature}::${formattedDate}::${nonce}`;
  }

  #buildSsml(text, voice, rate, pitch) {
    const finalVoice = voice || 'zh-CN-XiaochenMultilingualNeural';
    const normalizedRate = Number(rate) || 0;
    const normalizedPitch = Number(pitch) || 0;
    const escapedText = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    return `<?xml version="1.0"?><speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN">
  <voice name="${finalVoice}">
    <mstts:express-as style="general" styledegree="1.0" role="default">
      <prosody rate="${normalizedRate}%" pitch="${normalizedPitch}%" volume="100">${escapedText}</prosody>
    </mstts:express-as>
  </voice>
</speak>`;
  }

  #parseExpiry(token) {
    try {
      const payload = token.split('.')[1];
      if (!payload) return (Date.now() / 1000) + 55 * 60;
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(normalized.length + (4 - (normalized.length % 4 || 4)), '=');
      const json = JSON.parse(atob(padded));
      return json.exp || (Date.now() / 1000) + 55 * 60;
    } catch (error) {
      console.warn('解析 Token 失败，使用默认过期时间', error);
      return (Date.now() / 1000) + 55 * 60;
    }
  }

  #formatDate() {
    const date = new Date();
    const utcString = date.toUTCString().replace('GMT', '').trim();
    return `${utcString} GMT`.toLowerCase();
  }

  #uuid() {
    const globalCrypto = globalThis.crypto || (globalThis.window && window.crypto);
    if (!globalCrypto) {
      throw new Error('当前环境不支持 Web Crypto');
    }
    if (globalCrypto.randomUUID) {
      return globalCrypto.randomUUID().replace(/-/g, '');
    }
    const buffer = new Uint32Array(4);
    globalCrypto.getRandomValues(buffer);
    return Array.from(buffer).map(num => num.toString(16)).join('');
  }

  static #base64ToBytes(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  static #bytesToBase64(bytes) {
    let binary = '';
    bytes.forEach(byte => binary += String.fromCharCode(byte));
    return btoa(binary);
  }
}

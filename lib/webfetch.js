// web_fetch: yalnızca genel (public) http(s) adreslerini okur; yerel/özel ağ adreslerini reddeder.
const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');

function isPrivateIPv4(ip) {
  if (!net.isIPv4(ip)) return true;
  const [a, b, c] = ip.split('.').map(Number);
  // Özel, döngüsel, link-local, dokümantasyon, benchmark ve multicast/rezerve bloklar.
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

// IPv6'i 8 adet 16 bitlik parçaya açar. IPv4 ile yazılmış son bölüm de desteklenir.
function ipv6Groups(ip) {
  let input = String(ip).toLowerCase();
  if (input.includes('%')) return null; // zone-id adreslerini güvenli tarafta kalıp reddet
  if (input.includes('.')) {
    const pos = input.lastIndexOf(':');
    const ipv4 = input.slice(pos + 1);
    if (!net.isIPv4(ipv4)) return null;
    const [a, b, c, d] = ipv4.split('.').map(Number);
    input = `${input.slice(0, pos)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  if ((input.match(/::/g) || []).length > 1) return null;
  const hasCompression = input.includes('::');
  const [leftText, rightText = ''] = input.split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((hasCompression && missing < 1) || (!hasCompression && missing !== 0)) return null;
  const groups = [...left, ...Array(hasCompression ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isPrivateIPv6(ip) {
  const groups = ipv6Groups(ip);
  if (!groups) return true;
  const allZero = groups.every((g) => g === 0);
  const loopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  if (allZero || loopback) return true;

  // ::ffff:0:0/96 dahil IPv4-mapped biçimlerini, noktalı yazılmamış olsa bile denetle.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const a = groups[6] >> 8, b = groups[6] & 255;
    const c = groups[7] >> 8, d = groups[7] & 255;
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
  }

  // Yalnızca global unicast alanı 2000::/3 kabul edilir. Diğer aralıklar (ULA,
  // link-local, multicast, IPv4-compatible/translated vb.) özel kabul edilir.
  if ((groups[0] & 0xe000) !== 0x2000) return true;
  // Dokümantasyon için ayrılmış IPv6 bloğu.
  if (groups[0] === 0x2001 && (groups[1] <= 0x01ff || groups[1] === 0x0db8)) return true;
  // 6to4, Teredo ve bunlara gömülü IPv4 adresleri üzerinden yönlendirme riskini kaldır.
  if (groups[0] === 0x2002) return true;
  return false;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // tanınmayan biçim: güvenli tarafta kal
}

async function resolvePublicUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw new Error('Geçersiz URL.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Yalnızca http ve https adresleri desteklenir.');
  if (u.username || u.password) throw new Error('URL içinde kullanıcı adı/şifre olamaz.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new Error('Yerel adreslere erişilemez.');
  const addresses = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error('Yerel veya özel ağ adreslerine erişilemez.');
  }
  return { url: u, addresses };
}

async function assertPublicUrl(urlStr) {
  return (await resolvePublicUrl(urlStr)).url;
}

const isSupportedContentType = (type) => /^(text\/|application\/(json|xml|xhtml|javascript|x-yaml|yaml)|$)|\+(json|xml)/.test(type);

// HTTP istemcisinin DNS'i tekrar çözmesine izin vermiyoruz: bağlantı yalnızca yukarıda
// doğruladığımız IP'lerden birine kurulur. TLS SNI ve Host başlığı URL'deki alan adında kalır.
function requestPinned(url, addresses, { signal, maxBytes }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    let req;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => {
      const reason = signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('Durduruldu'), { name: 'AbortError' });
      req?.destroy(reason);
    };
    if (signal?.aborted) {
      const reason = signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('Durduruldu'), { name: 'AbortError' });
      finish(reason);
      return;
    }

    const lookup = (_hostname, options, callback) => {
      if (typeof options === 'function') { callback = options; options = {}; }
      const family = options && typeof options === 'object' ? options.family : 0;
      const candidates = family ? addresses.filter((a) => a.family === family) : addresses;
      if (!candidates.length) {
        callback(Object.assign(new Error('Doğrulanmış IP adresi bulunamadı.'), { code: 'EAI_ADDRFAMILY' }));
        return;
      }
      if (options && typeof options === 'object' && options.all) {
        callback(null, candidates.map((a) => ({ address: a.address, family: a.family || net.isIP(a.address) })));
      } else {
        callback(null, candidates[0].address, candidates[0].family || net.isIP(candidates[0].address));
      }
    };

    try {
      req = transport.request(url, {
        method: 'GET',
        lookup,
        headers: {
          'User-Agent': 'emo-code/0.2',
          Accept: 'text/html,text/plain,application/json,*/*;q=0.5',
          Connection: 'close'
        }
      }, (res) => {
        const type = String(res.headers['content-type'] || '').toLowerCase();
        const location = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && location) {
          const value = { status: res.statusCode, type, location, body: Buffer.alloc(0), cut: false };
          res.destroy();
          finish(null, value);
          return;
        }
        if (!isSupportedContentType(type)) {
          res.destroy();
          finish(null, { status: res.statusCode || 0, type, body: Buffer.alloc(0), cut: false, unsupported: true });
          return;
        }
        const chunks = [];
        let size = 0;
        let cut = false;
        res.on('data', (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (size + buf.length > maxBytes) {
            cut = true;
            res.destroy();
            finish(null, { status: res.statusCode || 0, type, body: Buffer.concat(chunks), cut });
            return;
          }
          chunks.push(buf);
          size += buf.length;
        });
        res.on('end', () => finish(null, { status: res.statusCode || 0, type, body: Buffer.concat(chunks), cut }));
        res.on('error', (e) => { if (!settled) finish(e); });
      });
      req.on('error', (e) => finish(e));
      signal?.addEventListener('abort', onAbort, { once: true });
      req.end();
    } catch (e) {
      finish(e);
    }
  });
}

// DuckDuckGo HTML arayüzü üzerinden anahtar gerektirmeyen arama (POST, form gövdesi).
// Sonuç sayfası HTML'dir; bağlantılar /l/?uddg=<hedef> biçiminde yönlendirme içerir.
const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'").replace(/&#x2F;/g, '/').replace(/&nbsp;/g, ' ');
}

function unwrapDdgLink(href) {
  const raw = decodeEntities(String(href || ''));
  const m = /[?&]uddg=([^&]+)/.exec(raw);
  if (!m) return raw.startsWith('//') ? `https:${raw}` : raw;
  try { return decodeURIComponent(m[1]); } catch { return ''; }
}

function parseSearchResults(html, limit) {
  const results = [];
  const blocks = String(html).split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    if (results.length >= limit) break;
    const link = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const url = unwrapDdgLink(link[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeEntities(htmlToText(link[2])).trim();
    const snippetMatch = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
      || /<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const snippet = snippetMatch ? decodeEntities(htmlToText(snippetMatch[1])).trim() : '';
    results.push({ title: title || url, url, snippet });
  }
  return results;
}

// POST isteği: requestPinned yalnızca GET destekler, bu yüzden küçük bir PIN'li POST yardımcıısı kullanırız.
function requestPinnedPost(url, addresses, { signal, maxBytes = 512 * 1024, body }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    let req;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => {
      req?.destroy(signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Durduruldu'), { name: 'AbortError' }));
    };
    if (signal?.aborted) { finish(Object.assign(new Error('Durduruldu'), { name: 'AbortError' })); return; }
    // Node 20+ autoSelectFamily varsayılanı nedeniyle lookup { all: true } ile çağrılır ve
    // dizi beklenir; klasik biçimde tek adres + family döner. İki biçim de desteklenir.
    const lookup = (_h, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      const opts = typeof options === 'object' && options ? options : {};
      const family = opts.family;
      const candidates = family ? addresses.filter((a) => a.family === family) : addresses;
      if (!candidates.length) { cb(Object.assign(new Error('Doğrulanmış IP adresi bulunamadı.'), { code: 'EAI_ADDRFAMILY' })); return; }
      if (opts.all) {
        cb(null, candidates.map((a) => ({ address: a.address, family: a.family || net.isIP(a.address) })));
        return;
      }
      cb(null, candidates[0].address, candidates[0].family || net.isIP(candidates[0].address));
    };
    try {
      req = transport.request(url, {
        method: 'POST',
        lookup,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) emo-code',
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html',
          'Content-Length': Buffer.byteLength(body),
          Connection: 'close'
        }
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) { res.destroy(); finish(null, Buffer.concat(chunks).toString('utf8')); return; }
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
        res.on('error', (e) => { if (!settled) finish(e); });
      });
      req.on('error', (e) => finish(e));
      signal?.addEventListener('abort', onAbort, { once: true });
      req.end(body);
    } catch (e) { finish(e); }
  });
}

async function searchWeb(query, { signal, maxResults = 6, timeoutMs = 15000 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('Arama sorgusu boş olamaz.');
  const url = new URL(DDG_ENDPOINT);
  const { addresses } = await resolvePublicUrl(url.toString());
  const sig = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  const body = `q=${encodeURIComponent(q)}&kl=tr-tr`;
  const html = await requestPinnedPost(url, addresses, { signal: sig, body });
  const limit = Math.min(10, Math.max(1, Number(maxResults) || 6));
  const results = parseSearchResults(html, limit);
  return { query: q, results };
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchUrl(urlStr, { signal, maxBytes = 2 * 1024 * 1024, timeoutMs = 20000 } = {}) {
  const sig = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  let current = urlStr;
  for (let hop = 0; hop <= 5; hop++) {
    const { url, addresses } = await resolvePublicUrl(current);
    const response = await requestPinned(url, addresses, { signal: sig, maxBytes });
    if (response.location) {
      current = new URL(response.location, url).toString();
      continue; // her yönlendirme yeni baştan DNS/IP kontrolünden geçer
    }
    if (response.unsupported) throw new Error(`Desteklenmeyen içerik türü: ${response.type}`);
    let text = response.body.toString('utf8');
    if (response.type.includes('html') || /^\s*<(!doctype|html)/i.test(text)) text = htmlToText(text);
    return { status: response.status, url: url.toString(), text, cut: response.cut };
  }
  throw new Error('Çok fazla yönlendirme.');
}

module.exports = {
  fetchUrl, isPrivateAddress, assertPublicUrl, htmlToText,
  searchWeb, parseSearchResults, requestPinned, requestPinnedPost, resolvePublicUrl
};

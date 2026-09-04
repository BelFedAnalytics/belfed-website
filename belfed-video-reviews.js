(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BelfedVideoReviews = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function safeHttpUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      return url.protocol === 'https:' ? url.toString() : '';
    } catch (_) {
      return '';
    }
  }

  function parseVideoUrl(sourceUrl, explicitEmbedUrl) {
    const explicit = safeHttpUrl(explicitEmbedUrl);
    const source = safeHttpUrl(sourceUrl);
    if (!source && !explicit) return null;
    if (explicit && isAllowedEmbed(explicit)) {
      return { provider: providerName(source || explicit), embedUrl: explicit };
    }
    if (explicit && !source) return null;

    const url = new URL(source);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    let match;

    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      if (id) return youtube(id);
    }
    if (hostMatches(host, 'youtube.com') || hostMatches(host, 'youtube-nocookie.com')) {
      const id = url.searchParams.get('v') || pathId(url.pathname, ['embed', 'shorts', 'live']);
      if (validId(id)) return youtube(id);
    }
    if (hostMatches(host, 'rutube.ru')) {
      match = url.pathname.match(/\/(?:video|play\/embed)\/([a-zA-Z0-9_-]+)/);
      if (match) return {
        provider: 'rutube',
        embedUrl: `https://rutube.ru/play/embed/${encodeURIComponent(match[1])}/`,
      };
    }
    if (hostMatches(host, 'vk.com') || hostMatches(host, 'vkvideo.ru')) {
      match = `${url.pathname}${url.search}`.match(/video(-?\d+)[_/?=&]+(\d+)/);
      const oid = url.searchParams.get('oid');
      const id = url.searchParams.get('id');
      if (match || (oid && id)) {
        return {
          provider: 'vk',
          embedUrl: `https://vk.com/video_ext.php?oid=${encodeURIComponent(match ? match[1] : oid)}&id=${encodeURIComponent(match ? match[2] : id)}&hd=2`,
        };
      }
    }
    return null;
  }

  function pathId(pathname, prefixes) {
    const parts = pathname.split('/').filter(Boolean);
    return prefixes.includes(parts[0]) ? parts[1] : '';
  }

  function hostMatches(host, base) {
    return host === base || host.endsWith(`.${base}`);
  }

  function validId(id) {
    return /^[A-Za-z0-9_-]{6,}$/.test(String(id || ''));
  }

  function youtube(id) {
    if (!validId(id)) return null;
    return {
      provider: 'youtube',
      embedUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?rel=0`,
    };
  }

  function providerName(value) {
    const url = safeHttpUrl(value);
    if (!url) return 'video';
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'youtu.be' || hostMatches(host, 'youtube.com') || hostMatches(host, 'youtube-nocookie.com')) return 'youtube';
    if (hostMatches(host, 'rutube.ru')) return 'rutube';
    if (hostMatches(host, 'vk.com') || hostMatches(host, 'vkvideo.ru')) return 'vk';
    return 'video';
  }

  function isAllowedEmbed(value) {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (hostMatches(host, 'youtube-nocookie.com') || hostMatches(host, 'youtube.com')) {
      return /^\/embed\/[A-Za-z0-9_-]{6,}\/?$/.test(url.pathname);
    }
    if (hostMatches(host, 'rutube.ru')) {
      return /^\/play\/embed\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
    }
    if (hostMatches(host, 'vk.com') || hostMatches(host, 'vkvideo.ru')) {
      return url.pathname === '/video_ext.php'
        && /^-?\d+$/.test(url.searchParams.get('oid') || '')
        && /^\d+$/.test(url.searchParams.get('id') || '');
    }
    return false;
  }

  return { parseVideoUrl, safeHttpUrl, providerName };
});

/*
 * Episode Info — описание серий в списке серий (Lampa).
 *
 * Показывает краткое описание под названием серии:
 *   - в онлайн-просмотре BWA (серии помечены атрибутом data-bwa-num="S5E1");
 *   - на стандартном экране сезона Лампы.
 * Описания берутся из TMDB (русские, если нет — английские) и кэшируются на неделю.
 * Код написан на ES5, чтобы работать на старых WebView телевизоров.
 */
(function () {
  'use strict';

  if (window.episode_info_loaded) return;
  window.episode_info_loaded = true;

  var CACHE_KEY = 'episode_info_cache';
  var CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
  // Описания новых серий на TMDB появляются с опозданием — неполный сезон перезапрашиваем чаще.
  var CACHE_TTL_PARTIAL = 24 * 60 * 60 * 1000;
  var CACHE_LIMIT = 80;
  var REQUEST_TIMEOUT = 15000;

  var SETTING_ENABLED = 'episode_info_enabled';
  var SETTING_FOCUS_ONLY = 'episode_info_focus_only';

  var NUMBER_ATTRS = ['data-bwa-num'];
  var NUMBER_RE = /S(\d+)\s*E(\d+)/i;
  var DONE_ATTR = 'data-episode-info';
  var FOCUS_ONLY_CLASS = 'episode-info--focus-only';
  var TMDB_SOURCES = { tmdb: true, cub: true };

  var STYLE =
    '.season-episode__overview{' +
      'font-size:.95em;line-height:1.35;margin-top:.35em;color:rgba(255,255,255,.6);' +
      'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}' +
    '.season-episode.focus .season-episode__overview{color:rgba(255,255,255,.85);-webkit-line-clamp:6}' +
    'body.episode-info--focus-only .season-episode:not(.focus) .season-episode__overview{display:none}';

  var memory = null;
  var waiting = {};

  function isOn(name, defaultValue) {
    var value = Lampa.Storage.get(name, defaultValue ? 'true' : 'false');
    return value === true || value === 'true';
  }

  // ─────────────────────────────────────────────────────────────
  //  Кэш описаний: { "<id>:<season>": { t: время, e: { "<номер>": "описание" } } }
  // ─────────────────────────────────────────────────────────────

  function readCache() {
    if (!memory) {
      var stored = Lampa.Storage.get(CACHE_KEY, '{}');
      memory = stored && typeof stored === 'object' ? stored : {};
    }
    return memory;
  }

  function writeCache(key, episodes, partial) {
    var cache = readCache();
    cache[key] = { t: Date.now(), e: episodes, p: partial ? 1 : 0 };

    var keys = Object.keys(cache);
    if (keys.length > CACHE_LIMIT) {
      keys.sort(function (a, b) { return cache[a].t - cache[b].t; });
      keys.slice(0, keys.length - CACHE_LIMIT).forEach(function (k) { delete cache[k]; });
    }

    Lampa.Storage.set(CACHE_KEY, cache);
  }

  function cachedSeason(key) {
    var entry = readCache()[key];
    if (!entry) return null;
    return Date.now() - entry.t < (entry.p ? CACHE_TTL_PARTIAL : CACHE_TTL) ? entry.e : null;
  }

  // ─────────────────────────────────────────────────────────────
  //  TMDB
  // ─────────────────────────────────────────────────────────────

  function tmdbSeason(id, season, language, onDone) {
    var url = Lampa.TMDB.api('tv/' + id + '/season/' + season +
      '?api_key=' + Lampa.TMDB.key() + '&language=' + language);
    var network = new Lampa.Reguest();

    network.timeout(REQUEST_TIMEOUT);
    network.silent(url, function (json) {
      onDone(json && json.episodes ? json.episodes : []);
    }, function () {
      onDone([]);
    });
  }

  function overviewMap(episodes) {
    var map = {};
    episodes.forEach(function (episode) {
      var text = (episode.overview || '').trim();
      if (text) map[episode.episode_number] = text;
    });
    return map;
  }

  function loadSeason(id, season, onDone) {
    var key = id + ':' + season;
    var cached = cachedSeason(key);
    if (cached) return onDone(cached);

    if (waiting[key]) return waiting[key].push(onDone);
    waiting[key] = [onDone];

    var finish = function (map, partial) {
      writeCache(key, map, partial);
      var callbacks = waiting[key];
      delete waiting[key];
      callbacks.forEach(function (callback) { callback(map); });
    };

    tmdbSeason(id, season, Lampa.Storage.get('tmdb_lang', 'ru') || 'ru', function (episodes) {
      var map = overviewMap(episodes);
      var missing = episodes.some(function (episode) { return !map[episode.episode_number]; });
      if (episodes.length && !missing) return finish(map, false);

      tmdbSeason(id, season, 'en', function (english) {
        var fallback = overviewMap(english);
        Object.keys(fallback).forEach(function (number) {
          if (!map[number]) map[number] = fallback[number];
        });
        var total = Math.max(episodes.length, english.length);
        finish(map, !total || Object.keys(map).length < total);
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Отрисовка
  // ─────────────────────────────────────────────────────────────

  function insertOverview(element, text) {
    if (!text || element.querySelector('.season-episode__overview')) return;

    var overview = document.createElement('div');
    overview.className = 'season-episode__overview';
    overview.textContent = text;

    var head = element.querySelector('.season-episode__head');
    if (head && head.parentNode) head.parentNode.insertBefore(overview, head.nextSibling);
    else {
      var body = element.querySelector('.season-episode__body');
      if (body) body.appendChild(overview);
    }
  }

  function activeShowId() {
    var activity = Lampa.Activity.active() || {};
    var card = activity.movie || activity.card;
    if (!card) return 0;
    if (card.tmdb_id) return card.tmdb_id;
    return TMDB_SOURCES[card.source || 'tmdb'] ? card.id : 0;
  }

  function episodeNumbers(element) {
    for (var i = 0; i < NUMBER_ATTRS.length; i++) {
      var match = NUMBER_RE.exec(element.getAttribute(NUMBER_ATTRS[i]) || '');
      if (match) return { season: +match[1], episode: +match[2] };
    }
    return null;
  }

  function processElement(element) {
    if (element.hasAttribute(DONE_ATTR)) return;

    var numbers = episodeNumbers(element);
    if (!numbers) return;

    var id = activeShowId();
    if (!id) return;

    element.setAttribute(DONE_ATTR, '1');
    loadSeason(id, numbers.season, function (map) {
      insertOverview(element, map[numbers.episode]);
    });
  }

  function scan(node) {
    if (node.nodeType !== 1) return;
    if (node.classList.contains('season-episode')) return processElement(node);
    if (!node.querySelectorAll) return;

    var list = node.querySelectorAll('.season-episode');
    for (var i = 0; i < list.length; i++) processElement(list[i]);
  }

  function watchOnline() {
    var observer = new MutationObserver(function (mutations) {
      if (!isOn(SETTING_ENABLED, true)) return;
      mutations.forEach(function (mutation) {
        for (var i = 0; i < mutation.addedNodes.length; i++) scan(mutation.addedNodes[i]);
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Стандартный экран сезона уже получает серию из TMDB вместе с описанием.
  function patchSeasonTemplate() {
    var original = Lampa.Template.js;
    if (typeof original !== 'function') return;

    Lampa.Template.js = function (name, data) {
      var element = original.apply(this, arguments);
      if (name === 'season_episode' && data && data.overview && element && element.nodeType === 1 &&
        isOn(SETTING_ENABLED, true)) {
        element.setAttribute(DONE_ATTR, '1');
        insertOverview(element, String(data.overview).trim());
      }
      return element;
    };
  }

  function applyFocusMode() {
    if (isOn(SETTING_FOCUS_ONLY, false)) document.body.classList.add(FOCUS_ONLY_CLASS);
    else document.body.classList.remove(FOCUS_ONLY_CLASS);
  }

  function addStyle() {
    var style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  // ─────────────────────────────────────────────────────────────
  //  Настройки и запуск
  // ─────────────────────────────────────────────────────────────

  function addSettings() {
    if (!Lampa.SettingsApi) return;

    Lampa.SettingsApi.addParam({
      component: 'interface',
      param: { name: SETTING_ENABLED, type: 'trigger', 'default': true },
      field: { name: 'Описание серий', description: 'Краткое описание под названием серии в списке серий' }
    });

    Lampa.SettingsApi.addParam({
      component: 'interface',
      param: { name: SETTING_FOCUS_ONLY, type: 'trigger', 'default': false },
      field: { name: 'Описание серий без спойлеров', description: 'Показывать описание только у выбранной серии' },
      onChange: applyFocusMode
    });
  }

  function start() {
    addStyle();
    addSettings();
    applyFocusMode();
    patchSeasonTemplate();
    watchOnline();
  }

  if (window.appready) start();
  else {
    Lampa.Listener.follow('app', function (event) {
      if (event.type === 'ready') start();
    });
  }
})();

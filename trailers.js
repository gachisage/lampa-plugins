/*
 * Русские трейлеры (Lampa).
 *
 * В TMDB русских трейлеров почти нет, поэтому в карточке были только английские.
 * Плагин ищет русские трейлеры на YouTube и ставит их в начало списка «Трейлеры»,
 * английские из TMDB остаются ниже. Работает для фильмов, сериалов и мультфильмов.
 *
 * Поиск на YouTube:
 *   — в Android-приложении Лампы — напрямую;
 *   — если в настройках указан свой ключ YouTube API — через него;
 *   — иначе через открытые зеркала YouTube (Piped). Зеркала бывают недоступны,
 *     тогда в списке остаются трейлеры из TMDB.
 *
 * Трейлер запускается сам: не нужно ждать «Загрузка…» и нажимать «Плей».
 *
 * Код написан на ES5, чтобы работать на старых WebView телевизоров.
 */
(function () {
  'use strict';

  if (window.gs_trailers_loaded) return;
  window.gs_trailers_loaded = true;

  var COMPONENT = 'gs_trailers';
  var SETTING_ENABLED = 'gs_trailers_enabled';
  var SETTING_KEY = 'gs_trailers_youtube_key';
  var SETTING_AUTOPLAY = 'gs_trailers_autoplay';
  var BRIDGE_FRAME = 'player-video__youtube-bridge-frame';
  var BRIDGE_STARTED = 'gs_trailers_started';
  var CACHE_KEY = 'gs_trailers_cache';
  var CACHE_LIMIT = 200;
  var CACHE_TTL = 7 * 24 * 3600 * 1000;
  var REQUEST_TIMEOUT = 8000;
  var MAX_RESULTS = 6;
  var MIN_DURATION = 20;
  var MAX_DURATION = 7 * 60;
  var PIPED_MIRRORS = [
    'https://api.piped.private.coffee',
    'https://pipedapi.ducks.party',
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de'
  ];

  var TRAILER_WORDS = /трейлер|тизер/i;
  var RUSSIAN_WORDS = /русск|дубляж|на русском/i;
  // Обзоры, реакции и фанатские «концепт-трейлеры» — не трейлеры
  var JUNK_WORDS = /обзор|разбор|реакци|review|react|сравнени|концепт|фанатск|фан[\s-]?трейлер|анти[\s-]?трейлер|fan[\s-]?made|все трейлеры|пародия/i;
  var PREFIX_WORDS = /^(сериал|фильм|мультфильм|мультсериал|аниме|русский|русском|на|трейлер|тизер|официальный|финальный|новый|первый|второй|\d{1,4})$/;
  // Украинские буквы: украинский дубляж тоже на кириллице
  var UKRAINIAN_LETTERS = /[іїєґ]/i;

  var ICON = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="2" y="5" width="20" height="14" rx="3" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M10 9v6l5-3-5-3z" fill="currentColor"/></svg>';

  var pending = {};

  function isOn(name, defaultValue) {
    var value = Lampa.Storage.get(name, defaultValue ? 'true' : 'false');
    return value === true || value === 'true';
  }

  // ─────────────────────────────────────────────────────────────
  //  Сеть
  // ─────────────────────────────────────────────────────────────

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  // done(text или null)
  function getText(url, done) {
    var finished = false;
    var finish = function (text) {
      if (finished) return;
      finished = true;
      done(text);
    };
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = REQUEST_TIMEOUT;
      xhr.onload = function () {
        finish(xhr.status === 200 ? xhr.responseText : null);
      };
      xhr.onerror = function () {
        finish(null);
      };
      xhr.ontimeout = xhr.onerror;
      xhr.send();
    } catch (e) {
      finish(null);
    }
  }

  // Запрос силами Android-приложения: без ограничений CORS
  function canNative() {
    try {
      if (!Lampa.Platform || !Lampa.Platform.is('android')) return false;
      if (typeof AndroidJS === 'undefined' || !AndroidJS.appVersion) return false;
      var code = parseInt(String(AndroidJS.appVersion()).split('-').pop(), 10);
      return code >= 16 && typeof Lampa.Reguest === 'function';
    } catch (e) {
      return false;
    }
  }

  function getNative(url, done) {
    try {
      new Lampa.Reguest().native(url, function (data) {
        done(typeof data === 'string' ? data : null);
      }, function () {
        done(null);
      }, false, { dataType: 'text', timeout: REQUEST_TIMEOUT });
    } catch (e) {
      done(null);
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  Поиск на YouTube. Каждый способ отдаёт список
  //  { id, title, channel, duration (сек или null), time (мс или null) } или null при ошибке
  // ─────────────────────────────────────────────────────────────

  function parseClock(text) {
    if (!text) return null;
    var parts = String(text).split(':');
    var seconds = 0;
    for (var i = 0; i < parts.length; i++) seconds = seconds * 60 + (parseInt(parts[i], 10) || 0);
    return seconds || null;
  }

  function runsText(value) {
    if (!value) return '';
    if (value.simpleText) return value.simpleText;
    return (value.runs || []).map(function (run) {
      return run.text;
    }).join('');
  }

  function collectVideoRenderers(node, found) {
    if (!node || typeof node !== 'object') return;
    if (node.videoRenderer) found.push(node.videoRenderer);
    for (var key in node) {
      if (Object.prototype.hasOwnProperty.call(node, key) && key !== 'videoRenderer') {
        collectVideoRenderers(node[key], found);
      }
    }
  }

  function parseYoutubePage(html) {
    var match = html && html.match(/ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/);
    var data = match && parseJson(match[1]);
    if (!data) return null;
    var renderers = [];
    collectVideoRenderers(data, renderers);
    // Пустая выдача на популярный запрос — значит, YouTube отдал страницу другого вида
    if (!renderers.length) return null;
    return renderers.map(function (video) {
      return {
        id: video.videoId,
        title: runsText(video.title),
        channel: runsText(video.ownerText),
        duration: parseClock(runsText(video.lengthText)),
        time: null
      };
    });
  }

  function searchNative(query, done) {
    var url = 'https://www.youtube.com/results?hl=ru&gl=RU&search_query=' + encodeURIComponent(query);
    getNative(url, function (html) {
      done(parseYoutubePage(html));
    });
  }

  function decodeEntities(text) {
    var box = document.createElement('textarea');
    box.innerHTML = text;
    return box.value;
  }

  function searchApi(query, key, done) {
    var url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=15' +
      '&relevanceLanguage=ru&regionCode=RU&q=' + encodeURIComponent(query) + '&key=' + encodeURIComponent(key);
    getText(url, function (text) {
      var json = parseJson(text);
      if (!json || !json.items) return done(null);
      done(json.items.map(function (item) {
        return {
          id: item.id && item.id.videoId,
          title: decodeEntities(item.snippet.title || ''),
          channel: item.snippet.channelTitle || '',
          duration: null,
          time: item.snippet.publishedAt ? new Date(item.snippet.publishedAt).getTime() : null
        };
      }));
    });
  }

  function parsePiped(text) {
    var json = parseJson(text);
    if (!json || !json.items) return null;
    return json.items.filter(function (item) {
      return item.type === 'stream' && item.url;
    }).map(function (item) {
      return {
        id: item.url.split('v=').pop(),
        title: item.title || '',
        channel: item.uploaderName || '',
        duration: item.duration > 0 ? item.duration : null,
        time: item.uploaded > 0 ? item.uploaded : null
      };
    });
  }

  // Все зеркала сразу: берётся первый ответ, мёртвое зеркало не задерживает поиск
  function searchPiped(query, done) {
    var left = PIPED_MIRRORS.length;
    var finished = false;
    PIPED_MIRRORS.forEach(function (mirror) {
      getText(mirror + '/search?filter=videos&q=' + encodeURIComponent(query), function (text) {
        if (finished) return;
        var list = parsePiped(text);
        left--;
        if (list || !left) {
          finished = true;
          done(list);
        }
      });
    });
  }

  // Способы по очереди: если один не сработал, пробуем следующий
  function searchYoutube(query, done) {
    var key = String(Lampa.Storage.get(SETTING_KEY, '') || '').trim();
    var ways = [];
    if (canNative()) ways.push(searchNative);
    if (key) {
      ways.push(function (text, callback) {
        searchApi(text, key, callback);
      });
    }
    ways.push(searchPiped);

    var next = function (index) {
      if (index >= ways.length) return done(null);
      ways[index](query, function (list) {
        if (list) done(list);
        else next(index + 1);
      });
    };
    next(0);
  }

  // ─────────────────────────────────────────────────────────────
  //  Отбор: только трейлеры этого фильма, на русском
  // ─────────────────────────────────────────────────────────────

  function normalize(text) {
    return String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
  }

  // Название должно стоять в заголовке отдельно и без номера продолжения: «Дюна 3» не трейлер «Дюны».
  // Перед названием — только служебные слова: «Эксперимент „Офис“» не трейлер «Офиса»
  function mentionsTitle(videoTitle, name) {
    var title = ' ' + normalize(videoTitle) + ' ';
    var target = normalize(name);
    if (!target) return false;
    var at = title.indexOf(' ' + target + ' ');
    if (at < 0) return false;
    var before = title.slice(0, at).trim();
    if (before && !before.split(' ').every(function (word) {
      return PREFIX_WORDS.test(word);
    })) return false;
    var after = title.slice(at + target.length + 2).split(' ')[0];
    return !/^\d{1,2}$/.test(after) || target.split(' ').indexOf(after) >= 0;
  }

  function yearsIn(text) {
    return (String(text).match(/\b(19|20)\d{2}\b/g) || []).map(function (year) {
      return parseInt(year, 10);
    });
  }

  // У сериала годы — от премьеры до последней серии: так отсекаются одноимённые ремейки
  function yearFits(videoTitle, card) {
    var years = yearsIn(videoTitle);
    if (!years.length || !card.year) return true;
    var from = card.year - 1;
    var to = (card.isTv ? card.lastYear || card.year : card.year) + 1;
    return years.some(function (year) {
      return year >= from && year <= to;
    });
  }

  function isTrailer(video, card) {
    if (!video.id || !/[а-яё]/i.test(video.title)) return false;
    if (!TRAILER_WORDS.test(video.title) || JUNK_WORDS.test(video.title)) return false;
    if (UKRAINIAN_LETTERS.test(video.title)) return false;
    if (video.duration && (video.duration < MIN_DURATION || video.duration > MAX_DURATION)) return false;
    if (!mentionsTitle(video.title, card.title) && !mentionsTitle(video.title, card.original)) return false;
    return yearFits(video.title, card);
  }

  function score(video, card) {
    var points = 0;
    if (RUSSIAN_WORDS.test(video.title)) points += 2;
    if (card.year && yearsIn(video.title).indexOf(card.year) >= 0) points += 1;
    return points;
  }

  function pickTrailers(list, card) {
    var seen = {};
    return list.filter(function (video) {
      if (seen[video.id] || !isTrailer(video, card)) return false;
      seen[video.id] = true;
      return true;
    }).map(function (video, index) {
      return { video: video, rank: score(video, card) * 100 - index };
    }).sort(function (a, b) {
      return b.rank - a.rank;
    }).slice(0, MAX_RESULTS).map(function (entry) {
      return entry.video;
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Кэш найденного (если ничего не нашлось, в следующий раз ищем снова)
  // ─────────────────────────────────────────────────────────────

  function cacheGet(key) {
    var cache = Lampa.Storage.get(CACHE_KEY, '{}') || {};
    var entry = cache[key];
    return entry && Date.now() - entry.time < CACHE_TTL ? entry.list : null;
  }

  function cacheSet(key, list) {
    var cache = Lampa.Storage.get(CACHE_KEY, '{}') || {};
    cache[key] = { time: Date.now(), list: list };
    var keys = Object.keys(cache);
    if (keys.length > CACHE_LIMIT) {
      keys.sort(function (a, b) {
        return cache[a].time - cache[b].time;
      });
      for (var i = 0; i < keys.length - CACHE_LIMIT; i++) delete cache[keys[i]];
    }
    Lampa.Storage.set(CACHE_KEY, cache);
  }

  function cardInfo(movie) {
    var isTv = !!(movie.name || movie.first_air_date);
    var date = movie.release_date || movie.first_air_date || '';
    return {
      key: (isTv ? 'tv' : 'movie') + ':' + movie.id,
      isTv: isTv,
      title: movie.title || movie.name || '',
      original: movie.original_title || movie.original_name || '',
      year: parseInt(String(date).slice(0, 4), 10) || 0,
      lastYear: parseInt(String(movie.last_air_date || '').slice(0, 4), 10) || 0
    };
  }

  // done(список трейлеров); пока поиск идёт, повторные вызовы ждут тот же ответ
  function findTrailers(card, done) {
    var cached = cacheGet(card.key);
    if (cached) return done(cached);
    if (pending[card.key]) return pending[card.key].push(done);
    pending[card.key] = [done];

    var query = card.title + ' ' + (card.year || '') + ' русский трейлер';
    searchYoutube(query, function (list) {
      var trailers = list ? pickTrailers(list, card) : [];
      if (trailers.length) cacheSet(card.key, trailers);
      var waiting = pending[card.key];
      delete pending[card.key];
      waiting.forEach(function (callback) {
        callback(trailers);
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Список трейлеров в формате плеера Лампы
  // ─────────────────────────────────────────────────────────────

  function thumbnail(id) {
    return 'https://img.youtube.com/vi/' + id + '/default.jpg';
  }

  function formatDuration(seconds) {
    if (!seconds) return '';
    var rest = seconds % 60;
    return Math.floor(seconds / 60) + ':' + (rest < 10 ? '0' : '') + rest;
  }

  function youtubeItem(id, title, subtitle, time) {
    return {
      title: Lampa.Utils.shortText(title, 50),
      subtitle: subtitle,
      id: id,
      time: time || 0,
      url: 'https://www.youtube.com/watch?v=' + id,
      youtube: true,
      icon: '<img class="size-youtube" src="' + thumbnail(id) + '" />',
      template: 'selectbox_icon',
      thumbnail: thumbnail(id)
    };
  }

  function russianItem(video) {
    var subtitle = [video.channel, formatDuration(video.duration)].filter(Boolean).join(' · ');
    return youtubeItem(video.id, video.title, subtitle, video.time);
  }

  function tmdbItem(video) {
    var official = video.official ? 'Официальный' : 'Неофициальный';
    var date = video.published_at ? Lampa.Utils.parseTime(video.published_at).full : '';
    var item = youtubeItem(video.key, video.name || '', official + (date ? ' · ' + date : ''),
      video.published_at ? new Date(video.published_at).getTime() : 0);
    item.lang = video.iso_639_1;
    return item;
  }

  function buildItems(found, tmdbVideos) {
    var ids = {};
    var russian = [];
    found.forEach(function (video) {
      ids[video.id] = true;
      russian.push(russianItem(video));
    });

    var other = [];
    tmdbVideos.forEach(function (video) {
      if (video.site && video.site !== 'YouTube') return;
      if (!video.key || ids[video.key]) return;
      ids[video.key] = true;
      var item = tmdbItem(video);
      if (item.lang === 'ru') russian.push(item);
      else other.push(item);
    });
    other.sort(function (a, b) {
      return b.time - a.time;
    });

    if (russian.length && other.length) other.unshift({ title: 'На других языках', separator: true });
    return russian.concat(other);
  }

  function play(item, items) {
    Lampa.Controller.toggle('content');
    if (Lampa.Platform.is('android') && Lampa.Storage.field('player_launch_trailers') === 'youtube' && Lampa.Android) {
      Lampa.Android.openYoutube(item.id);
      return;
    }
    Lampa.Player.play(item);
    Lampa.Player.playlist(items.filter(function (entry) {
      return !entry.separator;
    }));
  }

  function showList(card, tmdbVideos) {
    Lampa.Loading.start(function () {
      Lampa.Loading.stop();
    });
    findTrailers(card, function (found) {
      Lampa.Loading.stop();
      var items = buildItems(found, tmdbVideos);
      if (!items.length) {
        Lampa.Noty.show('Трейлеры не найдены');
        return;
      }
      Lampa.Select.show({
        title: 'Трейлеры',
        items: items,
        onSelect: function (item) {
          play(item, items);
        },
        onBack: function () {
          Lampa.Controller.toggle('content');
        }
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Кнопка «Трейлеры» в карточке: своя вместо встроенной.
  //  Встроенную Лампа убирает, если в TMDB нет ни одного ролика, — тогда добавляем заново
  // ─────────────────────────────────────────────────────────────

  function createButton() {
    return $('<div class="full-start__button selector view--trailer">' +
      '<svg><use xlink:href="#sprite-trailer"></use></svg><span>Трейлеры</span></div>');
  }

  function onFull(event) {
    if (event.type !== 'complite' || !isOn(SETTING_ENABLED, true)) return;
    var movie = event.data && event.data.movie;
    if (!movie || movie.adult || !movie.id) return;
    if (window.lampa_settings && window.lampa_settings.disable_features && window.lampa_settings.disable_features.trailers) return;

    var body = event.body;
    var button = body.find('.view--trailer');
    if (!button.length) {
      var container = body.find('.buttons--container');
      if (!container.length) return;
      button = createButton();
      container.append(button);
    }

    var card = cardInfo(movie);
    var tmdbVideos = (event.data.videos && event.data.videos.results) || [];
    button.off('hover:enter').on('hover:enter', function () {
      showList(card, tmdbVideos);
    });
    findTrailers(card, function () {});
  }

  // ─────────────────────────────────────────────────────────────
  //  Автозапуск. Встроенный YouTube-плеер Лампы ждёт нажатия «Плей»
  //  и 10 секунд показывает «Загрузка…». Как только плеер YouTube готов,
  //  отправляем ему ту же команду, что и кнопка «Плей»
  // ─────────────────────────────────────────────────────────────

  function bridgeFrame(source) {
    var frames = document.querySelectorAll('.' + BRIDGE_FRAME);
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === source) return frames[i];
    }
    return null;
  }

  function onBridgeMessage(event) {
    var data = event.data;
    if (!data || data.type !== 'ready' || !data.bridgeId || !isOn(SETTING_AUTOPLAY, true)) return;
    var frame = bridgeFrame(event.source);
    if (!frame || frame[BRIDGE_STARTED] === data.bridgeId) return;
    frame[BRIDGE_STARTED] = data.bridgeId;
    frame.contentWindow.postMessage({ bridgeId: data.bridgeId, type: 'play', data: {} }, '*');
  }

  // ─────────────────────────────────────────────────────────────
  //  Настройки и запуск
  // ─────────────────────────────────────────────────────────────

  function addSettings() {
    if (!Lampa.SettingsApi) return;
    Lampa.SettingsApi.addComponent({ component: COMPONENT, name: 'Трейлеры', icon: ICON });
    Lampa.SettingsApi.addParam({
      component: COMPONENT,
      param: { name: SETTING_ENABLED, type: 'trigger', 'default': true },
      field: {
        name: 'Русские трейлеры',
        description: 'Искать русские трейлеры на YouTube и показывать их первыми'
      }
    });
    Lampa.SettingsApi.addParam({
      component: COMPONENT,
      param: { name: SETTING_AUTOPLAY, type: 'trigger', 'default': true },
      field: {
        name: 'Запускать сразу',
        description: 'Трейлер начинает играть сам, без нажатия «Плей»'
      }
    });
    Lampa.SettingsApi.addParam({
      component: COMPONENT,
      param: { name: SETTING_KEY, type: 'input', values: '', placeholder: 'Не обязательно', 'default': '' },
      field: {
        name: 'Ключ YouTube API',
        description: 'Если в браузере трейлеры не находятся: бесплатный ключ YouTube Data API v3 из Google Cloud'
      }
    });
  }

  function start() {
    addSettings();
    Lampa.Listener.follow('full', onFull);
    window.addEventListener('message', onBridgeMessage);
  }

  if (window.appready) start();
  else {
    Lampa.Listener.follow('app', function (event) {
      if (event.type === 'ready') start();
    });
  }
})();

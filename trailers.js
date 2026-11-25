/*
 * Русские трейлеры (Lampa).
 *
 * В TMDB русских трейлеров почти нет, поэтому в карточке были только английские.
 * Плагин ищет русские трейлеры и ставит их в начало списка «Трейлеры»,
 * английские из TMDB остаются ниже. Работает для фильмов, сериалов и мультфильмов.
 *
 * Сначала трейлеры ищутся на ivi: лицензионные, с русским дубляжом, MP4 до 1080p с выбором
 * качества. База ivi — в основном российское кино и то, что сейчас есть в их каталоге.
 *
 * В приложении Лампы (Android, ТВ) трейлеры берутся с RuTube: в России он грузится быстро,
 * видео до 1080p играет в плеере Лампы с выбором качества. Из обычного браузера RuTube
 * недоступен (закрыт CORS), там и если на RuTube ничего не нашлось — поиск на YouTube.
 *
 * Поиск на YouTube:
 *   — в Android-приложении Лампы — напрямую;
 *   — если в настройках указан свой ключ YouTube API — через него;
 *   — иначе через открытые зеркала YouTube (Piped). Зеркала бывают недоступны,
 *     тогда в списке остаются трейлеры из TMDB.
 *
 * Трейлер запускается сам: не нужно ждать «Загрузка…» и нажимать «Плей». Панель управления
 * YouTube выключена: управляет плеер Лампы, а панель YouTube проступала полосой посреди видео.
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
  var IVI_API = 'https://api.ivi.ru/mobileapi';
  var IVI_APP = 'app_version=870';
  var IVI_MAX = 4;
  var IVI_QUALITY = [
    ['MP4-HD1080', '1080p'],
    ['MP4-HD720', '720p'],
    ['MP4-SHQ', '480p'],
    ['MP4-hi', '360p'],
    ['MP4-lo', '240p']
  ];
  var RUTUBE_API = 'https://rutube.ru/api';
  var RUTUBE_REFERER = 'https%3A%2F%2Frutube.ru';
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
  var noCors = false;

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

  // Приложения Лампы для ТВ открываются с локального адреса — там CORS нет
  function isLocalApp() {
    try {
      return /^(file|widget|local):$/i.test(window.location.protocol || '');
    } catch (e) {
      return false;
    }
  }

  function canDirect() {
    return canNative() || isLocalApp();
  }

  // Запрос мимо CORS; в обычном браузере такого способа нет — done(null)
  function getDirect(url, done) {
    if (canNative()) getNative(url, done);
    else if (isLocalApp()) getText(url, done);
    else done(null);
  }

  // ─────────────────────────────────────────────────────────────
  //  ivi: открытое API (CORS разрешён), трейлеры — прямые MP4 разных качеств
  // ─────────────────────────────────────────────────────────────

  function iviGet(path, done) {
    getText(IVI_API + path + (path.indexOf('?') < 0 ? '?' : '&') + IVI_APP, function (text) {
      done(text ? parseJson(text) : null);
    });
  }

  // Название совпадает целиком, тип тот же, годы пересекаются: у ivi много одноимённых передач
  function iviMatches(entry, card) {
    if (!entry || !entry.id || (entry.kind === 2) !== card.isTv) return false;
    if (normalize(entry.title) !== normalize(card.title)) return false;
    var years = entry.years || (entry.year ? [entry.year] : []);
    if (!card.year || !years.length) return true;
    var from = card.year - 1;
    var to = (card.isTv ? card.lastYear || card.year : card.year) + 1;
    return years.some(function (year) {
      return year >= from && year <= to;
    });
  }

  // { '1080p': url, … } от лучшего к худшему — в таком порядке их покажет меню качества
  function iviQuality(files) {
    var quality = {};
    IVI_QUALITY.forEach(function (pair) {
      var file = files.filter(function (entry) {
        return entry.content_format === pair[0] && entry.url;
      })[0];
      if (file) quality[pair[1]] = file.url;
    });
    return quality;
  }

  function iviTrailers(data, card) {
    return data.filter(function (entry) {
      return entry.data_type === 'trailer' && !entry.is_paid && entry.files && entry.files.length;
    }).map(function (entry) {
      return {
        title: card.title + ' — ' + (entry.title || 'Трейлер'),
        duration: parseClock(entry.duration),
        preview: entry.preview || '',
        quality: iviQuality(entry.files)
      };
    }).filter(function (trailer) {
      return Object.keys(trailer.quality).length;
    }).slice(0, IVI_MAX);
  }

  // done(трейлеры ivi). Запоминается только номер тайтла: ссылки на файлы у ivi со сроком действия
  function findIvi(card, done) {
    var key = 'ivi:' + card.key;
    var load = function (id) {
      var path = (card.isTv ? '/compilationinfo' : '/videoinfo') + '/v5/?id=' + id + '&fields=additional_data';
      iviGet(path, function (json) {
        var data = json && json.result && json.result.additional_data;
        done(data && data.length ? iviTrailers(data, card) : []);
      });
    };
    var cached = cacheGet(key);
    if (cached) return load(cached[0]);

    iviGet('/search/v7/?query=' + encodeURIComponent(card.title) + '&from=0&to=20&fields=id,title,kind,year,years', function (json) {
      var hit = ((json && json.result) || []).filter(function (entry) {
        return iviMatches(entry, card);
      })[0];
      if (!hit) return done([]);
      cacheSet(key, [hit.id]);
      load(hit.id);
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  RuTube: поиск и прямой поток HLS с несколькими качествами
  // ─────────────────────────────────────────────────────────────

  function parseRutube(text) {
    var json = parseJson(text);
    if (!json || !json.results) return null;
    return json.results.filter(function (video) {
      return video && video.id && !video.is_adult && !video.is_hidden;
    }).map(function (video) {
      return {
        id: String(video.id),
        title: video.title || '',
        duration: video.duration || 0,
        channel: (video.author && video.author.name) || '',
        thumb: video.thumbnail_url || '',
        source: 'rutube'
      };
    });
  }

  function searchRutube(query, done) {
    getDirect(RUTUBE_API + '/search/video/?query=' + encodeURIComponent(query), function (text) {
      done(text ? parseRutube(text) : null);
    });
  }

  // { '1080p': url, '720p': url, … } из главного плейлиста HLS
  function parseLevels(playlist) {
    var lines = playlist.split('\n');
    var quality = {};
    for (var i = 0; i < lines.length - 1; i++) {
      var match = lines[i].match(/^#EXT-X-STREAM-INF:.*RESOLUTION=\d+x(\d+)/);
      var url = lines[i + 1].trim();
      if (!match || !/^https?:\/\//.test(url)) continue;
      var name = match[1] + 'p';
      if (!quality[name]) quality[name] = url;
    }
    return quality;
  }

  // done({ url, quality } или null). Ссылки подписаны под адрес зрителя, поэтому берутся перед запуском
  function rutubeStream(id, done) {
    var url = RUTUBE_API + '/play/options/' + id + '/?no_404=true&referer=' + RUTUBE_REFERER;
    getDirect(url, function (text) {
      var json = parseJson(text);
      var balancer = json && json.video_balancer;
      var master = balancer && (balancer.m3u8 || balancer['default']);
      if (!master) return done(null);
      getDirect(master, function (playlist) {
        var quality = playlist ? parseLevels(playlist) : {};
        var several = Object.keys(quality).length > 1;
        done({
          url: (several && Lampa.Player.getUrlQuality && Lampa.Player.getUrlQuality(quality)) || master,
          quality: several ? quality : null
        });
      });
    });
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

  // done(список трейлеров); пока поиск идёт, повторные вызовы ждут тот же ответ.
  // Сначала RuTube, если до него можно достучаться, иначе или если там пусто — YouTube
  function findTrailers(card, done) {
    var key = card.key + (canDirect() ? ':rutube' : '');
    var cached = cacheGet(key);
    if (cached) return done(cached);
    if (pending[key]) return pending[key].push(done);
    pending[key] = [done];

    var query = card.title + ' ' + (card.year || '') + ' русский трейлер';
    var finish = function (trailers) {
      if (trailers.length) cacheSet(key, trailers);
      var waiting = pending[key];
      delete pending[key];
      waiting.forEach(function (callback) {
        callback(trailers);
      });
    };
    var youtube = function () {
      searchYoutube(query, function (list) {
        finish(list ? pickTrailers(list, card) : []);
      });
    };

    if (!canDirect()) return youtube();
    searchRutube(query, function (list) {
      var trailers = list ? pickTrailers(list, card) : [];
      if (trailers.length) finish(trailers);
      else youtube();
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

  function iviItem(trailer) {
    var names = Object.keys(trailer.quality);
    var url = (Lampa.Player.getUrlQuality && Lampa.Player.getUrlQuality(trailer.quality)) || trailer.quality[names[0]];
    var item = {
      title: trailer.title,
      subtitle: ['ivi', formatDuration(trailer.duration), 'до ' + names[0]].filter(Boolean).join(' · '),
      url: url,
      ivi: true,
      icon: trailer.preview ? '<img class="size-youtube" src="' + trailer.preview + '" />' : '',
      template: 'selectbox_icon',
      thumbnail: trailer.preview
    };
    if (names.length > 1) item.quality = trailer.quality;
    return item;
  }

  function rutubeItem(video, subtitle) {
    var thumb = video.thumb ? video.thumb + (video.thumb.indexOf('?') < 0 ? '?size=s' : '') : '';
    return {
      title: Lampa.Utils.shortText(video.title, 50),
      subtitle: subtitle ? subtitle + ' · RuTube' : 'RuTube',
      id: video.id,
      rutube: true,
      icon: thumb ? '<img class="size-youtube" src="' + thumb + '" />' : '',
      template: 'selectbox_icon',
      thumbnail: thumb
    };
  }

  function russianItem(video) {
    var subtitle = [video.channel, formatDuration(video.duration)].filter(Boolean).join(' · ');
    if (video.source === 'rutube') return rutubeItem(video, subtitle);
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

  function buildItems(ivi, found, tmdbVideos) {
    var ids = {};
    var russian = ivi.map(iviItem);
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

  // Веб-плеер Лампы ставит видео crossorigin="anonymous", а CDN RuTube не отдаёт заголовков CORS —
  // с этим атрибутом поток не грузится. Пока играет трейлер RuTube, снимаем его с каждого нового видео
  function allowNoCors(video) {
    if (!video.hasAttribute('crossorigin')) return;
    video.removeAttribute('crossorigin');
    if (!video.getAttribute('src')) return;
    video.load();
    var promise = video.play();
    if (promise && typeof promise['catch'] === 'function') promise['catch'](function () {});
  }

  // Мост YouTube в Лампе включает панель управления YouTube, и при движении мыши она проступает
  // полосой посреди видео. Управляет плеером всё равно Лампа, поэтому панель YouTube выключаем
  function hideYoutubeControls(frame) {
    var src = frame.getAttribute('src') || '';
    if (src.indexOf('controls=1') >= 0) frame.setAttribute('src', src.replace('controls=1', 'controls=0'));
  }

  function playerRoot() {
    return Lampa.Player.render ? $(Lampa.Player.render())[0] || null : null;
  }

  function fixPlayer() {
    var root = playerRoot();
    if (!root) return;
    var frames = root.querySelectorAll('.' + BRIDGE_FRAME);
    for (var i = 0; i < frames.length; i++) hideYoutubeControls(frames[i]);
    if (!noCors) return;
    var videos = root.querySelectorAll('video');
    for (var j = 0; j < videos.length; j++) allowNoCors(videos[j]);
  }

  function watchPlayer() {
    var root = playerRoot();
    if (!root || typeof MutationObserver === 'undefined') return;
    new MutationObserver(fixPlayer).observe(root, { childList: true, subtree: true });
  }

  function playRutube(item) {
    var cancelled = false;
    Lampa.Loading.start(function () {
      cancelled = true;
      Lampa.Loading.stop();
    });
    rutubeStream(item.id, function (stream) {
      if (cancelled) return;
      Lampa.Loading.stop();
      if (!stream) {
        Lampa.Noty.show('Не удалось открыть трейлер на RuTube');
        return;
      }
      // Плейлист RuTube подписан и без CORS: играем средствами самого видео, без hls.js
      var data = { title: item.title, url: stream.url, hls_type: 'native' };
      if (stream.quality) data.quality = stream.quality;
      noCors = true;
      fixPlayer();
      Lampa.Player.play(data);
      Lampa.Player.playlist([data]);
    });
  }

  function play(item, items) {
    Lampa.Controller.toggle('content');
    if (item.rutube) {
      playRutube(item);
      return;
    }
    if (item.youtube && Lampa.Platform.is('android') && Lampa.Storage.field('player_launch_trailers') === 'youtube' && Lampa.Android) {
      Lampa.Android.openYoutube(item.id);
      return;
    }
    Lampa.Player.play(item);
    Lampa.Player.playlist(items.filter(function (entry) {
      return !!entry.url;
    }));
  }

  function showList(card, tmdbVideos) {
    var cancelled = false;
    var left = 2;
    var ivi = [];
    var found = [];
    Lampa.Loading.start(function () {
      cancelled = true;
      Lampa.Loading.stop();
    });
    var ready = function () {
      if (--left || cancelled) return;
      Lampa.Loading.stop();
      var items = buildItems(ivi, found, tmdbVideos);
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
    };
    findIvi(card, function (list) {
      ivi = list;
      ready();
    });
    findTrailers(card, function (list) {
      found = list;
      ready();
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
        description: 'Искать русские трейлеры (в приложении — на RuTube, в браузере — на YouTube) и показывать их первыми'
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
    Lampa.Player.listener.follow('destroy', function () {
      noCors = false;
    });
    watchPlayer();
  }

  if (window.appready) start();
  else {
    Lampa.Listener.follow('app', function (event) {
      if (event.type === 'ready') start();
    });
  }
})();

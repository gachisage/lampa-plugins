/*
 * Trakt+ — расширение для плагина TraktTV (Lampa).
 *
 * Что добавляет:
 *   1. Кнопка «Оценить» (1–10) в карточке фильма/сериала с подсветкой уже поставленной оценки.
 *   2. Окно оценки сразу после просмотра (если досмотрено ≥ 85% и тайтл ещё не оценён).
 *   3. Кнопка «Не моё»: скрывает тайтл из рекомендаций Trakt и из рядов этого плагина,
 *      по желанию удаляет случайный просмотр из истории.
 *   4. Ряды персональных рекомендаций Couchmoney на главном экране
 *      (с русскими названиями и постерами из TMDB).
 *   5. Ряды «Вам может понравиться»: собственный подбор по оценкам, истории просмотров,
 *      лайкам и избранному через рекомендации TMDB. Работает и без Couchmoney.
 *
 * Требуется установленный и авторизованный TraktTV.js — токен берётся из Lampa.Storage('trakt_token').
 * Код написан на ES5, чтобы работать на старых WebView телевизоров.
 */
(function () {
  'use strict';

  if (window.trakt_plus_loaded) return;
  window.trakt_plus_loaded = true;

  // ─────────────────────────────────────────────────────────────
  //  Константы
  // ─────────────────────────────────────────────────────────────

  // Тот же прокси, что и у основного плагина: в браузере на ПК прямые запросы к Trakt режет CORS
  var PROXY_BASE = 'https://apx.lme.isroot.in/trakt';
  var DIRECT_BASE = 'https://api.trakt.tv';
  // Client ID для прямых запросов с ТВ. Если в основном плагине задан свой — берём его
  var DEFAULT_CLIENT_ID = 'da2f995ec6a243546438f011272eb0a6f457048473527e4ee35b633100175f35';

  var MINUTE = 60 * 1000;
  var HOUR = 60 * MINUTE;
  var DAY = 24 * HOUR;

  var RATINGS_TTL = 15 * MINUTE;      // кэш оценок пользователя
  var LISTS_TTL = 3 * HOUR;           // кэш списков Couchmoney и их содержимого
  var META_TTL = 14 * DAY;            // кэш русских названий/постеров из TMDB
  var META_MAX = 800;                 // максимум записей в кэше TMDB
  var PROMPT_COOLDOWN = 7 * DAY;      // не спрашивать оценку одного тайтла чаще
  var NOTICE_COOLDOWN = DAY;          // подсказка «Couchmoney не подключён» — не чаще раза в сутки

  var ROW_LIMIT = 20;                 // карточек в ряду
  var LIST_FETCH_LIMIT = 40;          // берём с запасом: часть отфильтруется
  var TMDB_CONCURRENCY = 4;
  var AUTORATE_THRESHOLD = 85;        // % просмотра для окна оценки
  var AUTORATE_DELAY = 1500;
  var REQUEST_TIMEOUT = 15000;

  var KEY = {
    ratings: 'trakt_plus_ratings',
    lists: 'trakt_plus_couch_lists',
    itemsPrefix: 'trakt_plus_items_',
    smart: 'trakt_plus_smart',
    hidden: 'trakt_plus_hidden',
    meta: 'trakt_plus_meta',
    prompted: 'trakt_plus_prompted',
    notice: 'trakt_plus_notice_time'
  };

  var SETTING = {
    rows: 'trakt_plus_rows',
    smart: 'trakt_plus_smart_rows',
    autorate: 'trakt_plus_autorate',
    autorateShows: 'trakt_plus_autorate_shows',
    markWatched: 'trakt_plus_rate_marks_watched'
  };

  var RATING_LABELS = {
    10: 'Шедевр',
    9: 'Великолепно',
    8: 'Отлично',
    7: 'Хорошо',
    6: 'Неплохо',
    5: 'Средне',
    4: 'Так себе',
    3: 'Плохо',
    2: 'Очень плохо',
    1: 'Ужасно'
  };

  // Ряды под списки Couchmoney: у бесплатного Trakt не больше 5 списков.
  // Названия списков пользователь задаёт сам, поэтому ряд получает список по порядку,
  // а заголовок вычисляется из типа списка (см. couchTitle).
  var COUCH_ROWS = 5;
  var COUCH_FIRST_INDEX = 2;
  var COUCH_ORDER = { rec: 0, recent: 1, based: 2 };
  var KIND_WORD = { movie: 'фильмы', tv: 'сериалы' };
  // Слова, которые не несут смысла в названии списка: «Movies - Recommendations (Couchmoney)» → пусто
  var COUCH_GENERIC_WORDS = /\b(movies?|films?|tv|shows?|series|recommend\w*|recs?|lists?|for me|my|your|based on recently watched)\b/gi;
  var SMART_ROWS = [
    { name: 'TraktPlusSmartMovies', kind: 'movie', title: 'Вам может понравиться: фильмы', index: 2 },
    { name: 'TraktPlusSmartShows', kind: 'tv', title: 'Вам может понравиться: сериалы', index: 3 }
  ];

  var SMART_TTL = 6 * HOUR;
  var SMART_SEEDS = 15;               // сколько «семян» вкуса брать в расчёт
  var SMART_NEGATIVE_SEEDS = 5;       // сколько низких оценок учитывать как минус
  var SMART_SEED_MAX_WEIGHT = 6;
  var SMART_RECENT_DAYS = 120;        // оценки за этот срок весят в 1.5 раза больше
  var SMART_HISTORY_LIMIT = 60;
  var SMART_MIN_VOTES = 40;           // отсекаем малоизвестный мусор TMDB
  var SMART_KEEP = 40;

  var STAR_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';
  var HIDE_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 0 1 6.32 12.9L7.1 5.68A7.96 7.96 0 0 1 12 4zM4 12c0-1.85.63-3.55 1.68-4.9L16.9 18.32A8 8 0 0 1 4 12z"/></svg>';

  // ─────────────────────────────────────────────────────────────
  //  Общие утилиты
  // ─────────────────────────────────────────────────────────────

  function now() {
    return new Date().getTime();
  }

  function token() {
    return Lampa.Storage.get('trakt_token', '') || '';
  }

  function isOn(name, defaultValue) {
    var value = Lampa.Storage.get(name, defaultValue ? 'true' : 'false');
    return value === true || value === 'true';
  }

  function notify(text) {
    try {
      Lampa.Noty.show(text);
    } catch (e) { /* уведомления недоступны — не критично */ }
  }

  function language() {
    return Lampa.Storage.get('language', 'ru') || 'ru';
  }

  // Контроллер, на который вернуть фокус после закрытия Lampa.Select
  function currentController() {
    try {
      var enabled = Lampa.Controller.enabled();
      if (enabled && enabled.name) return enabled.name;
    } catch (e) { /* старая версия Lampa */ }
    return 'content';
  }

  // Запустить несколько асинхронных задач параллельно: task(cb(err, result))
  function runAll(tasks, done) {
    var left = tasks.length;
    var results = [];
    var firstError = null;
    if (!left) {
      done(null, results);
      return;
    }
    tasks.forEach(function (task, index) {
      task(function (err, result) {
        if (err && !firstError) firstError = err;
        results[index] = result;
        left--;
        if (left === 0) done(firstError, results);
      });
    });
  }

  // Ограничение параллельности: worker(item, cb) по `limit` штук одновременно
  function runLimited(items, limit, worker, done) {
    var cursor = 0;
    var active = 0;
    var finished = 0;
    if (!items.length) {
      done();
      return;
    }
    function next() {
      while (active < limit && cursor < items.length) {
        active++;
        worker(items[cursor++], function () {
          active--;
          finished++;
          if (finished === items.length) done();
          else next();
        });
      }
    }
    next();
  }

  // Склеивание одинаковых параллельных загрузок в одну
  var inflight = {};
  function shared(key, loader, callback) {
    if (inflight[key]) {
      inflight[key].push(callback);
      return;
    }
    inflight[key] = [callback];
    loader(function (result) {
      var waiters = inflight[key] || [];
      delete inflight[key];
      waiters.forEach(function (fn) {
        fn(result);
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Кэш в Lampa.Storage (+ копия в памяти, чтобы не парсить JSON каждый раз)
  // ─────────────────────────────────────────────────────────────

  var memoryCache = {};

  function cacheRead(key) {
    if (memoryCache[key]) return memoryCache[key];
    var stored = Lampa.Storage.get(key, '');
    if (stored && typeof stored === 'object' && stored.time) {
      memoryCache[key] = stored;
      return stored;
    }
    return null;
  }

  function cacheGet(key, ttl) {
    var entry = cacheRead(key);
    if (entry && now() - entry.time < ttl) return entry.data;
    return null;
  }

  // Данные без учёта срока — запасной вариант, если сеть недоступна
  function cacheGetStale(key) {
    var entry = cacheRead(key);
    return entry ? entry.data : null;
  }

  function cacheSet(key, data, keepTime) {
    var old = cacheRead(key);
    var entry = { time: keepTime && old ? old.time : now(), data: data };
    memoryCache[key] = entry;
    Lampa.Storage.set(key, entry);
  }

  function cacheRemove(key) {
    delete memoryCache[key];
    Lampa.Storage.set(key, '');
  }

  function clearRecommendationCaches() {
    cacheRemove(KEY.lists);
    cacheRemove(KEY.smart);
    cacheRemove(KEY.ratings);
    try {
      Object.keys(localStorage).forEach(function (key) {
        if (key.indexOf(KEY.itemsPrefix) === 0) cacheRemove(key);
      });
    } catch (e) { /* localStorage недоступен */ }
  }

  // Простые словари «ключ → значение» в Storage (скрытые тайтлы, история окон оценки)
  function readMap(key) {
    var value = Lampa.Storage.get(key, '');
    return value && typeof value === 'object' ? value : {};
  }

  function writeMap(key, map, maxSize) {
    var keys = Object.keys(map);
    if (maxSize && keys.length > maxSize) {
      keys.sort(function (a, b) {
        return (map[a] || 0) - (map[b] || 0);
      });
      keys.slice(0, keys.length - maxSize).forEach(function (k) {
        delete map[k];
      });
    }
    Lampa.Storage.set(key, map);
  }

  // ─────────────────────────────────────────────────────────────
  //  Описание тайтла
  // ─────────────────────────────────────────────────────────────

  // 'movie' или 'tv'
  function kindOf(card, method) {
    if (method === 'tv' || method === 'show') return 'tv';
    if (method === 'movie') return 'movie';
    if (!card) return 'movie';
    if (card.method === 'tv' || card.card_type === 'tv' || card.type === 'tv' || card.media_type === 'tv') return 'tv';
    if (card.method === 'movie' || card.card_type === 'movie' || card.type === 'movie' || card.media_type === 'movie') return 'movie';
    if (card.first_air_date || card.number_of_seasons) return 'tv';
    if (card.name && !card.title) return 'tv';
    return 'movie';
  }

  function titleOf(card) {
    return (card && (card.title || card.name || card.original_title || card.original_name)) || '';
  }

  function itemKey(kind, tmdbId) {
    return kind + ':' + tmdbId;
  }

  // Тело запроса Trakt: {movies: [...]} или {shows: [...]}
  function traktBody(kind, entry) {
    var body = {};
    body[kind === 'tv' ? 'shows' : 'movies'] = [entry];
    return body;
  }

  // ─────────────────────────────────────────────────────────────
  //  Запросы к Trakt API
  // ─────────────────────────────────────────────────────────────

  // На ТВ и в локальных сборках CORS нет — ходим в Trakt напрямую, иначе через прокси
  var corsFree = (function detectCorsFree() {
    try {
      var protocol = (window.location.protocol || '').toLowerCase();
      if (protocol === 'file:' || protocol === 'widget:' || protocol === 'local:') return true;
      if (/LampaApp|Tizen|WebOS|SmartTV/i.test(navigator.userAgent || '')) return true;
    } catch (e) { /* считаем, что CORS есть */ }
    return false;
  })();

  function clientId() {
    var id = '';
    try {
      id = Lampa.Storage.field('trakt_client_id') || '';
    } catch (e) { /* поле не зарегистрировано */ }
    id = String(id || '').replace(/^\s+|\s+$/g, '');
    return id || DEFAULT_CLIENT_ID;
  }

  function traktHeaders(direct) {
    var headers = {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'x-requested-with': 'lme-plugins',
      'Authorization': 'Bearer ' + token()
    };
    if (direct) headers['trakt-api-key'] = clientId();
    return headers;
  }

  /**
   * Запрос к Trakt. onSuccess(data) / onError({status}).
   * При сетевой/CORS-ошибке прямого запроса (status 0) повторяет через прокси
   * и до конца сессии работает через прокси.
   */
  function traktRequest(method, path, body, onSuccess, onError) {
    if (!token()) {
      if (onError) onError({ status: 401 });
      return;
    }

    function attempt(direct) {
      $.ajax({
        url: (direct ? DIRECT_BASE : PROXY_BASE) + path,
        type: method,
        headers: traktHeaders(direct),
        contentType: 'application/json',
        data: body ? JSON.stringify(body) : undefined,
        dataType: 'json',
        timeout: REQUEST_TIMEOUT,
        success: function (data) {
          if (onSuccess) onSuccess(data);
        },
        error: function (xhr) {
          var status = xhr ? xhr.status : 0;
          if (direct && status === 0) {
            corsFree = false;
            attempt(false);
            return;
          }
          // 204 No Content при dataType json приходит как ошибка разбора — это успех
          if (status >= 200 && status < 300) {
            if (onSuccess) onSuccess(null);
            return;
          }
          if (onError) onError({ status: status });
        }
      });
    }

    attempt(corsFree);
  }

  // Обёртки в формате задач для runAll
  function traktTask(method, path, body) {
    return function (cb) {
      traktRequest(method, path, body, function (data) {
        cb(null, data);
      }, function (err) {
        cb(err);
      });
    };
  }

  function errorText(err) {
    var status = err && err.status;
    if (status === 401 || status === 403) return 'Trakt: нужна повторная авторизация';
    if (status === 429) return 'Trakt: слишком много запросов, попробуйте позже';
    if (status === 0) return 'Trakt: нет связи с сервером';
    return 'Trakt: ошибка ' + (status || '');
  }

  function hasNotFound(response) {
    var nf = response && response.not_found;
    return !!(nf && ((nf.movies && nf.movies.length) || (nf.shows && nf.shows.length)));
  }

  // ─────────────────────────────────────────────────────────────
  //  Запросы к TMDB (через встроенный в Lampa прокси TMDB)
  // ─────────────────────────────────────────────────────────────

  function tmdbGet(path, onSuccess, onError) {
    if (!Lampa.TMDB || typeof Lampa.TMDB.api !== 'function') {
      onError();
      return;
    }
    var separator = path.indexOf('?') === -1 ? '?' : '&';
    var url = Lampa.TMDB.api(path + separator + 'api_key=' + Lampa.TMDB.key() + '&language=' + language());
    var network = new Lampa.Reguest();
    network.timeout(REQUEST_TIMEOUT);
    network.silent(url, function (data) {
      onSuccess(data);
    }, function () {
      onError();
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Модуль 1. Оценки пользователя
  // ─────────────────────────────────────────────────────────────

  // Карта оценок: { 'movie:123': { r: 8, at: '2026-01-01T…', t: 'Title' } }
  function loadRatings(force, callback) {
    if (!force) {
      var cached = cacheGet(KEY.ratings, RATINGS_TTL);
      if (cached) {
        callback(cached);
        return;
      }
    }
    shared('ratings', function (done) {
      runAll([
        traktTask('GET', '/sync/ratings/movies'),
        traktTask('GET', '/sync/ratings/shows')
      ], function (err, results) {
        if (err) {
          done(cacheGetStale(KEY.ratings) || {});
          return;
        }
        var map = {};
        collectRatings(map, results[0], 'movie');
        collectRatings(map, results[1], 'tv');
        cacheSet(KEY.ratings, map);
        done(map);
      });
    }, callback);
  }

  function collectRatings(map, list, kind) {
    if (!list || !list.length) return;
    list.forEach(function (row) {
      var media = row.movie || row.show;
      var tmdb = media && media.ids && media.ids.tmdb;
      if (!tmdb) return;
      map[itemKey(kind, tmdb)] = { r: row.rating, at: row.rated_at || '', t: media.title || '' };
    });
  }

  function ratingFrom(map, kind, tmdbId) {
    var entry = map && map[itemKey(kind, tmdbId)];
    return entry ? entry.r : 0;
  }

  // Обновить кэш локально, не дожидаясь перезагрузки с сервера
  function storeLocalRating(card, kind, rating) {
    var map = cacheGetStale(KEY.ratings) || {};
    var key = itemKey(kind, card.id);
    if (rating) map[key] = { r: rating, at: new Date().toISOString(), t: titleOf(card) };
    else delete map[key];
    cacheSet(KEY.ratings, map, true);
  }

  function sendRating(card, kind, rating, done) {
    var entry = { ids: { tmdb: card.id } };
    if (rating) entry.rating = rating;
    var path = rating ? '/sync/ratings' : '/sync/ratings/remove';

    traktRequest('POST', path, traktBody(kind, entry), function (response) {
      if (rating && hasNotFound(response)) {
        notify('Trakt не нашёл этот тайтл');
        if (done) done(false);
        return;
      }
      storeLocalRating(card, kind, rating);
      notify(rating ? 'Оценка ' + rating + '/10 сохранена в Trakt' : 'Оценка удалена');
      if (rating && isOn(SETTING.markWatched, true)) markWatched(card, kind);
      if (done) done(true);
    }, function (err) {
      notify(errorText(err));
      if (done) done(false);
    });
  }

  // Оценил — значит смотрел: отмечаем «Просмотрено» в Лампе, а фильм — ещё и в истории Trakt
  function markWatched(card, kind) {
    try {
      var state = Lampa.Favorite.check(card);
      if (!state || !state.viewed) Lampa.Favorite.add('viewed', card);
    } catch (e) { /* закладки Лампы недоступны */ }

    // Для сериала история Trakt отметила бы все серии разом — не трогаем
    if (kind !== 'movie') return;

    traktRequest('GET', '/search/tmdb/' + card.id + '?type=movie', null, function (found) {
      var movie = found && found[0] && found[0].movie;
      var traktId = movie && movie.ids && movie.ids.trakt;
      if (!traktId) return;
      traktRequest('GET', '/sync/history/movies/' + traktId + '?limit=1', null, function (plays) {
        if (plays && plays.length) return;
        // watched_at: released — фильм не попадёт в «недавно просмотренное» как свежий просмотр
        traktRequest('POST', '/sync/history', traktBody('movie', { ids: { tmdb: card.id }, watched_at: 'released' }), null, null);
      }, null);
    }, null);
  }

  /**
   * Меню выбора оценки.
   * options: { card, kind, current, header, prompt (окно после плеера), onDone }
   */
  function openRatingSelect(options) {
    var back = currentController();
    var items = [];
    var rating;
    for (rating = 10; rating >= 1; rating--) {
      items.push({ title: rating + ' — ' + RATING_LABELS[rating], rating: rating, selected: options.current === rating });
    }
    if (options.current) items.push({ title: 'Удалить оценку', action: 'remove' });
    if (options.prompt) {
      items.push({ title: 'Позже', action: 'later' });
      items.push({ title: 'Не спрашивать про этот тайтл', action: 'never' });
    }

    Lampa.Select.show({
      title: options.header,
      items: items,
      onSelect: function (item) {
        Lampa.Controller.toggle(back);
        if (item.action === 'later') return;
        if (item.action === 'never') {
          markPrompted(options.kind, options.card.id, true);
          return;
        }
        sendRating(options.card, options.kind, item.action === 'remove' ? 0 : item.rating, options.onDone);
      },
      onBack: function () {
        Lampa.Controller.toggle(back);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Кнопки в карточке (модули 1 и 3)
  // ─────────────────────────────────────────────────────────────

  function injectStyle() {
    if (document.getElementById('trakt-plus-style')) return;
    var css = '' +
      '.trakt-rate-button--rated > svg { color: #ffd700; }' +
      '.trakt-rate-button--rated:not(.focus) > span { color: #ffd700; }';
    var style = document.createElement('style');
    style.id = 'trakt-plus-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function makeButton(className, svg, text) {
    return $('<div class="full-start__button selector ' + className + '">' + svg + '<span>' + text + '</span></div>');
  }

  function paintRateButton(button, rating) {
    button.find('span').text(rating ? 'Оценка: ' + rating + '/10' : 'Оценить');
    button.toggleClass('trakt-rate-button--rated', !!rating);
  }

  function onFullScreen(e) {
    if (e.type !== 'complite' || !token()) return;
    var card = e.data && e.data.movie;
    if (!card || !card.id || !e.object || !e.object.activity) return;

    var kind = kindOf(card, e.object.method);
    var box = e.object.activity.render().find('.full-start-new__buttons');
    if (!box.length) return;

    if (!box.find('.trakt-rate-button').length) {
      var rateButton = makeButton('trakt-rate-button', STAR_SVG, 'Оценить');
      box.append(rateButton);

      loadRatings(false, function (map) {
        paintRateButton(rateButton, ratingFrom(map, kind, card.id));
      });

      rateButton.on('hover:enter', function () {
        loadRatings(false, function (map) {
          openRatingSelect({
            card: card,
            kind: kind,
            current: ratingFrom(map, kind, card.id),
            header: 'Оценка: ' + titleOf(card),
            onDone: function () {
              paintRateButton(rateButton, ratingFrom(cacheGetStale(KEY.ratings), kind, card.id));
            }
          });
        });
      });
    }

    if (!box.find('.trakt-hide-button').length) {
      var hideButton = makeButton('trakt-hide-button', HIDE_SVG, 'Не моё');
      box.append(hideButton);
      hideButton.on('hover:enter', function () {
        openHideMenu(card, kind);
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  Модуль 3. «Не моё»
  // ─────────────────────────────────────────────────────────────

  function isHidden(kind, tmdbId) {
    return !!readMap(KEY.hidden)[itemKey(kind, tmdbId)];
  }

  function openHideMenu(card, kind) {
    var back = currentController();
    Lampa.Select.show({
      title: 'Не моё: ' + titleOf(card),
      items: [
        { title: 'Скрыть из рекомендаций', subtitle: 'Больше не появится в рядах рекомендаций', purge: false },
        { title: 'Скрыть и удалить из истории', subtitle: 'Если просмотр был случайным — чтобы он не влиял на вкусы', purge: true }
      ],
      onSelect: function (item) {
        Lampa.Controller.toggle(back);
        hideTitle(card, kind, item.purge);
      },
      onBack: function () {
        Lampa.Controller.toggle(back);
      }
    });
  }

  function hideTitle(card, kind, purge) {
    // Локальный фильтр срабатывает сразу и не зависит от того, учтёт ли Couchmoney скрытие
    var hidden = readMap(KEY.hidden);
    hidden[itemKey(kind, card.id)] = now();
    writeMap(KEY.hidden, hidden, 2000);

    var entry = { ids: { tmdb: card.id } };
    var tasks = [traktTask('POST', '/users/hidden/recommendations', traktBody(kind, entry))];
    if (purge) tasks.push(traktTask('POST', '/sync/history/remove', traktBody(kind, entry)));

    runAll(tasks, function (err) {
      if (err) notify('Скрыто в Лампе, но Trakt ответил ошибкой: ' + errorText(err));
      else notify(purge ? 'Скрыто и удалено из истории' : 'Скрыто из рекомендаций');
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Модуль 2. Окно оценки после просмотра
  // ─────────────────────────────────────────────────────────────

  var playback = null; // { startedAt, hash, maxPercent }

  function onPlayerStart(data) {
    playback = {
      startedAt: now(),
      hash: (data && data.timeline && data.timeline.hash) || '',
      maxPercent: 0
    };
  }

  function onTimelineUpdate(e) {
    if (!playback || !e || !e.data) return;
    var percent = parseFloat(e.data.road && e.data.road.percent);
    if (!isNaN(percent) && percent > playback.maxPercent) playback.maxPercent = percent;
    if (e.data.hash) playback.hash = e.data.hash;
  }

  // Прогресс из тех же источников, что использует основной плагин
  function watchedPercent(session) {
    var percent = session.maxPercent;
    var last = window.last_timeline_event;
    if (last && last.ts >= session.startedAt && last.data && last.data.road) {
      percent = Math.max(percent, parseFloat(last.data.road.percent) || 0);
    }
    if (session.hash && Lampa.Timeline && typeof Lampa.Timeline.view === 'function') {
      try {
        var view = Lampa.Timeline.view(session.hash);
        if (view && view.percent) percent = Math.max(percent, view.percent);
      } catch (e) { /* таймлайн недоступен */ }
    }
    return percent;
  }

  function wasPrompted(kind, tmdbId) {
    var time = readMap(KEY.prompted)[itemKey(kind, tmdbId)];
    return !!time && (time < 0 || now() - time < PROMPT_COOLDOWN);
  }

  function markPrompted(kind, tmdbId, forever) {
    var map = readMap(KEY.prompted);
    map[itemKey(kind, tmdbId)] = forever ? -1 : now();
    writeMap(KEY.prompted, map, 500);
  }

  function isPlayerOpen() {
    try {
      return typeof Lampa.Player.opened === 'function' && Lampa.Player.opened();
    } catch (e) {
      return false;
    }
  }

  function onPlayerDestroy() {
    var session = playback;
    playback = null;
    if (!session || !token() || !isOn(SETTING.autorate, true)) return;
    if (watchedPercent(session) < AUTORATE_THRESHOLD) return;

    var card = Lampa.Storage.get('trakt_last_card', '');
    if (!card || typeof card !== 'object' || !card.id) return;
    var kind = kindOf(card);
    if (kind === 'tv' && !isOn(SETTING.autorateShows, true)) return;
    if (wasPrompted(kind, card.id)) return;

    setTimeout(function () {
      if (isPlayerOpen()) return;
      loadRatings(false, function (map) {
        if (ratingFrom(map, kind, card.id)) return;
        markPrompted(kind, card.id, false);
        openRatingSelect({ card: card, kind: kind, current: 0, header: 'Оцените: ' + titleOf(card), prompt: true });
      });
    }, AUTORATE_DELAY);
  }

  // ─────────────────────────────────────────────────────────────
  //  Модуль 4. Ряды рекомендаций на главной
  // ─────────────────────────────────────────────────────────────

  // Couchmoney дописывает к названию «[couchmoney.tv]», а в описание — «managed by couchmoney»
  // или «List based on the following recently watched/rated movies».
  function isCouchList(list) {
    return /couchmoney/i.test((list.name || '') + ' ' + (list.description || ''));
  }

  function couchKind(rawText) {
    var text = rawText.replace(/couch\s*money\.tv/gi, ' ');
    if (/\b(movies?|films?)\b|фильм/i.test(text)) return 'movie';
    if (/\b(tv|shows?|series)\b|сериал/i.test(text)) return 'tv';
    return '';
  }

  // { id, name, kind: movie|tv|'' (определится по содержимому), type: rec|recent|based, base, created }
  function describeCouchList(list) {
    var name = (list.name || '')
      .replace(/[\[(]\s*couch\s*money[^\])]*[\])]/gi, ' ')
      .replace(/couch\s*money:?/gi, ' ')
      .replace(/^[\s\-–—:|,.]+|[\s\-–—:|,.]+$/g, '')
      .replace(/\s{2,}/g, ' ');
    var description = list.description || '';
    var based = /based on the trakt list "([^"]+)"/i.exec(description);
    var type = based ? 'based' : /recently watched/i.test(description + ' ' + name) ? 'recent' : 'rec';
    return {
      id: list.ids.trakt,
      name: name,
      kind: couchKind(name) || couchKind(description.split('\n')[0]),
      type: type,
      base: based ? based[1] : '',
      created: list.created_at || ''
    };
  }

  // Своё имя списка без служебных слов: «Sci-Fi Recommendations» → «Sci-Fi»
  function customListName(name) {
    var rest = name.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(COUCH_GENERIC_WORDS, ' ');
    return /[a-zа-я]/i.test(rest) ? name : '';
  }

  function couchTitle(list, kind) {
    var word = KIND_WORD[kind] || 'фильмы и сериалы';
    if (list.type === 'recent') return 'Похоже на недавно просмотренное: ' + word;
    if (list.type === 'based') return 'Похоже на список «' + list.base + '»';
    var custom = customListName(list.name);
    return custom ? 'Рекомендуем: ' + custom : 'Рекомендуем: ' + word;
  }

  function sortCouchLists(a, b) {
    var byType = COUCH_ORDER[a.type] - COUCH_ORDER[b.type];
    if (byType) return byType;
    var byKind = (a.kind === 'tv') - (b.kind === 'tv');
    if (byKind) return byKind;
    return a.created < b.created ? -1 : a.created > b.created ? 1 : 0;
  }

  // Списки Couchmoney в стабильном порядке: рекомендации, недавно просмотренное, по спискам
  function loadCouchLists(callback) {
    var cached = cacheGet(KEY.lists, LISTS_TTL);
    if (cached) {
      callback(cached);
      return;
    }
    shared('lists', function (done) {
      traktRequest('GET', '/users/me/lists', null, function (lists) {
        var couch = (lists || []).filter(function (list) {
          return list.ids && list.ids.trakt && isCouchList(list);
        }).map(describeCouchList).sort(sortCouchLists);
        // Пустой результат не кэшируем: списки Couchmoney появляются через минуты или часы после подключения
        if (couch.length) cacheSet(KEY.lists, couch);
        else noticeCouchMissing();
        done(couch);
      }, function () {
        done(cacheGetStale(KEY.lists) || []);
      });
    }, callback);
  }

  function noticeCouchMissing() {
    var last = parseInt(Lampa.Storage.get(KEY.notice, '0'), 10) || 0;
    if (now() - last < NOTICE_COOLDOWN) return;
    Lampa.Storage.set(KEY.notice, String(now()));
    notify('Списки Couchmoney не найдены. Подключите Trakt на couchmoney.tv');
  }

  function traktImage(media) {
    var set = media.images && media.images.poster;
    var url = '';
    if (set && set.length) url = set[0];
    else if (set && typeof set === 'object') url = set.medium || set.thumb || set.full || '';
    if (!url) return '';
    if (url.indexOf('http') === 0) return url;
    return 'https://' + url.replace(/^\/+/, '');
  }

  // Сжатое описание элемента списка Trakt (то, что кэшируется)
  function rawFromTrakt(item) {
    var kind = item.type === 'show' ? 'tv' : item.type === 'movie' ? 'movie' : null;
    var media = item.movie || item.show;
    if (!kind || !media || !media.ids || !media.ids.tmdb) return null;
    return {
      kind: kind,
      id: media.ids.tmdb,
      title: media.title || '',
      date: kind === 'tv' ? (media.first_aired || '').slice(0, 10) : (media.released || (media.year ? media.year + '-01-01' : '')),
      vote: media.rating || 0,
      overview: media.overview || '',
      img: traktImage(media)
    };
  }

  function loadListItems(list, callback) {
    var key = KEY.itemsPrefix + list.id;
    var cached = cacheGet(key, LISTS_TTL);
    if (cached) {
      callback(cached);
      return;
    }
    shared(key, function (done) {
      var path = '/users/me/lists/' + encodeURIComponent(list.id) + '/items?extended=full,images&limit=' + LIST_FETCH_LIMIT;
      traktRequest('GET', path, null, function (items) {
        var raws = [];
        (items || []).forEach(function (item) {
          var raw = rawFromTrakt(item);
          if (raw) raws.push(raw);
        });
        cacheSet(key, raws);
        done(raws);
      }, function () {
        done(cacheGetStale(key) || []);
      });
    }, callback);
  }

  // Подтянуть русские названия и постеры из TMDB (с долгим кэшем)
  function enrichFromTmdb(raws, callback) {
    var meta = cacheGetStale(KEY.meta) || {};
    var limit = now() - META_TTL;
    var missing = raws.filter(function (raw) {
      var entry = meta[itemKey(raw.kind, raw.id)];
      return !entry || entry.time < limit || entry.lang !== language();
    });

    runLimited(missing, TMDB_CONCURRENCY, function (raw, next) {
      tmdbGet(raw.kind + '/' + raw.id, function (data) {
        meta[itemKey(raw.kind, raw.id)] = {
          time: now(),
          lang: language(),
          title: data.title || data.name || '',
          original: data.original_title || data.original_name || '',
          date: data.release_date || data.first_air_date || '',
          vote: data.vote_average || 0,
          poster: data.poster_path || '',
          backdrop: data.backdrop_path || '',
          overview: data.overview || ''
        };
        next();
      }, next);
    }, function () {
      if (missing.length) {
        var keys = Object.keys(meta);
        if (keys.length > META_MAX) {
          keys.sort(function (a, b) {
            return meta[a].time - meta[b].time;
          });
          keys.slice(0, keys.length - META_MAX).forEach(function (k) {
            delete meta[k];
          });
        }
        cacheSet(KEY.meta, meta);
      }
      callback(meta);
    });
  }

  // Карточка в формате, который Lampa открывает как обычную карточку TMDB
  function buildCard(raw, meta) {
    var info = meta[itemKey(raw.kind, raw.id)] || {};
    var tv = raw.kind === 'tv';
    var title = info.title || raw.title;
    var card = {
      id: raw.id,
      source: 'tmdb',
      method: raw.kind,
      card_type: raw.kind,
      type: raw.kind,
      vote_average: info.vote || raw.vote || 0,
      overview: info.overview || raw.overview || ''
    };
    if (tv) {
      card.name = title;
      card.original_name = info.original || raw.title;
      card.first_air_date = info.date || raw.date;
    } else {
      card.title = title;
      card.original_title = info.original || raw.title;
      card.release_date = info.date || raw.date;
    }
    if (info.poster) card.poster_path = info.poster;
    if (info.backdrop) card.backdrop_path = info.backdrop;
    if (raw.img) {
      card.img = raw.img;
      card.poster = raw.img;
    }
    card.params = {
      emit: {
        onlyEnter: function () {
          Lampa.Activity.push({ url: '', component: 'full', id: card.id, method: card.method, card: card, source: 'tmdb' });
        }
      }
    };
    return card;
  }

  // Убрать скрытые и уже оценённые тайтлы
  function filterRaws(raws, ratings) {
    var hidden = readMap(KEY.hidden);
    return raws.filter(function (raw) {
      var key = itemKey(raw.kind, raw.id);
      return !hidden[key] && !(ratings && ratings[key]);
    }).slice(0, ROW_LIMIT);
  }

  function openListDetail(list) {
    Lampa.Activity.push({
      url: '',
      title: list.name,
      component: 'trakt_list_detail',
      id: list.id,
      list_id: list.id,
      name: list.name,
      page: 1,
      source: 'tmdb'
    });
  }

  function majorityKind(raws) {
    var tv = raws.filter(function (raw) { return raw.kind === 'tv'; }).length;
    if (!raws.length) return '';
    return tv * 2 > raws.length ? 'tv' : 'movie';
  }

  function loadCouchRow(position, callback) {
    loadCouchLists(function (lists) {
      var list = lists[position];
      if (!list) {
        callback(null);
        return;
      }
      loadListItems(list, function (raws) {
        loadRatings(false, function (ratings) {
          var visible = filterRaws(raws, ratings);
          if (!visible.length) {
            callback(null);
            return;
          }
          enrichFromTmdb(visible, function (meta) {
            callback({
              title: couchTitle(list, list.kind || majorityKind(raws)),
              source: 'tmdb',
              results: visible.map(function (raw) {
                return buildCard(raw, meta);
              }),
              onMore: function () {
                openListDetail(list);
              }
            });
          });
        });
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Модуль 5. «Вам может понравиться» — собственный подбор по всей истории
  //
  //  Берём до 15 «семян»: высокие оценки Trakt, недавние просмотры (Trakt и Лампы),
  //  лайки и избранное Лампы. Для каждого берём рекомендации TMDB и суммируем:
  //  тайтл, который советуют сразу несколько семян, поднимается выше.
  //  Низкие оценки работают как минус — похожее на них опускается.
  // ─────────────────────────────────────────────────────────────

  function addSeed(seeds, kind, id, weight, title) {
    if (!id) return;
    var key = itemKey(kind, id);
    var seed = seeds[key];
    if (!seed) {
      seeds[key] = { kind: kind, id: id, weight: weight, title: title || '' };
      return;
    }
    // Положительные сигналы складываются (но не бесконечно), оценка ≤ 4 перекрывает всё
    if (seed.weight < 0) return;
    if (weight < 0) seed.weight = weight;
    else seed.weight = Math.min(seed.weight + weight * 0.5, SMART_SEED_MAX_WEIGHT);
  }

  function seedsFromRatings(seeds, ratings) {
    var recentLimit = now() - SMART_RECENT_DAYS * DAY;
    Object.keys(ratings || {}).forEach(function (key) {
      var entry = ratings[key];
      var parts = key.split(':');
      var id = parseInt(parts[1], 10);
      var weight = 0;
      if (entry.r >= 7) weight = entry.r - 5;
      else if (entry.r <= 4) weight = -(5 - entry.r) * 0.7;
      if (!weight) return;
      if (weight > 0 && entry.at && new Date(entry.at).getTime() > recentLimit) weight *= 1.5;
      addSeed(seeds, parts[0], id, weight, entry.t);
    });
  }

  function seedsFromTraktHistory(seeds, exclude, history) {
    (history || []).forEach(function (row, index) {
      var media = row.movie || row.show;
      var kind = row.movie ? 'movie' : 'tv';
      var tmdb = media && media.ids && media.ids.tmdb;
      if (!tmdb) return;
      exclude[itemKey(kind, tmdb)] = true;
      // Свежие просмотры весят больше старых
      addSeed(seeds, kind, tmdb, index < 20 ? 2 : 1, media.title);
    });
  }

  function lampaFavorites(type) {
    try {
      var list = Lampa.Favorite.get({ type: type });
      return list && list.length ? list : [];
    } catch (e) {
      return [];
    }
  }

  function isTmdbCard(card) {
    return card && card.id && (!card.source || card.source === 'tmdb' || card.source === 'cub');
  }

  function seedsFromLampa(seeds, exclude) {
    lampaFavorites('history').slice(0, 30).forEach(function (card, index) {
      if (!isTmdbCard(card)) return;
      var kind = kindOf(card);
      exclude[itemKey(kind, card.id)] = true;
      addSeed(seeds, kind, card.id, index < 15 ? 1.5 : 1, titleOf(card));
    });
    lampaFavorites('viewed').slice(0, 30).forEach(function (card) {
      if (!isTmdbCard(card)) return;
      var kind = kindOf(card);
      exclude[itemKey(kind, card.id)] = true;
      addSeed(seeds, kind, card.id, 1.5, titleOf(card));
    });
    lampaFavorites('like').slice(0, 30).forEach(function (card) {
      if (!isTmdbCard(card)) return;
      var kind = kindOf(card);
      exclude[itemKey(kind, card.id)] = true;
      addSeed(seeds, kind, card.id, 3, titleOf(card));
    });
    lampaFavorites('book').slice(0, 30).forEach(function (card) {
      if (!isTmdbCard(card)) return;
      var kind = kindOf(card);
      // Уже отложено «на потом» — не предлагаем повторно, но вкус учитываем
      exclude[itemKey(kind, card.id)] = true;
      addSeed(seeds, kind, card.id, 1, titleOf(card));
    });
  }

  function pickSeeds(seeds) {
    var list = Object.keys(seeds).map(function (key) {
      return seeds[key];
    });
    var positive = list.filter(function (s) {
      return s.weight > 0;
    }).sort(function (a, b) {
      return b.weight - a.weight;
    }).slice(0, SMART_SEEDS);
    var negative = list.filter(function (s) {
      return s.weight < 0;
    }).slice(0, SMART_NEGATIVE_SEEDS);
    return positive.concat(negative);
  }

  function rawFromTmdb(kind, item) {
    return {
      kind: kind,
      id: item.id,
      title: item.title || item.name || '',
      original: item.original_title || item.original_name || '',
      date: item.release_date || item.first_air_date || '',
      vote: item.vote_average || 0,
      votes: item.vote_count || 0,
      overview: item.overview || '',
      poster: item.poster_path || '',
      backdrop: item.backdrop_path || '',
      img: ''
    };
  }

  function scoreCandidates(seedList, done) {
    var candidates = {};
    runLimited(seedList, TMDB_CONCURRENCY, function (seed, next) {
      tmdbGet(seed.kind + '/' + seed.id + '/recommendations', function (data) {
        var results = (data && data.results) || [];
        results.forEach(function (item, position) {
          var key = itemKey(seed.kind, item.id);
          var entry = candidates[key];
          if (!entry) {
            entry = candidates[key] = { raw: rawFromTmdb(seed.kind, item), score: 0, hits: 0 };
          }
          entry.score += seed.weight * (1 - position / 30);
          if (seed.weight > 0) entry.hits++;
        });
        next();
      }, next);
    }, function () {
      done(candidates);
    });
  }

  function rankCandidates(candidates, exclude) {
    var ranked = { movie: [], tv: [] };
    Object.keys(candidates).forEach(function (key) {
      var entry = candidates[key];
      var raw = entry.raw;
      if (exclude[key] || entry.hits === 0 || raw.votes < SMART_MIN_VOTES) return;
      var score = entry.score * (1 + 0.25 * (entry.hits - 1));
      if (raw.votes >= 200) score += (raw.vote - 6.5) * 0.3;
      if (score <= 0) return;
      raw.score = Math.round(score * 100) / 100;
      ranked[raw.kind].push(raw);
    });
    ['movie', 'tv'].forEach(function (kind) {
      ranked[kind].sort(function (a, b) {
        return b.score - a.score;
      });
      ranked[kind] = ranked[kind].slice(0, SMART_KEEP);
    });
    return ranked;
  }

  function buildSmart(done) {
    loadRatings(false, function (ratings) {
      var seeds = {};
      var exclude = {};
      Object.keys(ratings || {}).forEach(function (key) {
        exclude[key] = true;
      });

      function finish(history) {
        seedsFromTraktHistory(seeds, exclude, history);
        seedsFromLampa(seeds, exclude);
        seedsFromRatings(seeds, ratings);
        var seedList = pickSeeds(seeds);
        seedList.forEach(function (seed) {
          exclude[itemKey(seed.kind, seed.id)] = true;
        });
        if (!seedList.length) {
          done(null);
          return;
        }
        scoreCandidates(seedList, function (candidates) {
          var payload = rankCandidates(candidates, exclude);
          cacheSet(KEY.smart, payload);
          done(payload);
        });
      }

      if (!token()) {
        finish([]);
        return;
      }
      traktRequest('GET', '/sync/history?limit=' + SMART_HISTORY_LIMIT, null, finish, function () {
        finish([]);
      });
    });
  }

  function loadSmart(callback) {
    var cached = cacheGet(KEY.smart, SMART_TTL);
    if (cached) {
      callback(cached);
      return;
    }
    shared('smart', buildSmart, function (payload) {
      callback(payload || cacheGetStale(KEY.smart));
    });
  }

  function loadSmartRow(row, callback) {
    loadSmart(function (payload) {
      var raws = payload && payload[row.kind];
      if (!raws || !raws.length) {
        callback(null);
        return;
      }
      loadRatings(false, function (ratings) {
        var visible = filterRaws(raws, ratings);
        if (!visible.length) {
          callback(null);
          return;
        }
        var meta = {};
        visible.forEach(function (raw) {
          meta[itemKey(raw.kind, raw.id)] = raw;
        });
        callback({
          title: row.title,
          source: 'tmdb',
          results: visible.map(function (raw) {
            return buildCard(raw, meta);
          })
        });
      });
    });
  }

  // Обёртка в формат Lampa.ContentRows: call(params, screen) → function(done)
  function rowCall(rowName, rowTitle, enabledSetting, needsTrakt, loader) {
    return function () {
      if ((needsTrakt && !token()) || !isOn(enabledSetting, true)) return;
      var part = function (done) {
        loader(function (line) {
          if (line) done(line);
          else done();
        });
      };
      // Стабильное имя ряда — по нему редактор главной различает ряды
      part.row_name = rowName;
      part.row_title = rowTitle;
      return part;
    };
  }

  function registerCouchRow(position) {
    var name = 'TraktPlusCouch' + (position + 1);
    var title = 'Couchmoney: список ' + (position + 1);
    Lampa.ContentRows.add({
      name: name,
      title: title,
      index: COUCH_FIRST_INDEX + position,
      screen: ['main'],
      call: rowCall(name, title, SETTING.rows, true, function (done) {
        loadCouchRow(position, done);
      })
    });
  }

  function registerRows() {
    if (!Lampa.ContentRows || typeof Lampa.ContentRows.add !== 'function') return;

    for (var position = 0; position < COUCH_ROWS; position++) registerCouchRow(position);

    SMART_ROWS.forEach(function (row) {
      Lampa.ContentRows.add({
        name: row.name,
        title: row.title,
        index: row.index,
        screen: ['main'],
        call: rowCall(row.name, row.title, SETTING.smart, false, function (done) {
          loadSmartRow(row, done);
        })
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Настройки
  // ─────────────────────────────────────────────────────────────

  function addTrigger(name, title, description) {
    Lampa.SettingsApi.addParam({
      component: 'trakt_plus',
      param: { name: name, type: 'trigger', 'default': true },
      field: { name: title, description: description }
    });
  }

  function addButton(name, title, description, action) {
    Lampa.SettingsApi.addParam({
      component: 'trakt_plus',
      param: { name: name, type: 'button' },
      field: { name: title, description: description },
      onChange: action
    });
  }

  function addSettings() {
    if (!Lampa.SettingsApi) return;

    Lampa.SettingsApi.addComponent({
      component: 'trakt_plus',
      name: 'Trakt+ рекомендации',
      icon: STAR_SVG
    });

    addTrigger(SETTING.rows, 'Ряды Couchmoney на главной', 'Персональные рекомендации из списков Couchmoney в Trakt');
    addTrigger(SETTING.smart, 'Ряды «Вам может понравиться»', 'Подбор по оценкам, истории просмотров, лайкам и избранному');
    addTrigger(SETTING.markWatched, 'Оценка = просмотрено', 'При оценке отмечать «Просмотрено» в Лампе, а фильм — и в истории Trakt');
    addTrigger(SETTING.autorate,'Оценка после просмотра', 'Предлагать оценку, если досмотрено ' + AUTORATE_THRESHOLD + '% и тайтл не оценён');
    addTrigger(SETTING.autorateShows, 'Оценка после просмотра сериалов', 'Не чаще раза в неделю для одного сериала');

    addButton('trakt_plus_refresh', 'Обновить рекомендации', 'Сбросить кэш списков и оценок', function () {
      clearRecommendationCaches();
      notify('Кэш сброшен — ряды обновятся при следующем открытии главной');
    });

    addButton('trakt_plus_unhide', 'Вернуть скрытые тайтлы', 'Очистить локальный список «Не моё»', function () {
      writeMap(KEY.hidden, {});
      notify('Локальный список скрытых очищен');
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Запуск
  // ─────────────────────────────────────────────────────────────

  function start() {
    injectStyle();
    addSettings();
    registerRows();

    Lampa.Listener.follow('full', onFullScreen);

    if (Lampa.Player && Lampa.Player.listener) {
      Lampa.Player.listener.follow('start', onPlayerStart);
      Lampa.Player.listener.follow('destroy', onPlayerDestroy);
    }
    if (Lampa.Timeline && Lampa.Timeline.listener) {
      Lampa.Timeline.listener.follow('update', onTimelineUpdate);
    }
  }

  if (window.appready) start();
  else {
    Lampa.Listener.follow('app', function (e) {
      if (e.type === 'ready') start();
    });
  }
})();

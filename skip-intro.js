/*
 * Skip Intro — пропуск заставок в сериалах (Lampa).
 *
 * Таймкоды берутся из баз SkipDB, TheIntroDB и IntroDB (в Android-приложении).
 * В базах время записано для «эталонного» файла серии. Наш файл (BWA, озвучка) обычно
 * на несколько секунд короче или длиннее, и неизвестно, где разница: в начале или в конце.
 * Поэтому пропускается только тот отрезок, который будет заставкой при любом варианте,
 * а неуверенный хвост заставки — только по кнопке. Кадры сюжета не теряются.
 *
 * Все отрезки отмечаются на полосе перемотки плеера.
 * Начало титров передаётся плагину next-episode.js: «Следующая серия» появится ровно на титрах.
 * Код написан на ES5, чтобы работать на старых WebView телевизоров.
 */
(function () {
  'use strict';

  if (window.gs_skip_intro_loaded) return;
  window.gs_skip_intro_loaded = true;

  var SETTING_ENABLED = 'skip_intro_enabled';
  var SETTING_DELAY = 'skip_intro_delay';
  // Прежняя настройка «автоматически / только кнопкой»: учитывается, пока не выбрана задержка
  var SETTING_OLD_MODE = 'skip_intro_mode';
  var SETTING_RECAP = 'skip_intro_recap';
  var BUTTON_ONLY = 'button';
  var DELAY_VALUES = {
    '0': 'Сразу',
    '3': 'Через 3 секунды',
    '5': 'Через 5 секунд',
    '10': 'Через 10 секунд',
    button: 'Только кнопкой'
  };
  var DEFAULT_DELAY = '5';
  var COMPONENT = 'skip_intro';
  var ICON = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M3 5.5v13l8.5-6.5L3 5.5z" fill="currentColor"/>' +
    '<path d="M12 5.5v13l8.5-6.5L12 5.5z" fill="currentColor"/></svg>';

  var CACHE_KEY = 'skip_intro_cache';
  var CACHE_LIMIT = 300;
  var CACHE_FOUND_TTL = 3 * 24 * 3600 * 1000;
  var CACHE_EMPTY_TTL = 12 * 3600 * 1000;
  var REQUEST_TIMEOUT = 8000;

  // Короткие ролики (трейлеры, клипы) не трогаем
  var MIN_DURATION = 5 * 60;
  // Отрезок короче не показываем: кнопка не успеет появиться
  var MIN_SEGMENT = 3;
  // Разница длительностей больше — другой монтаж, автоматике не доверяем
  var MAX_DELTA = 30;
  var MAX_INTRO = 5 * 60;
  // Кино 23.976 к/с, ускоренное до 25 к/с (PAL), короче на 4%
  var PAL_RATIO = 25 / 23.976;
  var PAL_TOLERANCE = 0.003;
  var CONTROLLER = 'skip_intro';
  var MARKS_CLASS = 'skip-intro-marks';

  var LABELS = {
    intro: { button: 'Пропустить заставку', auto: 'Пропуск заставки через ', done: 'Заставка пропущена' },
    recap: { button: 'Пропустить пересказ', auto: 'Пропуск пересказа через ', done: 'Пересказ пропущен' }
  };

  var view = null;
  var item = null;
  var imdbCache = {};

  function isOn(name, defaultValue) {
    var value = Lampa.Storage.get(name, defaultValue ? 'true' : 'false');
    return value === true || value === 'true';
  }

  function defaultDelay() {
    return Lampa.Storage.get(SETTING_OLD_MODE, '') === BUTTON_ONLY ? BUTTON_ONLY : DEFAULT_DELAY;
  }

  // Секунды до автопропуска или null — только кнопкой
  function autoDelay() {
    var value = String(Lampa.Storage.get(SETTING_DELAY, defaultDelay()));
    if (value === BUTTON_ONLY) return null;
    var delay = parseInt(value, 10);
    return delay >= 0 ? delay : parseInt(DEFAULT_DELAY, 10);
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

  // done(status, json): status 0 — сеть недоступна или таймаут
  function getJson(url, done) {
    var finished = false;
    var finish = function (status, json) {
      if (finished) return;
      finished = true;
      done(status, json);
    };
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = REQUEST_TIMEOUT;
      xhr.onload = function () {
        finish(xhr.status, parseJson(xhr.responseText));
      };
      xhr.onerror = function () {
        finish(0, null);
      };
      xhr.ontimeout = xhr.onerror;
      xhr.send();
    } catch (e) {
      finish(0, null);
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
        done(200, typeof data === 'string' ? parseJson(data) : data);
      }, function (xhr) {
        done((xhr && xhr.status) || 0, null);
      }, false, { timeout: REQUEST_TIMEOUT });
    } catch (e) {
      done(0, null);
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  Кэш: найденное — на 3 дня, «нет данных» — на 12 часов, ошибки не кэшируются
  // ─────────────────────────────────────────────────────────────

  function cacheGet(key) {
    var cache = Lampa.Storage.get(CACHE_KEY, '{}') || {};
    var entry = cache[key];
    if (!entry) return null;
    var ttl = entry.empty ? CACHE_EMPTY_TTL : CACHE_FOUND_TTL;
    return Date.now() - entry.time < ttl ? entry.value : null;
  }

  function cacheSet(key, value) {
    var cache = Lampa.Storage.get(CACHE_KEY, '{}') || {};
    cache[key] = { time: Date.now(), empty: isEmpty(value), value: value };
    var keys = Object.keys(cache);
    if (keys.length > CACHE_LIMIT) {
      keys.sort(function (a, b) {
        return cache[a].time - cache[b].time;
      });
      for (var i = 0; i < keys.length - CACHE_LIMIT; i++) delete cache[keys[i]];
    }
    Lampa.Storage.set(CACHE_KEY, cache);
  }

  function isEmpty(found) {
    return !found.intro && !found.recap && !found.credits;
  }

  // ─────────────────────────────────────────────────────────────
  //  Источники. Каждый приводит ответ к виду
  //  { ref: длительность эталонного файла или null, intro, recap: {start, end}, credits: {start} }
  //  Время — в секундах эталонного файла. null вместо ответа — ошибка, повторить позже.
  // ─────────────────────────────────────────────────────────────

  function seconds(ms) {
    return typeof ms === 'number' ? ms / 1000 : null;
  }

  function range(start, end) {
    if (start === null || end === null || end <= start) return null;
    return { start: Math.max(0, start), end: end };
  }

  // SkipDB сам сдвигает таймкоды под нашу длительность (offset_ms). Сдвиг убираем:
  // он переносит весь таймлайн, будто лишние секунды в начале, а это часто не так
  function parseSkipDB(json, duration) {
    var segments = json && json.segments;
    if (!segments) return null;
    var offset = null;
    var raw = function (segment) {
      if (!segment || typeof segment.start_ms !== 'number' || typeof segment.end_ms !== 'number') return null;
      var shift = segment.adjusted ? segment.offset_ms || 0 : 0;
      if (typeof segment.offset_ms === 'number' && segment.match !== 'agnostic') offset = segment.offset_ms;
      return range(seconds(segment.start_ms - shift), seconds(segment.end_ms - shift));
    };
    var found = { intro: raw(segments.intro), recap: raw(segments.recap) };
    var outro = raw(segments.outro);
    found.credits = outro ? { start: outro.start } : null;
    found.ref = offset === null ? null : duration - offset / 1000;
    return found;
  }

  function bestOf(list) {
    if (!list || !list.length) return null;
    return list.slice().sort(function (a, b) {
      return (b.confidence || 0) - (a.confidence || 0);
    })[0];
  }

  function parseTheIntroDB(json) {
    if (!json) return null;
    var ref = seconds(json.group_duration_ms);
    var raw = function (list) {
      var segment = bestOf(list);
      if (!segment) return null;
      var start = segment.start_ms == null ? 0 : seconds(segment.start_ms);
      var end = segment.end_ms == null ? ref : seconds(segment.end_ms);
      return range(start, end);
    };
    var credits = bestOf(json.credits);
    return {
      ref: ref,
      intro: raw(json.intro),
      recap: raw(json.recap),
      credits: credits && typeof credits.start_ms === 'number' ? { start: seconds(credits.start_ms) } : null
    };
  }

  // Длительность эталона IntroDB не отдаёт, но конец титров обычно совпадает с концом файла
  function parseIntroDB(json) {
    if (!json) return null;
    var raw = function (segment) {
      return segment ? range(seconds(segment.start_ms), seconds(segment.end_ms)) : null;
    };
    var outro = raw(json.outro);
    return {
      ref: outro ? outro.end : null,
      intro: raw(json.intro),
      recap: raw(json.recap),
      credits: outro ? { start: outro.start } : null
    };
  }

  var EMPTY = { ref: null, intro: null, recap: null, credits: null };

  var SOURCES = [
    {
      name: 'skipdb',
      applicable: function (ids) {
        return !!ids.imdb;
      },
      url: function (ids, episode, duration) {
        return 'https://api.skipdb.tv/api/segments?imdb_id=' + ids.imdb +
          '&season=' + episode.season + '&episode=' + episode.episode + '&duration=' + Math.round(duration);
      },
      request: getJson,
      parse: parseSkipDB
    },
    {
      name: 'theintrodb',
      applicable: function (ids) {
        return !!ids.tmdb;
      },
      url: function (ids, episode, duration) {
        return 'https://api.theintrodb.org/v4/media?tmdb_id=' + ids.tmdb +
          '&season=' + episode.season + '&episode=' + episode.episode +
          '&details=true&duration_ms=' + Math.round(duration * 1000);
      },
      request: getJson,
      parse: parseTheIntroDB
    },
    {
      name: 'introdb',
      applicable: function (ids) {
        return !!ids.imdb && canNative();
      },
      url: function (ids, episode) {
        return 'https://api.introdb.app/segments?imdb_id=' + ids.imdb +
          '&season=' + episode.season + '&episode=' + episode.episode;
      },
      request: getNative,
      parse: parseIntroDB
    }
  ];

  function fetchSource(source, ids, episode, duration, done) {
    var key = source.name + ':' + (ids.imdb || ids.tmdb) + ':' + episode.season + ':' + episode.episode;
    var cached = cacheGet(key);
    if (cached) return done(cached);

    source.request(source.url(ids, episode, duration), function (status, json) {
      var found = status === 404 ? EMPTY : status === 200 ? source.parse(json, duration) : null;
      if (found) cacheSet(key, found);
      done(found);
    });
  }

  // Все источники параллельно; для каждого вида отрезка берётся первый по приоритету
  function fetchAll(ids, episode, duration, done) {
    var sources = SOURCES.filter(function (source) {
      return source.applicable(ids);
    });
    var results = [];
    var left = sources.length;
    if (!left) return done([]);

    sources.forEach(function (source, index) {
      fetchSource(source, ids, episode, duration, function (found) {
        results[index] = found;
        if (--left === 0) done(results.filter(Boolean));
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Подгонка под наш файл
  // ─────────────────────────────────────────────────────────────

  function fit(ref, duration) {
    if (!ref) return { scale: 1, delta: 0, sure: false };
    var ratio = ref / duration;
    if (Math.abs(ratio - PAL_RATIO) < PAL_TOLERANCE || Math.abs(ratio - 1 / PAL_RATIO) < PAL_TOLERANCE) {
      return { scale: duration / ref, delta: 0, sure: true };
    }
    var delta = duration - ref;
    return { scale: 1, delta: delta, sure: Math.abs(delta) <= MAX_DELTA };
  }

  function segment(type, start, end, auto) {
    return { type: type, start: start, end: end, auto: auto, done: false };
  }

  // Заставка либо стоит на месте (разница длительностей в конце файла), либо сдвинута на delta
  // (разница в начале). Автоматически пропускаем пересечение двух вариантов, остальное — кнопкой
  function planIntro(type, raw, ref, duration) {
    var f = fit(ref, duration);
    var start = raw.start * f.scale;
    var end = Math.min(raw.end * f.scale, duration - MIN_SEGMENT);
    if (end > duration / 2 || end - start > MAX_INTRO) return [];

    if (!f.sure) return end - start >= MIN_SEGMENT ? [segment(type, start, end, false)] : [];

    var safeStart = Math.max(start, start + f.delta, 0);
    var safeEnd = Math.min(end, end + f.delta);
    var maxEnd = Math.max(end, end + f.delta);
    var plan = [];
    if (safeEnd - safeStart >= MIN_SEGMENT) plan.push(segment(type, safeStart, safeEnd, true));
    else safeEnd = start;
    if (maxEnd - safeEnd >= MIN_SEGMENT) plan.push(segment(type, safeEnd, maxEnd, false));
    return plan;
  }

  // Титры: берём более позднее из двух вариантов, чтобы не обрезать последнюю сцену
  function planCredits(raw, ref, duration) {
    var f = fit(ref, duration);
    if (!f.sure) return null;
    var start = Math.max(raw.start * f.scale, raw.start * f.scale + f.delta);
    if (start < duration * 0.6 || start > duration - MIN_SEGMENT) return null;
    return start;
  }

  function firstWith(results, type) {
    for (var i = 0; i < results.length; i++) {
      if (results[i][type]) return results[i];
    }
    return null;
  }

  function buildPlan(results, duration) {
    var types = isOn(SETTING_RECAP, true) ? ['recap', 'intro'] : ['intro'];
    var plan = [];
    types.forEach(function (type) {
      var source = firstWith(results, type);
      if (source) plan = plan.concat(planIntro(type, source[type], source.ref, duration));
    });
    plan.sort(function (a, b) {
      return a.start - b.start;
    });

    var creditsSource = firstWith(results, 'credits');
    var credits = creditsSource ? planCredits(creditsSource.credits, creditsSource.ref, duration) : null;
    return { segments: plan, credits: credits };
  }

  // ─────────────────────────────────────────────────────────────
  //  Что играет: сериал, сезон, серия
  // ─────────────────────────────────────────────────────────────

  function currentCard(data) {
    if (data.card) return data.card;
    var activity = Lampa.Activity.active();
    return activity ? activity.movie || activity.card || null : null;
  }

  function tmdbId(card) {
    if (card.source && card.source !== 'tmdb' && card.source !== 'cub') return null;
    return card.id || null;
  }

  function resolveIds(card, done) {
    var tmdb = tmdbId(card);
    var imdb = card.imdb_id || (card.external_ids && card.external_ids.imdb_id) || imdbCache[tmdb];
    if (imdb || !tmdb) return done({ tmdb: tmdb, imdb: imdb || null });

    var url = Lampa.TMDB.api('tv/' + tmdb + '/external_ids?api_key=' + Lampa.TMDB.key());
    getJson(url, function (status, json) {
      if (json && json.imdb_id) imdbCache[tmdb] = json.imdb_id;
      done({ tmdb: tmdb, imdb: imdbCache[tmdb] || null });
    });
  }

  function load(current, duration) {
    var episode = { season: current.season, episode: current.episode };
    resolveIds(current.card, function (ids) {
      if (current !== item) return;
      fetchAll(ids, episode, duration, function (results) {
        if (current !== item) return;
        var plan = buildPlan(results, duration);
        current.segments = plan.segments;
        current.credits = plan.credits;
        current.duration = duration;
        drawMarks(current);
        if (plan.credits !== null) {
          Lampa.Listener.send('skip_intro', { type: 'credits', start: plan.credits, duration: duration });
        }
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Отметки на полосе перемотки. Свой слой рядом со слоем отрезков плеера:
  //  плеер свой слой перерисовывает и наши отметки бы стёр
  // ─────────────────────────────────────────────────────────────

  var STYLE = '.' + MARKS_CLASS + '{position:absolute;top:0;left:0;right:0;height:100%;pointer-events:none}' +
    '.' + MARKS_CLASS + ' > div{position:absolute;top:0;height:100%;border-radius:5em;background-color:rgba(110,219,255,.9)}' +
    '.' + MARKS_CLASS + ' > .skip-intro-mark--maybe{background-color:rgba(110,219,255,.5)}' +
    '.' + MARKS_CLASS + ' > .skip-intro-mark--credits{background-color:rgba(190,160,255,.9)}';

  function addStyle() {
    if (document.getElementById('skip-intro-style')) return;
    var style = document.createElement('style');
    style.id = 'skip-intro-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function marksBox() {
    var timeline = Lampa.Player.render().find('.player-panel__timeline');
    if (!timeline.length) return null;
    var box = timeline.children('.' + MARKS_CLASS);
    if (!box.length) {
      box = $('<div class="' + MARKS_CLASS + '"></div>');
      timeline.append(box);
    }
    return box;
  }

  function clearMarks() {
    var box = marksBox();
    if (box) box.empty();
  }

  function addMark(box, kind, start, end, duration) {
    var left = Math.max(0, start) / duration * 100;
    var width = (Math.min(end, duration) - Math.max(0, start)) / duration * 100;
    if (width <= 0) return;
    box.append($('<div class="skip-intro-mark--' + kind + '"></div>').css({ left: left + '%', width: width + '%' }));
  }

  // Яркая отметка — точно заставка, бледная — может быть ещё заставкой (пропуск только кнопкой)
  function drawMarks(current) {
    var box = marksBox();
    if (!box) return;
    box.empty();
    current.segments.forEach(function (seg) {
      addMark(box, seg.auto ? seg.type : 'maybe', seg.start, seg.end, current.duration);
    });
    if (current.credits !== null) addMark(box, 'credits', current.credits, current.duration, current.duration);
  }

  // ─────────────────────────────────────────────────────────────
  //  Кнопка: та же разметка и классы, что у встроенной кнопки пропуска
  // ─────────────────────────────────────────────────────────────

  function createView() {
    var root = $('<div class="player-skip skip-intro selector hide">' +
      '<span class="player-skip__text"></span>' +
      '<svg><use xlink:href="#sprite-player-next"></use></svg>' +
      '<div class="player-skip__progress"><div class="player-skip__progress-line"></div></div>' +
      '</div>');
    root.on('hover:enter', function () {
      if (item && item.shown) skip(item.shown);
    });
    return {
      root: root,
      text: root.find('.player-skip__text'),
      line: root.find('.player-skip__progress-line')
    };
  }

  function attachView() {
    if (!view) view = createView();
    var player = Lampa.Player.render();
    if (player && !$.contains(player[0], view.root[0])) player.append(view.root);
  }

  function render(seg, secondsLeft, progress) {
    var labels = LABELS[seg.type];
    view.text.text(secondsLeft === null ? labels.button : labels.auto + secondsLeft);
    var scale = 'scaleX(' + Math.max(0, Math.min(1, progress)) + ')';
    view.line.css({ '-webkit-transform': scale, transform: scale });
  }

  function willAuto(seg) {
    return seg.auto && autoDelay() !== null;
  }

  function show(seg, time) {
    attachView();
    item.shown = seg;
    item.shownAt = time;
    render(seg, willAuto(seg) ? autoDelay() : null, 0);
    view.root.removeClass('hide');
    if (Lampa.Controller.enabled().name === 'player') Lampa.Controller.toggle(CONTROLLER);
  }

  function hide() {
    if (item) item.shown = null;
    if (!view) return;
    view.root.addClass('hide').removeClass('focus');
    if (Lampa.Controller.enabled().name === CONTROLLER) Lampa.Controller.toggle('player');
  }

  function skip(seg) {
    seg.done = true;
    hide();
    Lampa.PlayerVideo.to(seg.end);
  }

  // «Назад» — досмотреть заставку: убрать и неуверенный хвост того же отрезка
  function cancel() {
    if (item && item.shown) {
      var type = item.shown.type;
      item.segments.forEach(function (seg) {
        if (seg.type === type) seg.done = true;
      });
    }
    hide();
  }

  function addController() {
    var toPlayer = function () {
      Lampa.Controller.toggle('player');
    };
    Lampa.Controller.add(CONTROLLER, {
      toggle: function () {
        var player = Lampa.Player.render();
        Lampa.Controller.collectionSet(player);
        Lampa.Controller.collectionFocus(view.root[0], player);
      },
      up: toPlayer,
      down: toPlayer,
      left: toPlayer,
      right: toPlayer,
      gone: function () {
        if (view) view.root.removeClass('focus');
      },
      back: cancel
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Отслеживание времени
  // ─────────────────────────────────────────────────────────────

  function activeSegment(time) {
    var list = item.segments || [];
    for (var i = 0; i < list.length; i++) {
      var seg = list[i];
      // За секунду до конца автопропуск уже бессмысленен; кнопки идут встык, без мигания
      var tail = willAuto(seg) ? 1 : 0;
      if (!seg.done && time >= seg.start && time < seg.end - tail) return seg;
    }
    return null;
  }

  function onTime(event) {
    if (!item || item.ignored) return;
    var duration = event.duration || 0;
    var time = event.current || 0;

    if (!item.requested && duration >= MIN_DURATION) {
      item.requested = true;
      load(item, duration);
    }
    if (!item.segments) return;

    var seg = activeSegment(time);
    if (!seg) {
      if (item.shown) hide();
      return;
    }
    var delay = willAuto(seg) ? autoDelay() : null;
    if (delay === 0) {
      Lampa.Noty.show(LABELS[seg.type].done);
      return skip(seg);
    }
    if (item.shown !== seg) show(seg, time);
    if (delay === null) return;

    if (time < item.shownAt) item.shownAt = time;
    var passed = time - item.shownAt;
    if (passed >= delay) return skip(seg);
    render(seg, Math.ceil(delay - passed), passed / delay);
  }

  function onStart(data) {
    hide();
    clearMarks();
    var card = currentCard(data);
    var isEpisode = data.season > 0 && data.episode > 0;
    item = {
      card: card,
      season: data.season,
      episode: data.episode,
      ignored: !isOn(SETTING_ENABLED, true) || !card || !isEpisode,
      requested: false,
      segments: null,
      shown: null,
      shownAt: 0
    };
  }

  // ─────────────────────────────────────────────────────────────
  //  Настройки и запуск
  // ─────────────────────────────────────────────────────────────

  function addSettings() {
    if (!Lampa.SettingsApi) return;
    Lampa.SettingsApi.addComponent({ component: COMPONENT, name: 'Пропуск заставок', icon: ICON });
    Lampa.SettingsApi.addParam({
      component: COMPONENT,
      param: { name: SETTING_ENABLED, type: 'trigger', 'default': true },
      field: {
        name: 'Пропускать заставки',
        description: 'В сериалах. Таймкоды из SkipDB и TheIntroDB'
      }
    });
    Lampa.SettingsApi.addParam({
      component: COMPONENT,
      param: { name: SETTING_DELAY, type: 'select', values: DELAY_VALUES, 'default': defaultDelay() },
      field: {
        name: 'Когда пропускать',
        description: 'Пока идёт отсчёт: ОК — пропустить сразу, «Назад» — досмотреть заставку'
      }
    });
    Lampa.SettingsApi.addParam({
      component: COMPONENT,
      param: { name: SETTING_RECAP, type: 'trigger', 'default': true },
      field: {
        name: 'Пропускать «Ранее в сериале»',
        description: 'Пересказ прошлых серий в начале'
      }
    });
  }

  function start() {
    addStyle();
    addSettings();
    addController();

    Lampa.Player.listener.follow('start', onStart);
    Lampa.Player.listener.follow('destroy', function () {
      hide();
      clearMarks();
      item = null;
    });
    Lampa.PlayerVideo.listener.follow('timeupdate', onTime);
  }

  if (window.appready) start();
  else {
    Lampa.Listener.follow('app', function (event) {
      if (event.type === 'ready') start();
    });
  }
})();

/*
 * Continue Watch — продолжить сериал в одно нажатие (Lampa + BWA + Trakt).
 *
 * Нажатие на сериал в рядах «Продолжить просмотр» и «Смотреть дальше» сразу запускает
 * нужную серию в BWA. Какая серия нужна, решает Trakt: серия, досмотренная на 80%+,
 * считается просмотренной, и включается следующая. Недосмотренная продолжается с того же места
 * (это делает плеер Лампы по своему таймкоду).
 * В карточке сериала появляется кнопка «Продолжить S5E2» с тем же действием.
 *
 * Если что-то пошло не так (нет BWA, серия не нашлась), остаётся открытым список серий BWA.
 * Код написан на ES5, чтобы работать на старых WebView телевизоров.
 */
(function () {
  'use strict';

  if (window.continue_watch_loaded) return;
  window.continue_watch_loaded = true;

  var PROXY_BASE = 'https://apx.lme.isroot.in/trakt';
  var DIRECT_BASE = 'https://api.trakt.tv';
  var DEFAULT_CLIENT_ID = 'da2f995ec6a243546438f011272eb0a6f457048473527e4ee35b633100175f35';
  var REQUEST_TIMEOUT = 15000;

  var SETTING_ENABLED = 'continue_watch_enabled';
  var IDS_KEY = 'continue_watch_trakt_ids';
  var IDS_LIMIT = 300;
  var PROGRESS_TTL = 2 * 60 * 1000;

  var RESUME_ROWS = /^(Продолжить просмотр|(TraktTV:\s*)?Смотреть дальше)$/i;
  var FLOW_TIMEOUT = 40000;
  var POLL_INTERVAL = 300;
  var SEASON_SWITCH_WAIT = 6000;
  var BWA_BUTTON_WAIT = 5000;
  var MENU_STEP_DELAY = 500;
  var BUTTON_CLASS = 'continue-watch-button';
  var PLAY_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';

  var progressCache = {};
  var flow = null;

  function isOn(name, defaultValue) {
    var value = Lampa.Storage.get(name, defaultValue ? 'true' : 'false');
    return value === true || value === 'true';
  }

  function token() {
    return Lampa.Storage.get('trakt_token', '') || '';
  }

  function notify(text) {
    if (Lampa.Noty && typeof Lampa.Noty.show === 'function') Lampa.Noty.show(text);
  }

  function episodeCode(target) {
    return 'S' + target.season + 'E' + target.number;
  }

  // ─────────────────────────────────────────────────────────────
  //  Trakt: следующая серия по прогрессу просмотра
  // ─────────────────────────────────────────────────────────────

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
    return String(id || '').trim() || DEFAULT_CLIENT_ID;
  }

  function traktGet(path, onSuccess, onError) {
    function attempt(direct) {
      var headers = {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'x-requested-with': 'lme-plugins',
        'Authorization': 'Bearer ' + token()
      };
      if (direct) headers['trakt-api-key'] = clientId();

      $.ajax({
        url: (direct ? DIRECT_BASE : PROXY_BASE) + path,
        type: 'GET',
        headers: headers,
        dataType: 'json',
        timeout: REQUEST_TIMEOUT,
        success: onSuccess,
        error: function (xhr) {
          if (direct && (!xhr || xhr.status === 0)) {
            corsFree = false;
            attempt(false);
            return;
          }
          onError();
        }
      });
    }
    attempt(corsFree);
  }

  function traktShowId(card, callback) {
    if (card.ids && card.ids.trakt) return callback(card.ids.trakt);

    var ids = Lampa.Storage.get(IDS_KEY, '{}');
    if (!ids || typeof ids !== 'object') ids = {};
    if (ids[card.id]) return callback(ids[card.id]);

    traktGet('/search/tmdb/' + card.id + '?type=show', function (results) {
      var show = results && results[0] && results[0].show;
      var id = show && show.ids && show.ids.trakt;
      if (!id) return callback(0);

      var keys = Object.keys(ids);
      if (keys.length >= IDS_LIMIT) delete ids[keys[0]];
      ids[card.id] = id;
      Lampa.Storage.set(IDS_KEY, ids);
      callback(id);
    }, function () {
      callback(0);
    });
  }

  // callback({ season, number } | null). null — сериал не начат в Trakt или досмотрен.
  function nextEpisode(card, callback) {
    var cached = progressCache[card.id];
    if (cached && Date.now() - cached.time < PROGRESS_TTL) return callback(cached.target);

    var remember = function (target) {
      progressCache[card.id] = { time: Date.now(), target: target };
      callback(target);
    };

    if (!token()) return callback(null);

    traktShowId(card, function (traktId) {
      if (!traktId) return remember(null);
      traktGet('/shows/' + traktId + '/progress/watched?hidden=false&specials=false&count_specials=false', function (progress) {
        var next = progress && progress.next_episode;
        var started = progress && progress.completed > 0;
        remember(next && started ? { season: next.season, number: next.number } : null);
      }, function () {
        callback(null);
      });
    });
  }

  function cardTarget(card) {
    var next = card.trakt_upnext_next_episode;
    return next && next.season && next.number ? { season: next.season, number: next.number } : null;
  }

  // ─────────────────────────────────────────────────────────────
  //  Сценарий: карточка → BWA → нужный сезон → серия
  // ─────────────────────────────────────────────────────────────

  function stopFlow(message) {
    if (!flow) return;
    clearInterval(flow.timer);
    flow = null;
    if (message) notify(message);
  }

  function startFlow(card, target) {
    stopFlow();
    flow = {
      card: card,
      target: target,
      resolved: !!target,
      stage: 'card',
      started: Date.now(),
      seasonSwitchedAt: 0,
      timer: setInterval(tick, POLL_INTERVAL)
    };
    if (!target) {
      var current = flow;
      nextEpisode(card, function (found) {
        if (flow !== current) return;
        current.target = found;
        current.resolved = true;
      });
    }
  }

  function activeRender() {
    var activity = Lampa.Activity.active();
    return activity && activity.activity ? activity.activity.render() : $();
  }

  function openBwa(render) {
    var button = render.find('.view--bwa').first();
    if (!button.length) return false;
    flow.stage = 'bwa';
    button.trigger('hover:enter');
    return true;
  }

  function episodeElements(render) {
    return render.find('.season-episode[data-bwa-num]');
  }

  function listSeason(elements) {
    var match = /S(\d+)E/i.exec(elements.first().attr('data-bwa-num') || '');
    return match ? +match[1] : 0;
  }

  function chooseSelectItem(pattern) {
    var items = $('.selectbox-item');
    for (var i = 0; i < items.length; i++) {
      if (pattern.test($(items[i]).text().replace(/\s+/g, ' ').trim())) {
        $(items[i]).trigger('hover:enter');
        return true;
      }
    }
    return false;
  }

  // Закрыть меню так же, как кнопка «Назад» на пульте (Select.close оставляет фильтр BWA открытым)
  function closeSelect() {
    var enabled = Lampa.Controller.enabled();
    if (enabled && enabled.name === 'select' && enabled.controller && typeof enabled.controller.back === 'function') {
      enabled.controller.back();
    }
  }

  // Сезон в BWA выбирается через «Фильтр» → «Сезон» → «Сезон N»; после выбора фильтр возвращается в своё меню
  function switchSeason(render, season) {
    var filter = render.find('.filter--filter').first();
    if (!filter.length) return false;
    filter.trigger('hover:enter');

    setTimeout(function () {
      if (!chooseSelectItem(/^Сезон(\s|$)/i)) return closeSelect();
      setTimeout(function () {
        chooseSelectItem(new RegExp('^Сезон ' + season + '(\\D|$)', 'i'));
        setTimeout(closeSelect, MENU_STEP_DELAY);
      }, MENU_STEP_DELAY);
    }, MENU_STEP_DELAY);
    return true;
  }

  function playEpisode(element) {
    var title = $(element).find('.season-episode__title').text().trim();
    try {
      Lampa.Controller.collectionFocus(element, activeRender().find('.scroll').first());
    } catch (e) { /* фокус не критичен */ }
    notify('Продолжаю: ' + episodeCode(flow.target) + (title ? ' «' + title + '»' : ''));
    stopFlow();
    $(element).trigger('hover:enter');
  }

  function tick() {
    if (!flow) return;
    if (Date.now() - flow.started > FLOW_TIMEOUT) return stopFlow();

    var activity = Lampa.Activity.active() || {};
    var render = activeRender();

    if (flow.stage === 'card') {
      if (activity.component !== 'full') return;
      if (!render.find('.full-start__button').length) return;
      if (openBwa(render)) return;
      if (!flow.cardSeenAt) flow.cardSeenAt = Date.now();
      if (Date.now() - flow.cardSeenAt > BWA_BUTTON_WAIT) stopFlow('BWA не найден — выберите источник вручную');
      return;
    }

    if (activity.component === 'full') return;
    // Пользователь ушёл назад или открыл другой тайтл — не вмешиваемся
    if (activity.component === 'main' || (activity.movie && String(activity.movie.id) !== String(flow.card.id))) {
      return stopFlow();
    }
    var elements = episodeElements(render);
    if (!elements.length || !flow.resolved) return;
    if (!flow.target) return stopFlow();

    var code = episodeCode(flow.target);
    var element = render.find('.season-episode[data-bwa-num="' + code + '"]')[0];
    if (element) return playEpisode(element);

    var season = listSeason(elements);
    if (season === flow.target.season) return stopFlow('Серия ' + code + ' не найдена в BWA');
    if (flow.seasonSwitchedAt && Date.now() - flow.seasonSwitchedAt < SEASON_SWITCH_WAIT) return;
    if (flow.seasonSwitchedAt || !switchSeason(render, flow.target.season)) {
      return stopFlow('Выберите ' + flow.target.season + ' сезон — следующая серия ' + code);
    }
    flow.seasonSwitchedAt = Date.now();
  }

  // ─────────────────────────────────────────────────────────────
  //  Перехват нажатия в рядах «Продолжить просмотр» / «Смотреть дальше»
  // ─────────────────────────────────────────────────────────────

  function isShow(card) {
    return !!(card && (card.method === 'tv' || card.card_type === 'tv' || card.name || card.number_of_seasons ||
      card.first_air_date || card.trakt_upnext_next_episode));
  }

  function focusedResumeCard() {
    var activity = Lampa.Activity.active() || {};
    if (activity.component !== 'main' && activity.component !== 'category') return null;

    var focused = activeRender().find('.card.focus')[0];
    if (!focused || !focused.card_data) return null;

    var line = $(focused).closest('.items-line');
    var title = line.find('.items-line__title').first().text().trim();
    return RESUME_ROWS.test(title) ? focused.card_data : null;
  }

  function patchActivityPush() {
    var original = Lampa.Activity.push;
    Lampa.Activity.push = function (object) {
      if (object && object.component === 'full' && isOn(SETTING_ENABLED, true) && token()) {
        var card = focusedResumeCard();
        if (card && isShow(card) && String(card.id) === String(object.id || (object.card && object.card.id))) {
          startFlow(card, cardTarget(card));
        }
      }
      return original.apply(this, arguments);
    };
  }

  // ─────────────────────────────────────────────────────────────
  //  Кнопка «Продолжить SxEy» в карточке сериала
  // ─────────────────────────────────────────────────────────────

  function addButton(event) {
    var card = event.data && event.data.movie;
    if (!card || !isShow(card) || !token() || !isOn(SETTING_ENABLED, true)) return;

    var render = event.object.activity.render();
    nextEpisode(card, function (target) {
      if (target) whenBwaReady(render, function (bwa) { insertButton(render, bwa, card, target); });
    });
  }

  // BWA добавляет свою кнопку в том же событии, но может оказаться позже в очереди обработчиков
  function whenBwaReady(render, callback) {
    var waited = 0;
    var timer = setInterval(function () {
      var bwa = render.find('.view--bwa').first();
      waited += POLL_INTERVAL;
      if (bwa.length || waited > BWA_BUTTON_WAIT) {
        clearInterval(timer);
        if (bwa.length) callback(bwa);
      }
    }, POLL_INTERVAL);
  }

  function insertButton(render, bwa, card, target) {
    if (render.find('.' + BUTTON_CLASS).length) return;
    var button = $('<div class="full-start__button selector ' + BUTTON_CLASS + '">' + PLAY_SVG +
      '<span>Продолжить ' + episodeCode(target) + '</span></div>');
    button.on('hover:enter', function () {
      startFlow(card, target);
      if (!openBwa(render)) stopFlow('BWA не найден — выберите источник вручную');
    });
    bwa.before(button);
    focusButton(render, button);
  }

  // Фокус на «Продолжить», только если пользователь ещё стоит на кнопке по умолчанию
  function focusButton(render, button) {
    if (Lampa.Controller.enabled().name !== 'full_start') return;
    var focused = render.find('.full-start__button.focus');
    var untouched = !focused.length || focused.hasClass('button--priority') || focused.hasClass('button--play');
    Lampa.Controller.toggle('full_start');
    if (!untouched) return;
    try {
      Lampa.Controller.collectionFocus(button[0], render.find('.full-start-new__buttons'));
    } catch (e) { /* старая версия Lampa — фокус останется на месте */ }
  }

  // ─────────────────────────────────────────────────────────────
  //  Настройки и запуск
  // ─────────────────────────────────────────────────────────────

  function addSettings() {
    if (!Lampa.SettingsApi) return;
    Lampa.SettingsApi.addParam({
      component: 'interface',
      param: { name: SETTING_ENABLED, type: 'trigger', 'default': true },
      field: {
        name: 'Продолжить в одно нажатие',
        description: 'Сериал из «Продолжить просмотр» и «Смотреть дальше» сразу запускает следующую серию в BWA (по Trakt)'
      }
    });
  }

  function start() {
    addSettings();
    patchActivityPush();
    Lampa.Listener.follow('full', function (event) {
      if (event.type === 'complite') addButton(event);
    });
  }

  if (window.appready) start();
  else {
    Lampa.Listener.follow('app', function (event) {
      if (event.type === 'ready') start();
    });
  }
})();

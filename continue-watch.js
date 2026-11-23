/*
 * Continue Watch — продолжить сериал в одно нажатие (Lampa + BWA + Trakt).
 *
 * Нажатие на сериал в рядах «Продолжить просмотр» и «Смотреть дальше» сразу запускает
 * нужную серию в BWA. Какая серия нужна, решает Trakt: серия, досмотренная на 80%+,
 * считается просмотренной, и включается следующая. Недосмотренная продолжается с того же места
 * (это делает плеер Лампы по своему таймкоду).
 * В карточке сериала появляется кнопка «Продолжить S5E2» с тем же действием.
 * На главной обычный ряд «Продолжить просмотр» заменяется широким: кадр из серии,
 * номер и название серии, сколько осталось и полоска прогресса.
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

  var SETTING_WIDE = 'continue_watch_wide';
  var WIDE_ROW = 'continue_watch_wide';
  var WIDE_LIMIT = 12;
  var WIDE_IMAGE_SIZE = 'w780';
  var WATCHED_PERCENT = 90;
  var TMDB_SOURCES = { tmdb: true, cub: true };

  var WIDE_STYLE = [
    '.items-line--type-continue-wide .scroll__body{padding-bottom:.6em}',
    '.cw-card{position:relative;flex-shrink:0;width:22em;height:12.4em;margin-right:1em;border-radius:.8em;',
    'overflow:hidden;background-color:rgba(255,255,255,.08)}',
    '.cw-card__img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .4s}',
    '.cw-card--loaded .cw-card__img{opacity:1}',
    '.cw-card__shade{position:absolute;top:0;left:0;width:100%;height:100%;',
    'background:linear-gradient(0deg,rgba(0,0,0,.9) 0%,rgba(0,0,0,.4) 50%,rgba(0,0,0,0) 78%)}',
    '.cw-card__body{position:absolute;left:1em;right:1em;bottom:1.1em}',
    '.cw-card__title{font-size:1.25em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.cw-card__episode{margin-top:.2em;color:rgba(255,255,255,.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.cw-card__time{margin-top:.15em;font-size:.9em;color:rgba(255,255,255,.6)}',
    '.cw-card__progress{display:none;position:absolute;left:0;right:0;bottom:0;height:.3em;background:rgba(255,255,255,.25)}',
    '.cw-card--progress .cw-card__progress{display:block}',
    '.cw-card__bar{height:100%;background:#fff}',
    '.cw-card.focus{box-shadow:0 0 0 .2em #fff}'
  ].join('');

  var progressCache = {};
  var episodeMemory = {};
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
  //  Широкий ряд «Продолжить просмотр» на главной
  // ─────────────────────────────────────────────────────────────

  function wideEnabled() {
    return isOn(SETTING_WIDE, true) && isOn('content_rows_' + WIDE_ROW, true);
  }

  function hashTitle(card) {
    return card.original_name || card.original_title || '';
  }

  function movieTime(card) {
    return Lampa.Timeline.view(Lampa.Utils.hash(hashTitle(card)));
  }

  function episodeTime(card, target) {
    var season = target.season;
    return Lampa.Timeline.view(Lampa.Utils.hash([season, season > 10 ? ':' : '', target.number, hashTitle(card)].join('')));
  }

  function tmdbId(card) {
    return TMDB_SOURCES[card.source || 'tmdb'] ? card.id : 0;
  }

  function tmdbImage(path) {
    return path ? Lampa.TMDB.image('t/p/' + WIDE_IMAGE_SIZE + path) : '';
  }

  function wideCards() {
    var order = {};
    (Lampa.Favorite.get({ type: 'history' }) || []).forEach(function (card, index) {
      if (!order.hasOwnProperty(card.id)) order[card.id] = index;
    });
    var movies = Lampa.Favorite.continues('movie').filter(function (card) {
      var percent = movieTime(card).percent;
      return percent > 0 && percent < WATCHED_PERCENT;
    });
    return Lampa.Favorite.continues('tv').concat(Lampa.Favorite.continues('anime'), movies)
      .filter(function (card) { return card.backdrop_path || card.poster_path; })
      .sort(function (a, b) { return (order[a.id] || 0) - (order[b.id] || 0); })
      .slice(0, WIDE_LIMIT);
  }

  function loadEpisode(card, target, callback) {
    var id = tmdbId(card);
    if (!id) return callback({});
    var key = id + ':' + target.season + ':' + target.number;
    if (episodeMemory[key]) return callback(episodeMemory[key]);

    var url = Lampa.TMDB.api('tv/' + id + '/season/' + target.season + '/episode/' + target.number +
      '?api_key=' + Lampa.TMDB.key() + '&language=' + (Lampa.Storage.get('tmdb_lang', 'ru') || 'ru'));
    var network = new Lampa.Reguest();
    network.timeout(REQUEST_TIMEOUT);
    network.silent(url, function (json) {
      episodeMemory[key] = json || {};
      callback(episodeMemory[key]);
    }, function () {
      callback({});
    });
  }

  function remainingText(time) {
    if (!time.duration || !time.percent) return '';
    var minutes = Math.max(1, Math.round((time.duration - time.time) / 60));
    var hours = Math.floor(minutes / 60);
    var parts = [];
    if (hours) parts.push(hours + ' ч');
    if (minutes % 60) parts.push(minutes % 60 + ' мин');
    return 'осталось ' + parts.join(' ');
  }

  function node(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  // Элемент ряда Лампы: create / render / destroy, события hover:* приходят на корневой узел
  function WideCard(data) {
    this.card = data.card;
  }

  WideCard.prototype.create = function () {
    var self = this;
    var root = node('div', 'cw-card selector layer--visible layer--render');
    var body = node('div', 'cw-card__body');
    var progress = node('div', 'cw-card__progress');

    this.image = node('img', 'cw-card__img');
    this.episode = node('div', 'cw-card__episode');
    this.time = node('div', 'cw-card__time');
    this.bar = node('div', 'cw-card__bar');

    this.image.alt = '';
    this.image.onload = function () { root.classList.add('cw-card--loaded'); };
    body.appendChild(node('div', 'cw-card__title', this.card.title || this.card.name));
    body.appendChild(this.episode);
    body.appendChild(this.time);
    progress.appendChild(this.bar);
    root.appendChild(this.image);
    root.appendChild(node('div', 'cw-card__shade'));
    root.appendChild(body);
    root.appendChild(progress);

    // По card_data живой фон и другие плагины узнают тайтл под фокусом
    root.card_data = this.card;
    root.addEventListener('visible', function () { self.load(); });
    root.addEventListener('hover:enter', function () { self.open(); });
    this.html = root;
  };

  WideCard.prototype.setImage = function (path) {
    var src = tmdbImage(path);
    if (src && this.image.getAttribute('src') !== src) this.image.src = src;
  };

  WideCard.prototype.showTime = function (label, time, idle) {
    this.episode.textContent = label;
    this.time.textContent = remainingText(time) || idle || '';
    this.bar.style.width = Math.min(100, time.percent || 0) + '%';
    if (time.percent) this.html.classList.add('cw-card--progress');
  };

  WideCard.prototype.load = function () {
    if (this.loaded) return;
    this.loaded = true;
    var self = this;
    var card = this.card;

    if (!isShow(card)) {
      this.setImage(card.backdrop_path || card.poster_path);
      return this.showTime('Фильм', movieTime(card));
    }
    if (!token()) {
      this.resolved = true;
      return this.setImage(card.backdrop_path || card.poster_path);
    }

    nextEpisode(card, function (target) {
      if (!self.html) return;
      self.target = target;
      self.resolved = true;
      if (!target) return self.setImage(card.backdrop_path || card.poster_path);

      var code = episodeCode(target);
      self.showTime(code, episodeTime(card, target), 'Следующая серия');
      loadEpisode(card, target, function (info) {
        if (!self.html) return;
        if (info.name) self.episode.textContent = code + ' · ' + info.name;
        self.setImage(info.still_path || card.backdrop_path || card.poster_path);
      });
    });
  };

  WideCard.prototype.open = function () {
    var card = this.card;
    var show = isShow(card);
    // Trakt уже ответил, что сериал досмотрен, — просто открываем карточку
    if (show && token() && isOn(SETTING_ENABLED, true) && (this.target || !this.resolved)) {
      startFlow(card, this.target || null);
    }
    Lampa.Activity.push({
      url: '',
      component: 'full',
      id: card.id,
      method: show ? 'tv' : 'movie',
      card: card,
      source: card.source || 'tmdb'
    });
  };

  WideCard.prototype.render = function (js) {
    return js ? this.html : $(this.html);
  };

  WideCard.prototype.use = function () {};

  WideCard.prototype.destroy = function () {
    if (!this.html) return;
    this.image.onload = null;
    this.image.removeAttribute('src');
    if (this.html.parentNode) this.html.parentNode.removeChild(this.html);
    this.html = null;
  };

  function registerWideRow() {
    var part = function (done) {
      var cards = wideCards();
      if (!cards.length) return done();
      done({
        title: 'Продолжить просмотр',
        results: cards.map(function (card) {
          return {
            id: card.id,
            card: card,
            params: { createInstance: function (item) { return new WideCard(item); } }
          };
        }),
        params: {
          type: 'continue-wide',
          items: { mapping: 'line', align_left: true, view: 6 }
        }
      });
    };
    part.row_name = WIDE_ROW;
    part.row_title = 'Продолжить просмотр (широкие карточки)';

    Lampa.ContentRows.add({
      name: WIDE_ROW,
      title: 'Продолжить просмотр (широкие карточки)',
      index: 1,
      screen: ['main'],
      call: function () {
        return isOn(SETTING_WIDE, true) ? part : undefined;
      }
    });
  }

  // Встроенный ряд узнаём по ключам перевода в его коде: имени у готовой части ряда нет
  function isCoreContinue(part) {
    if (typeof part !== 'function' || part.row_name) return false;
    var code = '';
    try {
      code = String(part);
    } catch (e) { /* нативная функция */ }
    return code.indexOf('title_continue') >= 0 && code.indexOf('title_watched') >= 0;
  }

  // На главной широкий ряд заменяет встроенный; в категориях встроенный остаётся
  function hideCoreRow() {
    var original = Lampa.ContentRows.call;
    Lampa.ContentRows.call = function (screen, params, calls) {
      var result = original.apply(this, arguments);
      if (screen === 'main' && calls && calls.length && wideEnabled()) {
        for (var i = calls.length - 1; i >= 0; i--) {
          if (isCoreContinue(calls[i])) calls.splice(i, 1);
        }
      }
      return result;
    };
  }

  function addStyle() {
    var style = node('style');
    style.textContent = WIDE_STYLE;
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
      field: {
        name: 'Продолжить в одно нажатие',
        description: 'Сериал из «Продолжить просмотр» и «Смотреть дальше» сразу запускает следующую серию в BWA (по Trakt)'
      }
    });
    Lampa.SettingsApi.addParam({
      component: 'interface',
      param: { name: SETTING_WIDE, type: 'trigger', 'default': true },
      field: {
        name: 'Широкий ряд «Продолжить просмотр»',
        description: 'Кадр из серии, номер и название, сколько осталось. Заменяет обычный ряд на главной'
      }
    });
  }

  function start() {
    addStyle();
    addSettings();
    patchActivityPush();
    hideCoreRow();
    registerWideRow();
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

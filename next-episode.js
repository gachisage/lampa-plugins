/*
 * Next Episode — «Следующая серия через N» на титрах (Lampa).
 *
 * Под конец серии в плеере появляется кнопка «Следующая серия» с отсчётом.
 * ОК — включить следующую серию сразу (пропустить титры), «Назад» — остаться и досмотреть титры.
 * Если ничего не нажимать, после отсчёта включится следующая серия.
 * Отсчёт идёт по времени видео: на паузе он тоже стоит.
 *
 * Работает с любым источником, который передаёт плееру список серий (BWA и др.).
 * С плагином skip-intro.js кнопка появляется ровно на начале титров, иначе — за N секунд до конца.
 * Код написан на ES5, чтобы работать на старых WebView телевизоров.
 */
(function () {
  'use strict';

  if (window.next_episode_loaded) return;
  window.next_episode_loaded = true;

  var SETTING_ENABLED = 'next_episode_enabled';
  var SETTING_TAIL = 'next_episode_tail';
  var TAIL_VALUES = {
    '30': '30 секунд',
    '60': '1 минута',
    '90': '1,5 минуты',
    '120': '2 минуты',
    '180': '3 минуты'
  };
  var DEFAULT_TAIL = '90';
  var COUNTDOWN = 10;
  // Короткие ролики (трейлеры, клипы) не трогаем
  var MIN_DURATION = 10 * 60;
  // Ближе к концу плеер сам переключит серию по событию ended
  var END_MARGIN = 3;
  var CONTROLLER = 'next_episode';

  var view = null;
  var state = null;

  function isOn(name, defaultValue) {
    var value = Lampa.Storage.get(name, defaultValue ? 'true' : 'false');
    return value === true || value === 'true';
  }

  function tailSeconds() {
    var value = parseInt(Lampa.Storage.get(SETTING_TAIL, DEFAULT_TAIL), 10);
    return value > 0 ? value : parseInt(DEFAULT_TAIL, 10);
  }

  function nextItem() {
    var list = Lampa.PlayerPlaylist.get() || [];
    var position = Lampa.PlayerPlaylist.position();
    return list[position + 1] || null;
  }

  function itemLabel(item) {
    if (!item) return '';
    if (item.season && item.episode) return 'S' + item.season + 'E' + item.episode;
    return item.title || '';
  }

  // ─────────────────────────────────────────────────────────────
  //  Кнопка: та же разметка и классы, что у встроенной кнопки пропуска
  // ─────────────────────────────────────────────────────────────

  function createView() {
    var root = $('<div class="player-skip next-episode selector hide">' +
      '<span class="player-skip__text"></span>' +
      '<svg><use xlink:href="#sprite-player-next"></use></svg>' +
      '<div class="player-skip__progress"><div class="player-skip__progress-line"></div></div>' +
      '</div>');
    root.on('hover:enter', goNext);
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

  function setProgress(value) {
    var scale = 'scaleX(' + Math.max(0, Math.min(1, value)) + ')';
    view.line.css({ '-webkit-transform': scale, transform: scale });
  }

  function render(secondsLeft, progress) {
    view.text.text('Следующая серия' + (state.label ? ' ' + state.label : '') + ' через ' + secondsLeft);
    setProgress(progress);
  }

  function show(current) {
    attachView();
    state.active = true;
    state.shownAt = current;
    state.label = itemLabel(nextItem());
    render(COUNTDOWN, 0);
    view.root.removeClass('hide');
    if (Lampa.Controller.enabled().name === 'player') Lampa.Controller.toggle(CONTROLLER);
  }

  function hide() {
    if (state) state.active = false;
    if (!view) return;
    view.root.addClass('hide').removeClass('focus');
    if (Lampa.Controller.enabled().name === CONTROLLER) Lampa.Controller.toggle('player');
  }

  function cancel() {
    if (state) state.cancelled = true;
    hide();
  }

  function goNext() {
    hide();
    state = null;
    Lampa.PlayerPlaylist.next();
  }

  // ─────────────────────────────────────────────────────────────
  //  Отслеживание времени
  // ─────────────────────────────────────────────────────────────

  function onTime(event) {
    if (!state || !isOn(SETTING_ENABLED, true)) return;
    var duration = event.duration || 0;
    var current = event.current || 0;
    if (duration < MIN_DURATION) return;

    var remaining = duration - current;
    var tail = state.creditsAt > 0 && state.creditsAt < duration ? duration - state.creditsAt : tailSeconds();
    var inTail = remaining <= tail && remaining > END_MARGIN;

    if (!state.active) {
      if (inTail && !state.cancelled && remaining > COUNTDOWN + END_MARGIN && Lampa.PlayerPlaylist.canNext()) show(current);
      return;
    }

    // Перемотали назад, за начало титров
    if (!inTail) return hide();
    if (current < state.shownAt) state.shownAt = current;

    var passed = current - state.shownAt;
    if (passed >= COUNTDOWN) return goNext();
    render(Math.ceil(COUNTDOWN - passed), passed / COUNTDOWN);
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
  //  Настройки и запуск
  // ─────────────────────────────────────────────────────────────

  function addSettings() {
    if (!Lampa.SettingsApi) return;
    Lampa.SettingsApi.addParam({
      component: 'player',
      param: { name: SETTING_ENABLED, type: 'trigger', 'default': true },
      field: {
        name: 'Следующая серия на титрах',
        description: 'Кнопка с отсчётом под конец серии: ОК — сразу следующая, «Назад» — досмотреть титры'
      }
    });
    Lampa.SettingsApi.addParam({
      component: 'player',
      param: { name: SETTING_TAIL, type: 'select', values: TAIL_VALUES, 'default': DEFAULT_TAIL },
      field: {
        name: 'Когда показывать «Следующую серию»',
        description: 'За сколько до конца серии, если начало титров неизвестно. Если титры длинные — увеличьте'
      }
    });
  }

  function start() {
    addSettings();
    addController();

    Lampa.Player.listener.follow('start', function () {
      hide();
      state = { active: false, cancelled: false, shownAt: 0, creditsAt: 0 };
    });
    // Начало титров из баз таймкодов (плагин skip-intro.js)
    Lampa.Listener.follow('skip_intro', function (event) {
      if (state && event.type === 'credits') state.creditsAt = event.start;
    });
    Lampa.Player.listener.follow('destroy', function () {
      hide();
      state = null;
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

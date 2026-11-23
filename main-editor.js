/*
 * Редактор главной страницы Lampa.
 *
 * Позволяет:
 *   • менять порядок рядов на главной («Сейчас смотрят», «Сейчас в тренде», ряды плагинов…);
 *   • скрывать ненужные ряды и возвращать их обратно;
 *   • добавлять готовые ряды из каталога (аниме, Netflix, российские сериалы и т.п.).
 *
 * Как работает: Lampa собирает главную из списка «частей» (функций, каждая грузит один ряд)
 * и отдаёт его в Lampa.Api.partNext. Плагин перехватывает этот список до загрузки
 * и переставляет/заменяет части. Поэтому подгрузка при прокрутке и навигация пультом
 * работают как обычно. Настройки хранятся отдельно для каждого источника (TMDB, CUB…).
 *
 * Настройки → «Главная страница». Код на ES5 для старых ТВ.
 */
(function () {
  'use strict';

  if (window.main_editor_loaded) return;
  window.main_editor_loaded = true;

  // ─────────────────────────────────────────────────────────────
  //  Константы
  // ─────────────────────────────────────────────────────────────

  var KEY_CONFIG = 'main_editor_config';     // { source: { order: [sig], hidden: { sig: true } } }
  var KEY_KNOWN = 'main_editor_known';       // { source: { sigs: [sig], titles: { sig: title } } }
  var KEY_PRESETS = 'main_editor_presets';   // { presetId: true }
  var TAG = 'main_editor_source';            // метка на массиве частей главной
  var SCAN_TIMEOUT = 8000;
  var SAVE_DELAY = 1000;
  var REQUEST_TIMEOUT = 15000;
  var PRESET_INDEX = 100;                    // новые ряды из каталога появляются внизу

  // Ряды, которые сами ничего не показывают, а добавляют случайные подборки в конец главной
  var GROUP_TITLES = {
    'group:keywords': 'Подборки по темам (случайные)',
    'group:persons': 'Популярные актёры (случайные)'
  };

  var DAY = 24 * 60 * 60 * 1000;

  function yearsAgo(years) {
    return new Date(new Date().getTime() - years * 365 * DAY).toISOString().slice(0, 10);
  }

  function yearAgo() {
    return yearsAgo(1);
  }

  // Каталог рядов, которые можно добавить. path — запрос к TMDB
  var PRESETS = [
    { id: 'tv_trend_day', title: 'Сериалы: в тренде сегодня', path: function () { return 'trending/tv/day'; } },
    { id: 'tv_on_air', title: 'Новые серии на этой неделе', path: function () { return 'tv/on_the_air'; } },
    { id: 'movies_best_year', title: 'Лучшие фильмы за год', path: function () { return 'discover/movie?sort_by=vote_average.desc&vote_count.gte=300&primary_release_date.gte=' + yearAgo(); } },
    { id: 'tv_best_year', title: 'Лучшие сериалы за год', path: function () { return 'discover/tv?sort_by=vote_average.desc&vote_count.gte=150&first_air_date.gte=' + yearAgo(); } },
    { id: 'ru_movies', title: 'Российские фильмы', path: function () { return 'discover/movie?with_original_language=ru&sort_by=popularity.desc'; } },
    { id: 'ru_tv', title: 'Российские сериалы', path: function () { return 'discover/tv?with_original_language=ru&sort_by=popularity.desc'; } },
    { id: 'anime', title: 'Аниме: новое и популярное', path: function () { return 'discover/tv?with_genres=16&with_original_language=ja&sort_by=popularity.desc&vote_count.gte=20&first_air_date.gte=' + yearsAgo(3); } },
    { id: 'kdrama', title: 'Корейские сериалы', path: function () { return 'discover/tv?with_original_language=ko&sort_by=popularity.desc'; } },
    { id: 'cartoons', title: 'Мультфильмы', path: function () { return 'discover/movie?with_genres=16,10751&sort_by=popularity.desc'; } },
    { id: 'documentary', title: 'Документальные фильмы', path: function () { return 'discover/movie?with_genres=99&sort_by=popularity.desc&vote_count.gte=50'; } },
    { id: 'netflix', title: 'Сериалы Netflix', path: function () { return 'discover/tv?with_networks=213&sort_by=popularity.desc'; } },
    { id: 'hbo', title: 'Сериалы HBO', path: function () { return 'discover/tv?with_networks=49&sort_by=popularity.desc'; } },
    { id: 'apple', title: 'Сериалы Apple TV+', path: function () { return 'discover/tv?with_networks=2552&sort_by=popularity.desc'; } },
    { id: 'disney', title: 'Сериалы Disney+', path: function () { return 'discover/tv?with_networks=2739&sort_by=popularity.desc'; } }
  ];

  var ICON = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M3 4h18v4H3zm0 6h18v4H3zm0 6h18v4H3z"/></svg>';

  // ─────────────────────────────────────────────────────────────
  //  Утилиты
  // ─────────────────────────────────────────────────────────────

  function notify(text) {
    try {
      Lampa.Noty.show(text);
    } catch (e) { /* уведомления недоступны */ }
  }

  function readObject(key) {
    var value = Lampa.Storage.get(key, '');
    return value && typeof value === 'object' ? value : {};
  }

  function currentSource() {
    return Lampa.Storage.get('source', 'tmdb') || 'tmdb';
  }

  function currentController() {
    try {
      var enabled = Lampa.Controller.enabled();
      if (enabled && enabled.name) return enabled.name;
    } catch (e) { /* старая версия Lampa */ }
    return 'settings_component';
  }

  function hashString(text) {
    var hash = 5381;
    for (var i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
  }

  // ─────────────────────────────────────────────────────────────
  //  Хранилище настроек
  // ─────────────────────────────────────────────────────────────

  function loadConfig(source) {
    var all = readObject(KEY_CONFIG);
    var config = all[source] || {};
    return { order: config.order || [], hidden: config.hidden || {} };
  }

  function saveConfig(source, config) {
    var all = readObject(KEY_CONFIG);
    all[source] = config;
    Lampa.Storage.set(KEY_CONFIG, all);
  }

  var knownCache = null;
  var saveTimer = null;

  function knownAll() {
    if (!knownCache) knownCache = readObject(KEY_KNOWN);
    return knownCache;
  }

  function loadKnown(source) {
    var all = knownAll();
    if (!all[source]) all[source] = { sigs: [], titles: {}, empty: {} };
    if (!all[source].titles) all[source].titles = {};
    if (!all[source].empty) all[source].empty = {};
    return all[source];
  }

  function saveKnownLater() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      Lampa.Storage.set(KEY_KNOWN, knownAll());
    }, SAVE_DELAY);
  }

  function rememberTitle(source, sig, title) {
    var known = loadKnown(source);
    if (known.titles[sig] === title) return;
    known.titles[sig] = title;
    saveKnownLater();
  }

  // Запомнить, что ряд загрузился: название и было ли что показать
  function rememberResult(source, sig, json) {
    var known = loadKnown(source);
    var isEmpty = !json || !json.results || !json.results.length;
    if (json && json.title) rememberTitle(source, sig, json.title);
    if (!!known.empty[sig] !== isEmpty) {
      if (isEmpty) known.empty[sig] = true;
      else delete known.empty[sig];
      saveKnownLater();
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  Подписи рядов
  //
  //  Ряд нужно узнавать между запусками, хотя части — безымянные функции.
  //  Порядок приоритета: явное имя (row_name) → ключ перевода заголовка
  //  во встроенных рядах Lampa → хэш кода функции + номер повтора.
  // ─────────────────────────────────────────────────────────────

  function baseSignature(fn) {
    if (fn.row_name) return 'row:' + fn.row_name;
    var code = '';
    try {
      code = String(fn);
    } catch (e) { /* нативная функция */ }
    if (code.indexOf('TMDB.keywords') >= 0) return 'group:keywords';
    if (code.indexOf('person/popular') >= 0) return 'group:persons';
    var titleKey = code.match(/Lang\.translate\('(\w+)'\)/);
    if (titleKey) return 'title:' + titleKey[1];
    return 'fn:' + hashString(code);
  }

  function signParts(parts) {
    var seen = {};
    return parts.map(function (part) {
      if (typeof part !== 'function') return null;
      var base = baseSignature(part);
      seen[base] = (seen[base] || 0) + 1;
      return seen[base] > 1 ? base + '#' + seen[base] : base;
    });
  }

  // Новый порядок: ряды из сохранённого порядка — по нему, новые — сразу после
  // ряда, за которым они шли изначально. Новый ряд с row_top (например, баннер) — в самый верх.
  function applyOrder(natural, order, top) {
    var rank = {};
    order.forEach(function (sig, index) {
      rank[sig] = index;
    });
    var previous = -1;
    var entries = natural.map(function (sig, index) {
      var value;
      if (rank.hasOwnProperty(sig)) {
        value = rank[sig];
        previous = value;
      } else if (top && top[sig]) {
        value = -1;
      } else {
        value = previous + 0.5;
      }
      return { sig: sig, rank: value, index: index };
    });
    entries.sort(function (a, b) {
      return a.rank - b.rank || a.index - b.index;
    });
    return entries.map(function (entry) {
      return entry.sig;
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Перехват сборки главной
  // ─────────────────────────────────────────────────────────────

  var buildingSource = null;   // источник, чья главная сейчас собирается
  var sessionParts = {};       // source → { sig: исходная функция } для сканирования названий

  function learningPart(source, sig, original) {
    var part = function (call) {
      original(function (json) {
        rememberResult(source, sig, json);
        call.apply(null, arguments);
      });
    };
    part.main_editor_sig = sig;
    return part;
  }

  function hiddenPart(sig) {
    var part = function (call) {
      call();
    };
    part.main_editor_sig = sig;
    return part;
  }

  function prepareParts(parts, source) {
    parts[TAG] = source;
    var sigs = signParts(parts);
    var natural = [];
    var originals = {};
    var slots = [];
    var top = {};

    var known = loadKnown(source);

    sigs.forEach(function (sig, index) {
      if (!sig) return;
      natural.push(sig);
      originals[sig] = parts[index];
      slots.push(index);
      // Ряды плагинов могут сразу сообщить своё название (row_title)
      if (parts[index].row_title && !known.titles[sig]) known.titles[sig] = parts[index].row_title;
      if (parts[index].row_top) top[sig] = true;
    });

    known.sigs = natural;
    known.top = top;
    saveKnownLater();
    sessionParts[source] = originals;

    var config = loadConfig(source);
    applyOrder(natural, config.order, top).forEach(function (sig, position) {
      parts[slots[position]] = config.hidden[sig] ? hiddenPart(sig) : learningPart(source, sig, originals[sig]);
    });
  }

  function patchApi() {
    var originalMain = Lampa.Api.main;
    Lampa.Api.main = function (params) {
      var previous = buildingSource;
      buildingSource = (params && params.source) || currentSource();
      try {
        return originalMain.apply(this, arguments);
      } finally {
        buildingSource = previous;
      }
    };

    var originalPartNext = Lampa.Api.partNext;
    Lampa.Api.partNext = function (parts) {
      if (buildingSource && parts && !parts[TAG]) {
        try {
          prepareParts(parts, buildingSource);
        } catch (e) { /* при любой ошибке главная собирается как обычно */ }
      }
      return originalPartNext.apply(this, arguments);
    };

    // Lampa перемешивает хвост главной (жанры, подборки, актёры).
    // Ряды, которые пользователь расставил сам, оставляем на местах, мешаем только случайные.
    if (Lampa.Arrays && typeof Lampa.Arrays.shuffleArrayFromIndex === 'function') {
      var originalShuffle = Lampa.Arrays.shuffleArrayFromIndex;
      Lampa.Arrays.shuffleArrayFromIndex = function (array, start) {
        if (!array || !array[TAG] || start < 0 || start >= array.length) {
          return originalShuffle.apply(this, arguments);
        }
        var fixed = [];
        var free = [];
        array.slice(start).forEach(function (part) {
          if (typeof part === 'function' && part.main_editor_sig) fixed.push(part);
          else free.push(part);
        });
        originalShuffle.call(this, free, 0);
        fixed.concat(free).forEach(function (part, offset) {
          array[start + offset] = part;
        });
      };
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  Ряды из каталога
  // ─────────────────────────────────────────────────────────────

  function presetsEnabled() {
    return readObject(KEY_PRESETS);
  }

  function tmdbGet(path, onSuccess, onError) {
    var separator = path.indexOf('?') === -1 ? '?' : '&';
    var language = Lampa.Storage.get('language', 'ru') || 'ru';
    var url = Lampa.TMDB.api(path + separator + 'api_key=' + Lampa.TMDB.key() + '&language=' + language);
    var network = new Lampa.Reguest();
    network.timeout(REQUEST_TIMEOUT);
    network.silent(url, onSuccess, onError);
  }

  function presetCall(preset) {
    return function () {
      if (!presetsEnabled()[preset.id]) return;
      var part = function (call) {
        var path = preset.path();
        tmdbGet(path, function (json) {
          json.title = preset.title;
          json.url = path;
          json.source = 'tmdb';
          (json.results || []).forEach(function (item) {
            item.source = 'tmdb';
          });
          call(json);
        }, function () {
          call();
        });
      };
      part.row_name = 'preset_' + preset.id;
      part.row_title = preset.title;
      return part;
    };
  }

  function registerPresets() {
    if (!Lampa.ContentRows || typeof Lampa.ContentRows.add !== 'function') return;
    PRESETS.forEach(function (preset) {
      Lampa.ContentRows.add({
        name: 'MainEditor_' + preset.id,
        title: preset.title,
        index: PRESET_INDEX,
        screen: ['main'],
        call: presetCall(preset)
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Интерфейс редактора
  // ─────────────────────────────────────────────────────────────

  var editorBack = null;
  var editorChanged = false;

  function rowTitle(known, sig) {
    if (GROUP_TITLES[sig]) return GROUP_TITLES[sig];
    if (known.titles[sig]) return known.titles[sig];
    return known.empty[sig] ? 'Ряд плагина без названия' : 'Ряд без названия (ещё не загружался)';
  }

  function rowSubtitle(known, config, sig) {
    if (config.hidden[sig]) return 'Скрыт';
    if (known.empty[sig] && !GROUP_TITLES[sig]) return 'Пока пустой — на главной не виден';
    return '';
  }

  // Узнать названия рядов, которые ещё ни разу не загружались (пользователь до них не долистал)
  function scanTitles(source, done) {
    var known = loadKnown(source);
    var originals = sessionParts[source] || {};
    var missing = known.sigs.filter(function (sig) {
      return !known.titles[sig] && !known.empty[sig] && !GROUP_TITLES[sig] && originals[sig];
    });
    if (!missing.length) {
      done();
      return;
    }
    notify('Загружаю названия рядов…');
    var left = missing.length;
    var finished = false;
    function complete() {
      if (finished) return;
      finished = true;
      done();
    }
    var timer = setTimeout(complete, SCAN_TIMEOUT);
    missing.forEach(function (sig) {
      try {
        originals[sig](function (json) {
          rememberResult(source, sig, json);
          left--;
          if (left === 0) {
            clearTimeout(timer);
            complete();
          }
        });
      } catch (e) {
        left--;
      }
    });
  }

  function closeEditor() {
    Lampa.Controller.toggle(editorBack || 'settings_component');
    if (editorChanged) {
      editorChanged = false;
      notify('Сохранено. Откройте главную заново, чтобы увидеть изменения');
    }
  }

  function currentOrder(source) {
    var known = loadKnown(source);
    return applyOrder(known.sigs, loadConfig(source).order, known.top);
  }

  function moveRow(source, sig, targetIndex) {
    var order = currentOrder(source);
    var from = order.indexOf(sig);
    if (from < 0) return;
    order.splice(from, 1);
    targetIndex = Math.max(0, Math.min(order.length, targetIndex));
    order.splice(targetIndex, 0, sig);
    var config = loadConfig(source);
    config.order = order;
    saveConfig(source, config);
    editorChanged = true;
  }

  function toggleHidden(source, sig) {
    var config = loadConfig(source);
    if (config.hidden[sig]) delete config.hidden[sig];
    else config.hidden[sig] = true;
    // Фиксируем текущий порядок, чтобы скрытие не сдвигало остальные ряды
    config.order = currentOrder(source);
    saveConfig(source, config);
    editorChanged = true;
  }

  /**
   * Список рядов. Если передан movingSig — режим перемещения:
   * выбор любого ряда ставит перемещаемый ряд на его место.
   */
  function showRows(source, focusSig, movingSig) {
    var known = loadKnown(source);
    var config = loadConfig(source);
    var order = currentOrder(source);

    var items = order.map(function (sig, index) {
      var title = (index + 1) + '. ' + rowTitle(known, sig);
      if (sig === movingSig) title = '⇅ ' + title;
      return {
        title: title,
        subtitle: rowSubtitle(known, config, sig),
        sig: sig,
        index: index,
        selected: sig === focusSig
      };
    });

    Lampa.Select.show({
      title: movingSig ? 'Куда переместить «' + rowTitle(known, movingSig) + '»?' : 'Ряды главной',
      items: items,
      onSelect: function (item) {
        if (movingSig) {
          moveRow(source, movingSig, item.index);
          showRows(source, movingSig, null);
        } else {
          showRowMenu(source, item.sig);
        }
      },
      onBack: function () {
        if (movingSig) showRows(source, movingSig, null);
        else closeEditor();
      }
    });
  }

  function showRowMenu(source, sig) {
    var known = loadKnown(source);
    var config = loadConfig(source);
    var index = currentOrder(source).indexOf(sig);

    Lampa.Select.show({
      title: rowTitle(known, sig),
      items: [
        { title: config.hidden[sig] ? 'Показать на главной' : 'Скрыть с главной', action: 'toggle' },
        { title: 'Переместить…', subtitle: 'Затем выберите место в списке', action: 'move' },
        { title: 'Выше', action: 'up' },
        { title: 'Ниже', action: 'down' },
        { title: 'В самый верх', action: 'top' },
        { title: 'В самый низ', action: 'bottom' }
      ],
      onSelect: function (item) {
        if (item.action === 'move') {
          showRows(source, sig, sig);
          return;
        }
        if (item.action === 'toggle') toggleHidden(source, sig);
        if (item.action === 'up') moveRow(source, sig, index - 1);
        if (item.action === 'down') moveRow(source, sig, index + 1);
        if (item.action === 'top') moveRow(source, sig, 0);
        if (item.action === 'bottom') moveRow(source, sig, Number.MAX_VALUE);
        showRows(source, sig, null);
      },
      onBack: function () {
        showRows(source, sig, null);
      }
    });
  }

  function openEditor() {
    editorBack = currentController();
    var source = currentSource();
    if (!loadKnown(source).sigs.length) {
      notify('Сначала откройте главную страницу — список рядов появится после этого');
      return;
    }
    scanTitles(source, function () {
      showRows(source, null, null);
    });
  }

  function showPresets(focusId) {
    var enabled = presetsEnabled();
    Lampa.Select.show({
      title: 'Добавить ряды на главную',
      items: PRESETS.map(function (preset) {
        return {
          title: (enabled[preset.id] ? '✓ ' : '') + preset.title,
          subtitle: enabled[preset.id] ? 'Добавлен' : '',
          id: preset.id,
          selected: preset.id === focusId
        };
      }),
      onSelect: function (item) {
        var current = presetsEnabled();
        if (current[item.id]) delete current[item.id];
        else current[item.id] = true;
        Lampa.Storage.set(KEY_PRESETS, current);
        editorChanged = true;
        showPresets(item.id);
      },
      onBack: closeEditor
    });
  }

  function openPresets() {
    editorBack = currentController();
    showPresets(null);
  }

  function resetSource() {
    var source = currentSource();
    var all = readObject(KEY_CONFIG);
    delete all[source];
    Lampa.Storage.set(KEY_CONFIG, all);
    notify('Порядок и видимость рядов сброшены');
  }

  // ─────────────────────────────────────────────────────────────
  //  Настройки
  // ─────────────────────────────────────────────────────────────

  function addButton(name, title, description, action) {
    Lampa.SettingsApi.addParam({
      component: 'main_editor',
      param: { name: name, type: 'button' },
      field: { name: title, description: description },
      onChange: action
    });
  }

  function addSettings() {
    if (!Lampa.SettingsApi) return;
    Lampa.SettingsApi.addComponent({
      component: 'main_editor',
      name: 'Главная страница',
      icon: ICON
    });
    addButton('main_editor_rows', 'Порядок и видимость рядов', 'Переставить, скрыть или вернуть ряды текущего источника', openEditor);
    addButton('main_editor_presets', 'Добавить ряды', 'Аниме, Netflix, российские сериалы и другое', openPresets);
    addButton('main_editor_reset', 'Сбросить', 'Вернуть стандартный порядок рядов текущего источника', resetSource);
  }

  // ─────────────────────────────────────────────────────────────
  //  Запуск
  // ─────────────────────────────────────────────────────────────

  function start() {
    if (!Lampa.Api || typeof Lampa.Api.partNext !== 'function' || typeof Lampa.Api.main !== 'function') return;
    patchApi();
    registerPresets();
    addSettings();
  }

  if (window.appready) start();
  else {
    Lampa.Listener.follow('app', function (e) {
      if (e.type === 'ready') start();
    });
  }
})();

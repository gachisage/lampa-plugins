/*
 * Cinema — оформление Лампы в стиле современного ТВ-кинотеатра.
 *
 *   1. Баннер наверху главной: большие кадры из популярных фильмов и сериалов недели
 *      с логотипом, жанрами и описанием. Влево/вправо — листать, ОК — открыть.
 *   2. Логотипы вместо текстовых названий в баннере.
 *   3. Живой фон: на главной и в категориях за рядами проявляется кадр из фильма под фокусом.
 *
 * Картинки и логотипы — TMDB через встроенный в Лампу прокси. Код на ES5 для старых ТВ.
 */
(function () {
  'use strict';

  if (window.cinema_loaded) return;
  window.cinema_loaded = true;

  var SETTING = {
    hero: 'cinema_hero',
    logos: 'cinema_logos',
    ambient: 'cinema_ambient'
  };

  var DAY = 24 * 60 * 60 * 1000;
  var HERO_TTL = 6 * 60 * 60 * 1000;
  var HERO_SLIDES = 8;
  var HERO_KEY = 'cinema_hero_cache';
  var LOGO_KEY = 'cinema_logo_cache';
  var LOGO_TTL = 30 * DAY;
  var LOGO_MISSING_TTL = 7 * DAY;
  var LOGO_LIMIT = 400;
  var REQUEST_TIMEOUT = 15000;
  var AMBIENT_DELAY = 350;
  var AMBIENT_SCREENS = { main: true, category: true };
  var LOGO_LANGUAGES = ['ru', 'en', null];

  var BACKDROP_SIZE = 'w1280';
  var LOGO_SIZE = 'w500';
  var TALL_LOGO_RATIO = 3;

  var STYLE = [
    '.items-line--type-cinema-hero .items-line__body{padding-top:.3em}',
    '.items-line--type-cinema-hero .scroll__body{padding-bottom:1em}',
    '.cinema-hero{position:relative;flex-shrink:0;width:82vw;height:34vw;min-height:14em;max-height:62vh;',
    'margin-right:1.2em;border-radius:1em;overflow:hidden;background-color:rgba(255,255,255,.06)}',
    '.cinema-hero__bg{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .6s}',
    '.cinema-hero--loaded .cinema-hero__bg{opacity:1}',
    '.cinema-hero__shade{position:absolute;top:0;left:0;width:100%;height:100%;',
    'background:linear-gradient(90deg,rgba(0,0,0,.88) 0%,rgba(0,0,0,.6) 38%,rgba(0,0,0,0) 72%),',
    'linear-gradient(0deg,rgba(0,0,0,.7) 0%,rgba(0,0,0,0) 45%)}',
    '.cinema-hero__content{position:absolute;left:2.4em;bottom:2.2em;width:44%}',
    '.cinema-hero__logo{display:block;width:auto;height:4.5em;max-width:100%;margin-bottom:.9em;object-fit:contain;object-position:left bottom}',
    '.cinema-hero__logo.cinema-logo--tall{height:7em}',
    '.cinema-hero__title{font-size:2.6em;font-weight:700;line-height:1.1;margin-bottom:.4em}',
    '.cinema-hero__meta{font-size:1.1em;color:rgba(255,255,255,.75);margin-bottom:.7em}',
    '.cinema-hero__badge{display:inline-block;padding:.1em .5em;margin-right:.6em;border-radius:.3em;',
    'background:rgba(255,255,255,.18);color:#fff;font-weight:600}',
    '.cinema-hero__overview{font-size:1.1em;line-height:1.4;color:rgba(255,255,255,.85);',
    'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}',
    '.cinema-hero.focus{box-shadow:0 0 0 .25em #fff}',
    '.cinema-hero__hint{margin-top:1em;font-size:1em;color:rgba(255,255,255,.55);opacity:0;transition:opacity .3s}',
    '.cinema-hero.focus .cinema-hero__hint{opacity:1}',
    '.cinema-ambient{position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;opacity:0;transition:opacity .5s}',
    '.cinema-ambient--active{opacity:1}',
    '.cinema-ambient__img{position:absolute;top:0;right:0;width:72%;height:80%;object-fit:cover;opacity:0;transition:opacity .8s}',
    '.cinema-ambient__img--show{opacity:.55}',
    '.cinema-ambient__shade{position:absolute;top:0;left:0;width:100%;height:100%;',
    'background:linear-gradient(90deg,#121212 28%,rgba(18,18,18,.55) 55%,rgba(18,18,18,0) 100%),',
    'linear-gradient(0deg,#121212 20%,rgba(18,18,18,0) 70%)}',
    '@media (max-width:767px){.cinema-hero{width:88vw;height:56vw}.cinema-hero__content{left:1.2em;bottom:1.2em;width:80%}',
    '.cinema-hero__overview{-webkit-line-clamp:2}.cinema-hero__title{font-size:1.8em}}'
  ].join('');

  var HERO_ICON = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm6 4v6l5-3z"/></svg>';

  function isOn(name, defaultValue) {
    var value = Lampa.Storage.get(name, defaultValue ? 'true' : 'false');
    return value === true || value === 'true';
  }

  function language() {
    return Lampa.Storage.get('tmdb_lang', 'ru') || 'ru';
  }

  function tmdbGet(path, onSuccess, onError) {
    var separator = path.indexOf('?') === -1 ? '?' : '&';
    var url = Lampa.TMDB.api(path + separator + 'api_key=' + Lampa.TMDB.key());
    var network = new Lampa.Reguest();
    network.timeout(REQUEST_TIMEOUT);
    network.silent(url, onSuccess, onError || function () {});
  }

  function tmdbImage(size, path) {
    return path ? Lampa.TMDB.image('t/p/' + size + path) : '';
  }

  function kindOf(card) {
    if (card.media_type === 'tv' || card.method === 'tv' || card.name || card.first_air_date) return 'tv';
    return 'movie';
  }

  function openCard(card) {
    Lampa.Activity.push({
      url: '',
      component: 'full',
      id: card.id,
      method: kindOf(card),
      card: card,
      source: card.source || 'tmdb'
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Логотипы TMDB: { "<kind>:<id>": { t: время, p: путь или '' } }
  // ─────────────────────────────────────────────────────────────

  var logoMemory = null;
  var logoWaiting = {};

  function logoCache() {
    if (!logoMemory) {
      var stored = Lampa.Storage.get(LOGO_KEY, '{}');
      logoMemory = stored && typeof stored === 'object' ? stored : {};
    }
    return logoMemory;
  }

  function saveLogo(key, path) {
    var cache = logoCache();
    cache[key] = { t: Date.now(), p: path };
    var keys = Object.keys(cache);
    if (keys.length > LOGO_LIMIT) {
      keys.sort(function (a, b) { return cache[a].t - cache[b].t; });
      keys.slice(0, keys.length - LOGO_LIMIT).forEach(function (k) { delete cache[k]; });
    }
    Lampa.Storage.set(LOGO_KEY, cache);
  }

  function pickLogo(logos) {
    for (var i = 0; i < LOGO_LANGUAGES.length; i++) {
      var lang = LOGO_LANGUAGES[i];
      var matching = logos.filter(function (logo) { return logo.iso_639_1 === lang; });
      if (!matching.length) continue;
      matching.sort(function (a, b) {
        var png = (/\.png$/i.test(b.file_path) ? 1 : 0) - (/\.png$/i.test(a.file_path) ? 1 : 0);
        return png || (b.vote_average || 0) - (a.vote_average || 0);
      });
      return matching[0].file_path;
    }
    return '';
  }

  // Узкие многострочные логотипы при той же высоте выглядят мелкими — им даём больше места
  function markTall(img) {
    if (img.naturalHeight && img.naturalWidth / img.naturalHeight < TALL_LOGO_RATIO) img.classList.add('cinema-logo--tall');
  }

  // callback(url или '')
  function loadLogo(card, callback) {
    var key = kindOf(card) + ':' + card.id;
    var cached = logoCache()[key];
    if (cached && Date.now() - cached.t < (cached.p ? LOGO_TTL : LOGO_MISSING_TTL)) {
      return callback(tmdbImage(LOGO_SIZE, cached.p));
    }

    if (logoWaiting[key]) return logoWaiting[key].push(callback);
    logoWaiting[key] = [callback];

    var finish = function (path) {
      saveLogo(key, path);
      var callbacks = logoWaiting[key];
      delete logoWaiting[key];
      callbacks.forEach(function (cb) { cb(tmdbImage(LOGO_SIZE, path)); });
    };

    tmdbGet(kindOf(card) + '/' + card.id + '/images?include_image_language=ru,en,null', function (json) {
      finish(pickLogo((json && json.logos) || []));
    }, function () {
      var callbacks = logoWaiting[key];
      delete logoWaiting[key];
      callbacks.forEach(function (cb) { cb(''); });
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  1. Баннер на главной
  // ─────────────────────────────────────────────────────────────

  var genreNames = {};

  function loadGenres(callback) {
    if (Object.keys(genreNames).length) return callback();
    var lang = '&language=' + language();
    var pending = 2;
    var done = function () { if (--pending === 0) callback(); };
    ['movie', 'tv'].forEach(function (kind) {
      tmdbGet('genre/' + kind + '/list?' + lang.slice(1), function (json) {
        ((json && json.genres) || []).forEach(function (genre) { genreNames[genre.id] = genre.name; });
        done();
      }, done);
    });
  }

  function heroMeta(card) {
    var parts = [];
    var year = (card.release_date || card.first_air_date || '').slice(0, 4);
    if (year) parts.push(year);
    var genres = (card.genre_ids || []).map(function (id) { return genreNames[id]; }).filter(Boolean).slice(0, 2);
    if (genres.length) parts.push(genres.join(', '));
    parts.push(kindOf(card) === 'tv' ? 'Сериал' : 'Фильм');
    return parts.join(' · ');
  }

  function loadHeroCards(callback) {
    var cached = Lampa.Storage.get(HERO_KEY, '{}');
    if (cached && cached.lang === language() && Date.now() - cached.t < HERO_TTL && cached.results && cached.results.length) {
      return loadGenres(function () { callback(cached.results); });
    }

    tmdbGet('trending/all/week?language=' + language(), function (json) {
      var results = ((json && json.results) || []).filter(function (card) {
        return card.backdrop_path && (card.media_type === 'movie' || card.media_type === 'tv') && card.overview;
      }).slice(0, HERO_SLIDES).map(function (card) {
        card.source = 'tmdb';
        return card;
      });
      Lampa.Storage.set(HERO_KEY, { t: Date.now(), lang: language(), results: results });
      loadGenres(function () { callback(results); });
    }, function () {
      callback(cached && cached.results ? cached.results : []);
    });
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  // Элемент ряда Лампы: create / render / destroy, события hover:* приходят на корневой узел
  function HeroSlide(data) {
    this.data = data;
  }

  HeroSlide.prototype.create = function () {
    var card = this.data.card;
    var root = element('div', 'cinema-hero selector layer--visible layer--render');
    var background = element('img', 'cinema-hero__bg');
    var content = element('div', 'cinema-hero__content');
    var title = element('div', 'cinema-hero__title', card.title || card.name);
    var meta = element('div', 'cinema-hero__meta');

    background.alt = '';
    if (card.vote_average) meta.appendChild(element('span', 'cinema-hero__badge', card.vote_average.toFixed(1)));
    meta.appendChild(document.createTextNode(heroMeta(card)));
    content.appendChild(title);
    content.appendChild(meta);
    content.appendChild(element('div', 'cinema-hero__overview', card.overview));
    content.appendChild(element('div', 'cinema-hero__hint', 'ОК — подробнее'));
    root.appendChild(background);
    root.appendChild(element('div', 'cinema-hero__shade'));
    root.appendChild(content);

    background.onload = function () { root.classList.add('cinema-hero--loaded'); };
    root.addEventListener('visible', function () {
      if (background.getAttribute('src')) return;
      background.src = tmdbImage(BACKDROP_SIZE, card.backdrop_path);
      if (!isOn(SETTING.logos, true)) return;
      loadLogo(card, function (url) {
        if (!url) return;
        var logo = element('img', 'cinema-hero__logo');
        logo.alt = card.title || card.name;
        logo.onload = function () {
          markTall(logo);
          content.replaceChild(logo, title);
        };
        logo.src = url;
      });
    });
    root.addEventListener('hover:enter', function () { openCard(card); });

    this.html = root;
    this.background = background;
  };

  HeroSlide.prototype.render = function (js) {
    return js ? this.html : $(this.html);
  };

  HeroSlide.prototype.use = function () {};

  HeroSlide.prototype.destroy = function () {
    if (!this.html) return;
    this.background.onload = null;
    this.background.removeAttribute('src');
    if (this.html.parentNode) this.html.parentNode.removeChild(this.html);
    this.html = null;
  };

  function registerHero() {
    var part = function (done) {
      loadHeroCards(function (cards) {
        if (!cards.length) return done();
        done({
          title: '',
          results: cards.map(function (card) {
            return {
              id: card.id,
              card: card,
              params: { createInstance: function (item) { return new HeroSlide(item); } }
            };
          }),
          params: {
            type: 'cinema-hero',
            items: { mapping: 'line', align_left: true, view: 3 }
          }
        });
      });
    };
    part.row_name = 'cinema_hero';
    part.row_title = 'Баннер «Кинотеатр»';
    part.row_top = true;

    Lampa.ContentRows.add({
      name: 'cinema_hero',
      title: 'Баннер «Кинотеатр»',
      index: 0,
      screen: ['main'],
      call: function () {
        return isOn(SETTING.hero, true) ? part : undefined;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  3. Живой фон за рядами главной
  // ─────────────────────────────────────────────────────────────

  var ambient = null;

  function createAmbient() {
    var root = element('div', 'cinema-ambient');
    var images = [element('img', 'cinema-ambient__img'), element('img', 'cinema-ambient__img')];
    images.forEach(function (img) {
      img.alt = '';
      img.onload = function () {
        images.forEach(function (other) { other.classList.remove('cinema-ambient__img--show'); });
        img.classList.add('cinema-ambient__img--show');
      };
      root.appendChild(img);
    });
    root.appendChild(element('div', 'cinema-ambient__shade'));

    var background = Lampa.Background.render();
    var anchor = background && background.jquery ? background[0] : background;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(root, anchor.nextSibling);
    else document.body.insertBefore(root, document.body.firstChild);

    return { root: root, images: images, next: 0, src: '', timer: 0 };
  }

  function showAmbient(path) {
    if (!ambient) return;
    var src = tmdbImage(BACKDROP_SIZE, path);
    if (!src || src === ambient.src) return;
    ambient.src = src;
    clearTimeout(ambient.timer);
    ambient.timer = setTimeout(function () {
      var img = ambient.images[ambient.next];
      ambient.next = 1 - ambient.next;
      img.src = src;
    }, AMBIENT_DELAY);
  }

  function setAmbientActive(active) {
    if (!ambient) return;
    if (active) ambient.root.classList.add('cinema-ambient--active');
    else ambient.root.classList.remove('cinema-ambient--active');
  }

  function currentScreen() {
    var activity = Lampa.Activity.active();
    return activity ? activity.component : '';
  }

  function startAmbient() {
    ambient = createAmbient();

    document.addEventListener('hover:focus', function (event) {
      if (!isOn(SETTING.ambient, true) || !AMBIENT_SCREENS[currentScreen()]) return;
      var data = event.target && event.target.card_data;
      if (data && data.backdrop_path) showAmbient(data.backdrop_path);
    }, true);

    Lampa.Listener.follow('activity', function (event) {
      if (event.type !== 'start') return;
      setAmbientActive(isOn(SETTING.ambient, true) && !!AMBIENT_SCREENS[event.component]);
    });

    setAmbientActive(isOn(SETTING.ambient, true) && !!AMBIENT_SCREENS[currentScreen()]);
  }

  // ─────────────────────────────────────────────────────────────
  //  Настройки и запуск
  // ─────────────────────────────────────────────────────────────

  function addTrigger(name, title, description, onChange) {
    Lampa.SettingsApi.addParam({
      component: 'cinema',
      param: { name: name, type: 'trigger', 'default': true },
      field: { name: title, description: description },
      onChange: onChange
    });
  }

  function addSettings() {
    if (!Lampa.SettingsApi) return;
    Lampa.SettingsApi.addComponent({ component: 'cinema', name: 'Кинотеатр', icon: HERO_ICON });
    addTrigger(SETTING.hero, 'Баннер на главной', 'Большие кадры популярного за неделю наверху главной');
    addTrigger(SETTING.logos, 'Логотипы в баннере', 'Логотип фильма вместо текстового названия');
    addTrigger(SETTING.ambient, 'Живой фон', 'Кадр из фильма под фокусом за рядами главной', function () {
      setAmbientActive(isOn(SETTING.ambient, true) && !!AMBIENT_SCREENS[currentScreen()]);
    });
  }

  function addStyle() {
    var style = element('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function start() {
    addStyle();
    addSettings();
    registerHero();
    startAmbient();
  }

  if (window.appready) start();
  else {
    Lampa.Listener.follow('app', function (event) {
      if (event.type === 'ready') start();
    });
  }
})();

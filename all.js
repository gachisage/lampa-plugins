/*
 * Все плагины одной ссылкой (Lampa).
 *
 * Подключает остальные плагины из той же папки. Если какой-то из них уже установлен
 * отдельной ссылкой, второй раз он не запустится: у каждого плагина есть защита от повтора.
 * Код написан на ES5, чтобы работать на старых WebView телевизоров.
 */
(function () {
  'use strict';

  if (window.gs_lampa_plugins_all_loaded) return;
  window.gs_lampa_plugins_all_loaded = true;

  var FALLBACK_BASE = 'https://gachisage.github.io/lampa-plugins/';
  var PLUGINS = [
    'trakt-plus.js',
    'main-editor.js',
    'episode-info.js',
    'continue-watch.js',
    'cinema.js',
    'next-episode.js',
    'skip-intro.js',
    'trailers.js'
  ];

  // Папка, откуда загружен этот файл: так работают и копии на других адресах
  function baseUrl() {
    var script = document.currentScript;
    var src = script && script.src ? script.src.split('?')[0] : '';
    return src ? src.slice(0, src.lastIndexOf('/') + 1) : FALLBACK_BASE;
  }

  var base = baseUrl();
  Lampa.Utils.putScriptAsync(PLUGINS.map(function (name) {
    return base + name;
  }), function () {});
})();

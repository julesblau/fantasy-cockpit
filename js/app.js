(function () {
  'use strict';
  var store = DC.state.createStore(DC.state.load());
  DC.ui.mount(store);
  DC.edit.mount(store);
  DC.compare.mount(store);
  if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(function () {});
  }
})();

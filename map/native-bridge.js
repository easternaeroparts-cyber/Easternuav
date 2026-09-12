/* Fly Eastern native bridge
   Loaded on every platform. Does nothing extra in a browser or plain
   installed-PWA — only activates when running inside the Capacitor
   native app shell (Cap = window.Capacitor). This is what makes the
   app a real native app rather than a webview pointed at a URL:
   real GPS, a real share sheet, haptic feedback, and native chrome
   styling, all wired to the same UI Fly Eastern already has. */
(function () {
  const Cap = window.Capacitor;
  const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());

  // ---- 1. Native GPS instead of the browser's geolocation ----
  // The existing "Use my location" button just calls
  // navigator.geolocation.getCurrentPosition — we swap the underlying
  // implementation so that call now goes through the device's native
  // location services (faster fix, works with native permission
  // dialogs, more accurate on Android/iOS than the WebView API).
  if (isNative && Cap.Plugins && Cap.Plugins.Geolocation) {
    const Geo = Cap.Plugins.Geolocation;
    navigator.geolocation.getCurrentPosition = function (success, error, options) {
      Geo.getCurrentPosition({
        enableHighAccuracy: options && options.enableHighAccuracy !== undefined ? options.enableHighAccuracy : true,
        timeout: (options && options.timeout) || 10000
      }).then((pos) => success(pos)).catch((err) => { if (error) error(err); });
    };
  }

  // ---- 2. Native share sheet ----
  // window.udaanShare(res) is called from the share button next to
  // every verdict. On native it opens the real iOS/Android share
  // sheet (Messages, WhatsApp, Viber, etc — all popular in Nepal).
  // In a browser it falls back to the Web Share API, then to
  // copy-to-clipboard so it still always works.
  window.udaanShare = function (res) {
    const lat = res.lat.toFixed(5), lon = res.lon.toFixed(5);
    const z = (window.view && window.view.z) ? window.view.z.toFixed(1) : '12';
    const url = `${location.origin}${location.pathname}#${lat},${lon},${z}`;
    const label = res.level === 'red' ? 'No-fly zone' : res.level === 'amber' ? 'Restricted / permit needed' : res.level === 'green' ? 'Likely OK, check conditions' : 'Outside Nepal';
    const text = `Fly Eastern check for ${lat}, ${lon}: ${label}`;

    if (isNative && Cap.Plugins && Cap.Plugins.Share) {
      Cap.Plugins.Share.share({ title: 'Fly Eastern — drone airspace check', text, url, dialogTitle: 'Share this spot' }).catch(() => {});
      return;
    }
    if (navigator.share) {
      navigator.share({ title: 'Fly Eastern', text, url }).catch(() => {});
      return;
    }
    navigator.clipboard?.writeText(url).then(() => { if (window.toast) window.toast('Link copied'); });
  };

  // ---- 3. Haptic feedback when the verdict changes ----
  // A short tap buzz whenever a new spot is checked and the verdict
  // panel updates — small detail, but it's the kind of feedback that
  // reads as "native app" rather than "web page".
  if (isNative && Cap.Plugins && Cap.Plugins.Haptics) {
    const Haptics = Cap.Plugins.Haptics;
    const verdictEl = document.getElementById('verdict') || document.querySelector('.verdict');
    if (verdictEl) {
      let lastLevel = null;
      new MutationObserver(() => {
        const level = verdictEl.dataset.level;
        if (level && level !== lastLevel) {
          lastLevel = level;
          Haptics.impact({ style: level === 'red' ? 'Heavy' : 'Light' }).catch(() => {});
        }
      }).observe(verdictEl, { attributes: true, attributeFilter: ['data-level'] });
    }
  }

  // ---- 4. Native status bar + splash screen ----
  if (isNative) {
    if (Cap.Plugins && Cap.Plugins.StatusBar) {
      Cap.Plugins.StatusBar.setBackgroundColor({ color: '#1F3F8F' }).catch(() => {});
      Cap.Plugins.StatusBar.setStyle({ style: 'DARK' }).catch(() => {});
    }
    if (Cap.Plugins && Cap.Plugins.SplashScreen) {
      // Hide the native splash once the map has actually drawn,
      // instead of on a fixed timer — avoids a blank flash.
      window.addEventListener('load', () => {
        setTimeout(() => Cap.Plugins.SplashScreen.hide().catch(() => {}), 250);
      });
    }
  }

  // ---- 5. Android hardware back button ----
  // First press closes any open search results; only a second press
  // (or pressing back with nothing open) exits, like a real Android app.
  if (isNative && Cap.Plugins && Cap.Plugins.App) {
    Cap.Plugins.App.addListener('backButton', () => {
      const results = document.getElementById('results');
      if (results && !results.hidden) {
        results.hidden = true;
        return;
      }
      Cap.Plugins.App.exitApp();
    });
  }
})();

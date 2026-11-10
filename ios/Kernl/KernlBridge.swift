import Foundation

/// Script injected at the start of every KERNL page.
/// It is the only thing that defines `window.KernlNative`. The public website does not.
/// Purchases still have to go through StoreKit; this script cannot invent a receipt.
enum KernlBridge {
    static var source: String {
        let redirect = jsonString(KernlConfig.oauthRedirect)
        return """
        (function () {
          if (window.KernlNative && window.KernlNative.isKernlApp) return;
          var pending = Object.create(null);
          var seq = 0;
          function call(name, payload) {
            return new Promise(function (resolve) {
              var id = 'k' + (++seq);
              pending[id] = resolve;
              try {
                window.webkit.messageHandlers.kernl.postMessage({ id: id, name: name, payload: payload || {} });
              } catch (e) {
                resolve({ ok: false, error: 'The app could not reach Apple. Please try again.' });
              }
            });
          }
          window.__kernlNativeResolve = function (id, result) {
            var fn = pending[id];
            if (!fn) return;
            delete pending[id];
            fn(result || { ok: false });
          };
          window.__kernlAccessToken = function () {
            try {
              var keys = Object.keys(localStorage);
              var fallback = '';
              for (var i = 0; i < keys.length; i++) {
                var key = keys[i];
                if (key.indexOf('sb-') !== 0 || key.indexOf('-auth-token') === -1) continue;
                if (key.indexOf('.') !== -1) continue;
                var data = JSON.parse(localStorage.getItem(key) || 'null');
                if (typeof data === 'string') data = JSON.parse(data);
                if (data && data.access_token) {
                  if (!(data.user && data.user.is_anonymous)) return data.access_token;
                  fallback = data.access_token;
                }
              }
              return fallback;
            } catch (e) {
              return '';
            }
          };
          window.KernlNative = {
            isKernlApp: true,
            oauthRedirect: \(redirect),
            purchasePro: function (productId) { return call('purchase', { productId: productId || '' }); },
            restorePro: function () { return call('restore', {}); },
            signInWithApple: function () { return call('appleSignIn', {}); }
          };
        })();
        """
    }

    private static func jsonString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let text = String(data: data, encoding: .utf8), text.count >= 2 else { return "\"\"" }
        return String(text.dropFirst().dropLast())
    }
}

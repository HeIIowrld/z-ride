/* Z-RIDE DEADZONE integration reference. Apache-2.0. Not installed in the existing app. */
package dev.zride.integration;

import android.content.Context;
import android.net.Uri;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;

/** The owning app supplies a trusted HTTPS origin and verified parked state. No vehicle setters. */
public final class DeadzoneDashboardView {
    public interface Listener { void onSnapshot(String json); }
    private final WebView view;
    private final Uri origin;
    private final Listener listener;

    public DeadzoneDashboardView(Context context, String trustedHttpsOrigin, Listener listener) {
        origin = Uri.parse(trustedHttpsOrigin);
        if (!"https".equals(origin.getScheme()) || origin.getHost() == null || origin.getUserInfo() != null)
            throw new IllegalArgumentException("Use a trusted HTTPS dashboard origin");
        this.listener = listener;
        view = new WebView(context);
        view.setVisibility(View.GONE); // Unknown parking state is not permission to display.
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        view.addJavascriptInterface(new ReadOnlyBridge(), "ZRideDashboardBridge");
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                Uri uri = request.getUrl();
                return !sameOrigin(uri) || !uri.getPath().startsWith("/dashboard");
            }
        });
    }

    private boolean sameOrigin(Uri uri) {
        return "https".equals(uri.getScheme()) && origin.getHost().equals(uri.getHost())
                && origin.getPort() == uri.getPort();
    }
    public WebView getView() { return view; }
    public void loadDashboard(String dashboardUrl) {
        Uri uri = Uri.parse(dashboardUrl);
        if (!sameOrigin(uri) || !uri.getPath().startsWith("/dashboard"))
            throw new IllegalArgumentException("Dashboard must use the trusted origin");
        view.loadUrl(dashboardUrl);
    }
    /** Call on the UI thread from the app's real P / UX restriction callback. */
    public void setDisplayAllowed(boolean parkedAndUxAllowed) {
        view.setVisibility(parkedAndUxAllowed ? View.VISIBLE : View.GONE);
    }
    public void destroy() {
        view.removeJavascriptInterface("ZRideDashboardBridge");
        view.stopLoading(); view.destroy();
    }
    private final class ReadOnlyBridge {
        @JavascriptInterface public void onSnapshot(String json) {
            if (json == null || json.length() > 262144 || listener == null) return;
            try {
                JSONObject value = new JSONObject(json);
                if (!"zride.dashboard.v1".equals(value.optString("schema"))) return;
                view.post(() -> listener.onSnapshot(json));
            } catch (Exception ignored) { /* A malformed web message cannot call a vehicle API. */ }
        }
    }
}

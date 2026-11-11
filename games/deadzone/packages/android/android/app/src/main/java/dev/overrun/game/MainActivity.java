package dev.overrun.game;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/*  ============================== OVERRUN / SHELL ==============================

    Everything native this game needs, and nothing else.

      - immersive sticky fullscreen, edge to edge, drawing under the cutout
      - the screen stays awake while the activity is in front: the web app asks
        for a wake lock at match start, but Android WebView has no Wake Lock
        API, so the window flag is the real implementation of that request
      - the WebView is tuned for a game rather than for a document: hardware
        layer, no text autosizing, audio allowed to start without a gesture
      - back once  -> the web app's pause menu (an Escape keydown, which Input
        already binds to App.togglePause)
        back twice within two seconds -> leave the game

    No plugin, no service, no background work, no network code lives here.    */
public class MainActivity extends BridgeActivity {

    /** A second back press must land inside this window to actually exit. */
    private static final long EXIT_CONFIRM_MS = 2000L;

    private long lastBackPressAt = 0L;
    private Toast backToast;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Keep drawing while the screen would otherwise dim. A run can last
        // twenty minutes with the player's thumbs never leaving the edges.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Draw into the cutout instead of letting the system letterbox the game
        // away from it. Landscape plus a notch is the common case here.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                    ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        tuneWebView();
        goImmersive();

        getOnBackPressedDispatcher()
            .addCallback(this, new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    onBackRequested();
                }
            });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Sticky immersive: the bars come back on a swipe and have to be sent
        // away again once the player stops interacting with them.
        if (hasFocus) goImmersive();
    }

    @Override
    public void onResume() {
        super.onResume();
        goImmersive();
    }

    /* --------------------------------------------------------------- ui */

    private void goImmersive() {
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }

    /* ---------------------------------------------------------- webview */

    private void tuneWebView() {
        WebView webView = this.bridge != null ? this.bridge.getWebView() : null;
        if (webView == null) return;

        WebSettings settings = webView.getSettings();

        // The HUD is laid out in CSS pixels. With the system font size at 130%
        // a player would otherwise get a HUD that overflows the screen.
        settings.setTextZoom(100);

        // The audio engine builds its graph on the first user gesture, but the
        // music bed and the UI clicks must be allowed to start on their own.
        settings.setMediaPlaybackRequiresUserGesture(false);

        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setJavaScriptEnabled(true);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setOffscreenPreRaster(true);

        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        webView.setBackgroundColor(0xFF0E1620);
        webView.setKeepScreenOn(true);
        webView.setFocusableInTouchMode(true);

        // A long press in the middle of a firefight should not raise a text
        // selection handle over the canvas.
        webView.setLongClickable(false);
        webView.setHapticFeedbackEnabled(false);
        webView.setOnLongClickListener(v -> true);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
    }

    /* ------------------------------------------------------------- back */

    private void onBackRequested() {
        long now = System.currentTimeMillis();

        if (now - lastBackPressAt < EXIT_CONFIRM_MS) {
            if (backToast != null) backToast.cancel();
            finish();
            return;
        }

        lastBackPressAt = now;

        // The web app binds Escape to its pause menu (Input -> App.togglePause).
        // Dispatching the key is enough; there is no bespoke bridge event that
        // would then have to be kept in sync with the game code.
        if (this.bridge != null) {
            this.bridge.eval(
                "window.dispatchEvent(new KeyboardEvent('keydown', {" +
                "key:'Escape', code:'Escape', keyCode:27, which:27," +
                "bubbles:true, cancelable:true}));",
                null
            );
        }

        backToast = Toast.makeText(this, "PRESS BACK AGAIN TO EXIT", Toast.LENGTH_SHORT);
        backToast.show();
    }
}

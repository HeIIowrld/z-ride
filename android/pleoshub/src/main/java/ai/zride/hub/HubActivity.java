package ai.zride.hub;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import ai.pleos.playground.vehicle.Vehicle;
import ai.pleos.playground.vehicle.api.EvBattery;
import ai.pleos.playground.vehicle.listener.EvBatteryStateOfChargeListener;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import kotlin.Unit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * PLY 게임 허브. 게임 목록을 보여 주고, 고른 게임의 큰 화면(웹 페이지)을 WebView로 띄운다.
 * 모든 게임은 같은 창구 window.ZRideCar(브리지 v1)로 차 신호를 받고 실내 연출을 요청한다.
 * 실내 연출은 P단·UX 허용·화면 표시 중일 때만 적용하고, 그 밖에는 원래 값으로 되돌린다.
 * 명세: games/sdk/README.md
 */
public final class HubActivity extends Activity implements DrivingGate.Listener {
    static final String TAG = "ZRideHub";
    static final int BRIDGE_VERSION = 1;
    private static final int BG = Color.rgb(16, 21, 31), CARD = Color.rgb(29, 37, 52), MUTED = Color.rgb(160, 170, 185), VOLT = Color.rgb(255, 214, 64);
    private final Handler main = new Handler(Looper.getMainLooper());
    // SDK 호출은 서비스가 붙을 때까지 멈출 수 있어서 화면 스레드에서 부르지 않는다
    private final HandlerThread carThread = new HandlerThread("car");
    private Handler car;
    private volatile boolean starting;
    private final List<JSONObject> games = new ArrayList<>();
    private boolean debug;
    private Bundle extras;
    private FrameLayout root;
    private View list, offline;
    private WebView web;
    private DrivingGate gate;
    private Vehicle vehicle;
    private EvBattery battery;
    private EvBatteryStateOfChargeListener socListener;
    private volatile Cabin cabin;
    private Integer soc;
    private boolean foreground, pageFailed;
    private volatile JSONObject game;   // 지금 띄운 게임. 목록 화면이면 null
    private volatile String gameOrigin; // 브리지는 이 출처의 페이지에만 답한다
    private String lastSignal = "";
    private final Runnable reload = () -> { if (pageFailed && game != null) { pageFailed = false; web.loadUrl(game.optString("url")); } };
    // 차량 서비스는 비동기로 붙는다. 배터리가 읽힐 때까지 다시 시도하고, 1초마다 페이지에 신호를 보낸다
    private final Runnable heartbeat = new Runnable() {
        public void run() {
            if (soc == null && !starting) { starting = true; car.post(HubActivity.this::startBattery); }
            else if (cabin != null) car.post(cabin::refresh);
            signal(false);
            main.postDelayed(this, 1000);
        }
    };

    /** 게임 페이지가 부르는 창구(브리지 v1). 자바스크립트 스레드에서 불린다. */
    private final class Bridge {
        private boolean fromGame() { return gameOrigin != null; }

        @JavascriptInterface public String info() {
            try {
                JSONObject value = new JSONObject()
                    .put("version", BRIDGE_VERSION)
                    .put("app", BuildConfig.VERSION_NAME)
                    .put("gameId", game == null ? JSONObject.NULL : game.optString("id"))
                    .put("lights", new JSONArray(Cabin.LIGHTS))
                    .put("climates", new JSONArray(Cabin.CLIMATES))
                    .put("airs", new JSONArray(Cabin.AIRS));
                return value.toString();
            } catch (Exception e) { return "{}"; }
        }

        /** {"light":"RED","climate":"COLD","air":"GUST"}. 빠진 값은 NORMAL. 주차 중이 아니면 적용하지 않고 false. */
        @JavascriptInterface public boolean setCabin(String json) {
            if (!fromGame()) return false;
            String light, climate, air;
            try {
                JSONObject value = new JSONObject(json);
                light = value.optString("light", "NORMAL");
                climate = value.optString("climate", "NORMAL");
                air = value.optString("air", "NORMAL");
            } catch (Exception e) { Log.w(TAG, "bad cabin"); return false; }
            if (!Cabin.LIGHTS.contains(light) || !Cabin.CLIMATES.contains(climate) || !Cabin.AIRS.contains(air)) return false;
            if (!allowed() || cabin == null) return false;
            final Cabin target = cabin;
            car.post(() -> target.apply(light, climate, air));
            return true;
        }

        /** 게임을 닫고 목록으로 돌아간다. */
        @JavascriptInterface public void exit() { if (fromGame()) main.post(HubActivity.this::closeGame); }
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        debug = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        extras = getIntent().getExtras();
        loadGames();
        carThread.start();
        car = new Handler(carThread.getLooper());

        web = new WebView(this);
        web.setLayerType(View.LAYER_TYPE_SOFTWARE, null); // 에뮬레이터 GPU에서 WebView가 그려지지 않는다
        web.setBackgroundColor(BG);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.addJavascriptInterface(new Bridge(), "ZRideCar");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return gameOrigin == null || !request.getUrl().toString().startsWith(gameOrigin + "/"); // 게임 서버 밖으로 나가지 않는다
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (game == null) return;
                Log.i(TAG, (pageFailed ? "page failed " : "page loaded ") + game.optString("id"));
                offline.setVisibility(pageFailed ? View.VISIBLE : View.GONE);
                if (pageFailed) { main.removeCallbacks(reload); main.postDelayed(reload, 5000); }
                signal(true);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                Log.w(TAG, "page error " + error.getErrorCode() + " " + error.getDescription());
                if (request.isForMainFrame()) pageFailed = true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) { Log.i(TAG, "js: " + m.message()); return true; }
        });

        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        list = listView();
        offline = offlineView();
        web.setVisibility(View.GONE);
        root.addView(list);
        root.addView(web);
        root.addView(offline);
        setContentView(root);

        vehicle = new Vehicle(getApplicationContext());
        vehicle.initialize();
        gate = new DrivingGate(this, this);
        gate.start();

        String direct = debug && extras != null ? extras.getString("game") : null;
        if (direct != null) for (JSONObject g : games) if (direct.equals(g.optString("id"))) openGame(g);
    }

    /** assets/games.json. 디버그 빌드는 --es url.<id> <주소>로 게임 주소를 바꿀 수 있다. */
    private void loadGames() {
        try (InputStream in = getAssets().open("games.json")) {
            JSONArray array = new JSONArray(new String(in.readAllBytes(), StandardCharsets.UTF_8));
            for (int i = 0; i < array.length(); i++) {
                JSONObject g = array.getJSONObject(i);
                String override = debug && extras != null ? extras.getString("url." + g.optString("id")) : null;
                if (override != null) g.put("url", override);
                games.add(g);
            }
        } catch (Exception e) { Log.w(TAG, "games.json: " + e); }
    }

    private View listView() {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(48, 40, 48, 40);
        TextView title = text("PLY 게임", 34, Color.WHITE);
        column.addView(title);
        column.addView(text("차에 탄 가족이 폰으로 같이 해요. 실내 조명·공조는 P단에서만 바뀌어요.", 18, MUTED), margins(0, 8, 0, 28));
        for (JSONObject g : games) {
            boolean ready = !g.isNull("url") && !g.optString("url").isEmpty();
            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setPadding(32, 24, 32, 24);
            GradientDrawable shape = new GradientDrawable();
            shape.setColor(CARD); shape.setCornerRadius(24);
            card.setBackground(shape);
            card.addView(text(g.optString("title"), 26, ready ? Color.WHITE : MUTED));
            card.addView(text(sceneName(g.optString("scene")) + " · " + g.optString("players") + " · " + g.optString("summary"), 17, ready ? VOLT : MUTED));
            card.setAlpha(ready ? 1f : 0.55f);
            if (ready) { card.setClickable(true); card.setOnClickListener(v -> openGame(g)); }
            column.addView(card, margins(0, 0, 0, 18));
        }
        ScrollView scroll = new ScrollView(this);
        scroll.addView(column);
        return scroll;
    }

    private static String sceneName(String scene) {
        switch (scene) {
            case "CHARGING": return "충전 중";
            case "PARKED": return "주차 중";
            case "DRIVING": return "이동 중(폰)";
            default: return scene;
        }
    }

    private TextView text(String value, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(value); t.setTextSize(sp); t.setTextColor(color);
        return t;
    }
    private static LinearLayout.LayoutParams margins(int l, int t, int r, int b) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p.setMargins(l, t, r, b);
        return p;
    }

    /** 게임 서버에 못 붙었을 때. 빈 화면이나 브라우저 오류 대신 무엇을 하면 되는지 보여 준다. */
    private View offlineView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(BG);
        box.setVisibility(View.GONE);
        box.setClickable(true);
        TextView title = text("게임 서버에 연결할 수 없어요", 30, Color.WHITE);
        title.setGravity(Gravity.CENTER);
        TextView hint = text("서버가 켜져 있는지 확인해 주세요. 5초마다 다시 연결해요.", 18, MUTED);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, 16, 0, 32);
        Button retry = new Button(this);
        retry.setText("지금 다시 연결");
        retry.setTextSize(20);
        retry.setOnClickListener(v -> { main.removeCallbacks(reload); pageFailed = true; reload.run(); });
        Button back = new Button(this);
        back.setText("게임 목록으로");
        back.setTextSize(20);
        back.setOnClickListener(v -> closeGame());
        box.addView(title);
        box.addView(hint);
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER);
        row.addView(retry);
        row.addView(back);
        box.addView(row);
        return box;
    }

    private void openGame(JSONObject g) {
        String url = g.optString("url");
        Uri uri = Uri.parse(url);
        game = g;
        gameOrigin = uri.getScheme() + "://" + uri.getAuthority();
        lastSignal = "";
        pageFailed = false;
        Log.i(TAG, "open " + g.optString("id"));
        list.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(url);
    }

    /** 게임을 닫으면 실내를 먼저 되돌린다. */
    private void closeGame() {
        if (game == null) return;
        Log.i(TAG, "close " + game.optString("id"));
        if (cabin != null) car.post(cabin::restore);
        game = null; gameOrigin = null;
        main.removeCallbacks(reload);
        web.loadUrl("about:blank");
        web.setVisibility(View.GONE);
        offline.setVisibility(View.GONE);
        list.setVisibility(View.VISIBLE);
    }

    @Override public void onBackPressed() { if (game != null) closeGame(); else super.onBackPressed(); }

    private void startBattery() {
        try {
            Log.i(TAG, "reading battery");
            battery = vehicle.getEvBattery();
            if (cabin == null) cabin = new Cabin(vehicle, car, getSharedPreferences("cabin", MODE_PRIVATE));
            cabin.remember();
            battery.getEvBatteryStateOfCharge(value -> { setSoc(value); return Unit.INSTANCE; }, error -> { Log.w(TAG, "soc: " + error); return Unit.INSTANCE; });
            if (socListener == null) {
                socListener = new EvBatteryStateOfChargeListener() {
                    @Override public void onEvBatteryStateOfChargeUpdated(Integer value) { setSoc(value); }
                    @Override public void onFailed(Exception error) { Log.w(TAG, "soc listener: " + error); }
                };
                battery.registerEvBatteryStateOfCharge(socListener);
            }
        } catch (Exception e) {
            Log.w(TAG, "vehicle not ready: " + e);
        } finally { starting = false; }
    }

    private void setSoc(Integer value) { main.post(() -> { soc = value; signal(true); }); }
    private boolean allowed() { return foreground && gate != null && gate.parkedAndAllowed(); }

    @Override public void onDriving(String ux, String gear) {
        Log.i(TAG, "gate ux=" + ux + " gear=" + gear);
        restoreCabin();
        signal(true);
    }

    private void restoreCabin() { if (!allowed() && cabin != null) car.post(cabin::restore); }

    /** 차 신호를 페이지로 보낸다. 바뀐 게 없으면 force일 때만 다시 보낸다. */
    private void signal(boolean force) {
        if (web == null || game == null) return;
        try {
            Float speed = gate == null ? null : gate.speedKmh();
            JSONObject value = new JSONObject()
                .put("v", BRIDGE_VERSION)
                .put("soc", soc == null ? JSONObject.NULL : soc)
                .put("gear", gate == null ? "UNKNOWN" : gate.gear())
                .put("ux", gate == null ? "UNKNOWN" : gate.ux())
                .put("speedKmh", speed == null ? JSONObject.NULL : Math.round(speed * 10) / 10.0)
                .put("visible", foreground)
                .put("parked", allowed());
            String json = value.toString();
            if (!force && json.equals(lastSignal)) return;
            lastSignal = json;
            web.evaluateJavascript("window.__zrideCar&&window.__zrideCar(" + json + ")", null);
        } catch (Exception e) { Log.w(TAG, "signal: " + e); }
    }

    // Pleos는 분할 화면이라 지도에 포커스가 가면 onPause가 오지만 게임은 계속 보인다. 보이는 동안을 기준으로 한다.
    @Override protected void onStart() { super.onStart(); foreground = true; if (gate != null) gate.recheck(); main.post(heartbeat); }
    @Override protected void onStop() { foreground = false; restoreCabin(); main.removeCallbacks(heartbeat); signal(true); super.onStop(); }
    @Override protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        foreground = false; restoreCabin();
        carThread.quitSafely();
        if (battery != null && socListener != null) try { battery.unregisterEvBatteryStateOfCharge(socListener); } catch (Exception ignored) {}
        if (gate != null) gate.close();
        if (vehicle != null) try { vehicle.release(); } catch (Exception ignored) {}
        if (web != null) web.destroy();
        super.onDestroy();
    }
}

package ai.zride.demo.car;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
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
import android.widget.FrameLayout;
import android.widget.TextView;
import ai.pleos.playground.vehicle.Vehicle;
import ai.pleos.playground.vehicle.api.EvBattery;
import ai.pleos.playground.vehicle.listener.EvBatteryStateOfChargeListener;
import kotlin.Unit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 충전 웹 게임(Power Castle·Volt Rush·Power Tug) 큰 화면. 게임은 Cloudflare에 따로 배포돼 있고(games/cloudflare),
 * 여기서는 그 주소를 WebView로 띄워 차 신호를 보내고 실내등·송풍 요청을 받는다(games/sdk/zride-car.js 브리지 v1).
 * 주차가 풀리거나 화면을 닫으면 실내 설정을 원래대로 돌린다.
 */
public final class ChargeGameActivity extends Activity implements ChargeDrivingGate.Listener {
    static final String EXTRA_ID = "chargeGame", EXTRA_URL = "chargeGameUrl", EXTRA_SUPPLIES = "chargeSupplies";

    /** PLY 파티로 연 게임이면 MainActivity가 넣어 준다. 보급품 사용과 닫기를 PLY 서버에 알린다. */
    static final class PartyLink {
        final ai.zride.demo.common.RoomClient client;
        final String roomId, game;
        PartyLink(ai.zride.demo.common.RoomClient client, String roomId, String game) { this.client = client; this.roomId = roomId; this.game = game; }
        String path() { return "/api/rooms/" + roomId + "/charge-game"; }
    }
    static volatile PartyLink party;
    private static final String TAG = "ZRideCharge";
    private static final int BRIDGE_VERSION = 1;
    // Cloudflare workers.dev 주소. 게임마다 zride-<게임>이라는 Worker로 올라가 있다
    private static final String WORKERS_SUBDOMAIN = "zride-charge-games-cloudflare";
    private static final int BG = Color.rgb(12, 10, 28);

    /** 게임 주소. 디버그 빌드는 --es url.<게임> <주소>로 바꿀 수 있다(로컬 시험용). */
    static String urlFor(String id) { return "https://zride-" + id + "." + WORKERS_SUBDOMAIN + ".workers.dev/"; }

    private final Handler main = new Handler(Looper.getMainLooper());
    // SDK 호출은 서비스가 붙을 때까지 멈출 수 있어서 화면 스레드에서 부르지 않는다
    private final HandlerThread carThread = new HandlerThread("charge-car");
    private Handler car;
    private volatile boolean starting;
    private WebView web;
    private TextView offline;
    private ChargeDrivingGate gate;
    private Vehicle vehicle;
    private EvBattery battery;
    private EvBatteryStateOfChargeListener socListener;
    private volatile ChargeCabin cabin;
    private Integer soc;
    private Integer supplies; // PLY 파티 보급품. 파티로 연 게임이 아니면 null
    private PartyLink link;
    private boolean foreground, pageFailed;
    private String gameId, url;
    private volatile String gameOrigin; // 브리지는 이 출처의 페이지에만 답한다
    private String lastSignal = "";
    private final Runnable reload = () -> { if (pageFailed) { pageFailed = false; web.loadUrl(url); } };
    // 차량 서비스는 비동기로 붙는다. 배터리가 읽힐 때까지 다시 시도하고, 1초마다 페이지에 신호를 보낸다
    private final Runnable heartbeat = new Runnable() {
        public void run() {
            if (soc == null && !starting) { starting = true; car.post(ChargeGameActivity.this::startBattery); }
            else if (cabin != null) car.post(cabin::refresh);
            signal(false);
            main.postDelayed(this, 1000);
        }
    };

    /** 게임 페이지가 부르는 창구(브리지 v1). 자바스크립트 스레드에서 불린다. */
    private final class Bridge {
        @JavascriptInterface public String info() {
            try {
                return new JSONObject()
                    .put("version", BRIDGE_VERSION)
                    .put("app", "ply-carapp")
                    .put("gameId", gameId)
                    .put("lights", new JSONArray(ChargeCabin.LIGHTS))
                    .put("climates", new JSONArray(ChargeCabin.CLIMATES))
                    .put("airs", new JSONArray(ChargeCabin.AIRS)).toString();
            } catch (Exception e) { return "{}"; }
        }

        /** {"light":"RED","air":"GUST"}. 빠진 값은 NORMAL. 주차 중이 아니면 적용하지 않고 false. */
        @JavascriptInterface public boolean setCabin(String json) {
            String light, climate, air;
            try {
                JSONObject value = new JSONObject(json);
                light = value.optString("light", "NORMAL");
                climate = value.optString("climate", "NORMAL");
                air = value.optString("air", "NORMAL");
            } catch (Exception e) { Log.w(TAG, "bad cabin"); return false; }
            if (!ChargeCabin.LIGHTS.contains(light) || !ChargeCabin.CLIMATES.contains(climate) || !ChargeCabin.AIRS.contains(air)) return false;
            if (!allowed() || cabin == null) return false;
            final ChargeCabin target = cabin;
            car.post(() -> target.apply(light, climate, air));
            return true;
        }

        /**
         * PLY 파티 보급품을 하나 쓴다. PLY 서버에서 차감되면 페이지에 {ok:true, supplies}를 돌려준다.
         * 결과는 window.__zrideSupply로 간다(games/sdk/zride-car.js의 useSupply).
         */
        @JavascriptInterface public void useSupply(String game) {
            final PartyLink target = link;
            if (target == null || !target.game.equals(game)) { supplyResult(false, null, "NO_PARTY"); return; }
            if (!allowed()) { supplyResult(false, null, "NOT_PARKED"); return; }
            org.json.JSONObject body = new org.json.JSONObject();
            try { body.put("action", "item").put("game", game); } catch (Exception e) { supplyResult(false, null, "ERROR"); return; }
            target.client.postApi(target.path(), body, new ai.zride.demo.common.RoomClient.ApiCallback() {
                public void onResponse(JSONObject value) { main.post(() -> { supplies = value.optInt("supplies", 0); supplyResult(true, supplies, null); signal(true); }); }
                public void onError(String error) {
                    String code = error.contains("SUPPLY_REQUIRED") ? "SUPPLY_REQUIRED" : error.contains("CHARGING_STOP_REQUIRED") ? "NOT_AT_STOP"
                            : error.contains("NO_CHARGE_GAME") ? "NO_PARTY" : "ERROR";
                    main.post(() -> supplyResult(false, null, code));
                }
            });
        }

        /** 게임을 닫고 PLY 화면으로 돌아간다. */
        @JavascriptInterface public void exit() { main.post(ChargeGameActivity.this::finish); }
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        gameId = getIntent().getStringExtra(EXTRA_ID);
        url = getIntent().getStringExtra(EXTRA_URL);
        boolean debug = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        String override = debug && gameId != null ? getIntent().getStringExtra("url." + gameId) : null;
        if (override != null) url = override;
        // 디버그 시험용: --ez fresh true면 저장된 방을 지우고 새 방으로 연다
        if (debug && getIntent().getBooleanExtra("fresh", false)) android.webkit.WebStorage.getInstance().deleteAllData();
        if (gameId == null || url == null) { finish(); return; }
        // 파티로 연 게임이면 MainActivity가 넣어 둔 연결을 이 화면이 맡는다
        PartyLink handed = party;
        party = null;
        if (handed != null && handed.game.equals(gameId)) { link = handed; supplies = getIntent().getIntExtra(EXTRA_SUPPLIES, 0); }
        Uri uri = Uri.parse(url);
        gameOrigin = uri.getScheme() + "://" + uri.getAuthority();
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
                return !request.getUrl().toString().startsWith(gameOrigin + "/"); // 게임 주소 밖으로 나가지 않는다
            }
            @Override public void onPageFinished(WebView view, String loaded) {
                Log.i(TAG, (pageFailed ? "page failed " : "page loaded ") + gameId);
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

        offline = new TextView(this);
        offline.setText("게임 서버에 연결하는 중이에요.\n인터넷 연결을 확인해 주세요. 5초 뒤 다시 시도해요.");
        offline.setTextColor(Color.rgb(239, 234, 255));
        offline.setTextSize(20);
        offline.setGravity(Gravity.CENTER);
        offline.setBackgroundColor(BG);
        offline.setVisibility(View.GONE);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        root.addView(web);
        root.addView(offline);
        setContentView(root);

        vehicle = new Vehicle(getApplicationContext());
        vehicle.initialize();
        gate = new ChargeDrivingGate(this, this);
        gate.start();
        Log.i(TAG, "open " + gameId);
        web.loadUrl(url);
    }

    private void supplyResult(boolean ok, Integer left, String error) {
        main.post(() -> {
            if (web == null) return;
            try {
                JSONObject value = new JSONObject().put("ok", ok);
                if (left != null) value.put("supplies", left);
                if (error != null) value.put("error", error);
                web.evaluateJavascript("window.__zrideSupply&&window.__zrideSupply(" + value + ")", null);
            } catch (Exception e) { Log.w(TAG, "supply: " + e); }
        });
    }

    private void startBattery() {
        try {
            battery = vehicle.getEvBattery();
            if (cabin == null) cabin = new ChargeCabin(vehicle, car, getSharedPreferences("charge-cabin", MODE_PRIVATE));
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
        if (web == null) return;
        try {
            Float speed = gate == null ? null : gate.speedKmh();
            String json = new JSONObject()
                .put("v", BRIDGE_VERSION)
                .put("soc", soc == null ? JSONObject.NULL : soc)
                .put("gear", gate == null ? "UNKNOWN" : gate.gear())
                .put("ux", gate == null ? "UNKNOWN" : gate.ux())
                .put("speedKmh", speed == null ? JSONObject.NULL : Math.round(speed * 10) / 10.0)
                .put("visible", foreground)
                .put("parked", allowed())
                .put("supplies", supplies == null ? JSONObject.NULL : supplies).toString();
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
        foreground = false;
        if (cabin != null) car.post(cabin::restore); // 화면을 닫으면 주차 여부와 관계없이 원래대로
        if (link != null) {
            // 크루 폰의 입장 링크를 내린다
            try { link.client.postApi(link.path(), new JSONObject().put("action", "close"), new ai.zride.demo.common.RoomClient.ApiCallback() {
                public void onResponse(JSONObject value) {}
                public void onError(String error) { Log.w(TAG, "close: " + error); }
            }); } catch (Exception ignored) {}
        }
        carThread.quitSafely();
        if (battery != null && socListener != null) try { battery.unregisterEvBatteryStateOfCharge(socListener); } catch (Exception ignored) {}
        if (gate != null) gate.close();
        if (vehicle != null) try { vehicle.release(); } catch (Exception ignored) {}
        if (web != null) web.destroy();
        super.onDestroy();
    }
}

package ai.zride.thief;

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
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import ai.pleos.playground.vehicle.Vehicle;
import ai.pleos.playground.vehicle.api.EvBattery;
import ai.pleos.playground.vehicle.listener.EvBatteryStateOfChargeListener;
import kotlin.Unit;
import org.json.JSONObject;

/**
 * 전기 도둑의 Pleos 앱. 큰 화면은 게임 서버의 웹 페이지를 그대로 쓰고,
 * 이 앱은 실제 배터리·주차 상태를 넣어 주고 게임의 cabin 값을 차에 적용한다.
 */
public final class GameActivity extends Activity implements DrivingGate.Listener {
    private static final String TAG = "ZRideThief";
    private static final String DEFAULT_SERVER = "http://10.0.2.2:8210/";
    private static final int ALERT_COLOR = 0xFF2020; // 무드등 색은 RGB 값이다
    private final Handler main = new Handler(Looper.getMainLooper());
    // SDK 호출은 서비스가 붙을 때까지 멈출 수 있어서 화면 스레드에서 부르지 않는다
    private final HandlerThread carThread = new HandlerThread("car");
    private Handler car;
    private volatile boolean starting;
    private WebView web;
    private View offline;
    private String server;
    private boolean pageFailed;
    // 서버가 안 열려 있으면 안내 화면을 띄우고 5초마다 다시 붙어 본다
    private final Runnable reload = () -> { if (pageFailed && web != null) { pageFailed = false; web.loadUrl(server); } };
    private DrivingGate gate;
    private Vehicle vehicle;
    private EvBattery battery;
    private EvBatteryStateOfChargeListener socListener;
    private Cabin cabin;
    private String origin;
    private Integer soc;
    private boolean foreground;
    // 차량 서비스 연결은 비동기라, 배터리가 읽힐 때까지 2초마다 다시 시도한다
    private final Runnable heartbeat = new Runnable() { public void run() { if (soc == null && !starting) { starting = true; car.post(GameActivity.this::startBattery); } else if (cabin != null) car.post(cabin::refresh); signal(); main.postDelayed(this, 2000); } };

    /** 페이지가 부르는 유일한 창구. 게임 서버 페이지에만 노출한다. */
    private final class Bridge {
        @JavascriptInterface public void applyCabin(String json) {
            main.post(() -> {
                try {
                    JSONObject value = new JSONObject(json);
                    if (cabin != null && allowed()) car.post(() -> cabin.apply(value.optString("light", "NORMAL"), value.optString("climate", "NORMAL")));
                } catch (Exception e) { Log.w(TAG, "bad cabin"); }
            });
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        boolean debug = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        String extra = debug ? getIntent().getStringExtra("serverUrl") : null;
        server = extra != null ? extra : DEFAULT_SERVER;
        Uri uri = Uri.parse(server);
        origin = uri.getScheme() + "://" + uri.getAuthority();
        carThread.start();
        car = new Handler(carThread.getLooper());
        web = new WebView(this);
        web.setLayerType(View.LAYER_TYPE_SOFTWARE, null); // 에뮬레이터 GPU에서 WebView가 그려지지 않는다
        web.setBackgroundColor(Color.rgb(16, 21, 31));
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.addJavascriptInterface(new Bridge(), "PleosCar");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !request.getUrl().toString().startsWith(origin + "/"); // 게임 서버 밖으로 나가지 않는다
            }
            @Override public void onPageFinished(WebView view, String url) {
                Log.i(TAG, pageFailed ? "page failed" : "page loaded");
                offline.setVisibility(pageFailed ? View.VISIBLE : View.GONE);
                if (pageFailed) { main.removeCallbacks(reload); main.postDelayed(reload, 5000); }
                signal();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                Log.w(TAG, "page error " + error.getErrorCode() + " " + error.getDescription());
                if (request.isForMainFrame()) pageFailed = true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) { Log.i(TAG, "js: " + m.message()); return true; }
        });
        offline = offlineView();
        FrameLayout root = new FrameLayout(this);
        root.addView(web);
        root.addView(offline);
        setContentView(root);
        web.loadUrl(server);
        vehicle = new Vehicle(getApplicationContext());
        vehicle.initialize();
        gate = new DrivingGate(this, this);
        gate.start();
    }

    /** 게임 서버에 못 붙었을 때. 빈 화면이나 브라우저 오류 대신 무엇을 하면 되는지 보여 준다. */
    private View offlineView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.rgb(16, 21, 31));
        box.setVisibility(View.GONE);
        box.setClickable(true);
        TextView title = new TextView(this);
        title.setText("게임 서버에 연결할 수 없어요");
        title.setTextColor(Color.WHITE);
        title.setTextSize(30);
        title.setGravity(Gravity.CENTER);
        TextView hint = new TextView(this);
        hint.setText("서버가 켜져 있는지 확인해 주세요. 5초마다 다시 연결해요.");
        hint.setTextColor(Color.rgb(160, 170, 185));
        hint.setTextSize(18);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, 16, 0, 32);
        Button retry = new Button(this);
        retry.setText("지금 다시 연결");
        retry.setTextSize(20);
        retry.setOnClickListener(v -> { main.removeCallbacks(reload); pageFailed = true; reload.run(); });
        box.addView(title);
        box.addView(hint);
        box.addView(retry, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        return box;
    }

    private void startBattery() {
        try {
            Log.i(TAG, "reading battery");
            battery = vehicle.getEvBattery();
            if (cabin == null) cabin = new Cabin(vehicle, ALERT_COLOR, car, getSharedPreferences("cabin", MODE_PRIVATE));
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

    private void setSoc(Integer value) { main.post(() -> { soc = value; Log.i(TAG, "soc " + value); signal(); }); }
    private boolean allowed() { return foreground && gate != null && gate.parkedAndAllowed(); }

    @Override public void onDriving(String ux, String gear) {
        Log.i(TAG, "gate ux=" + ux + " gear=" + gear);
        restoreCabin();
        signal();
    }

    private void restoreCabin() { if (!allowed() && cabin != null) car.post(cabin::restore); }

    private void signal() {
        if (web == null) return;
        String value = soc == null ? "null" : String.valueOf(soc);
        web.evaluateJavascript("window.onCarSignal&&window.onCarSignal({soc:" + value + ",parked:" + allowed() + "})", null);
    }

    // Pleos는 분할 화면이라 지도에 포커스가 가면 onPause가 오지만 게임은 계속 보인다. 보이는 동안을 기준으로 한다.
    @Override protected void onStart() { super.onStart(); foreground = true; if (gate != null) gate.recheck(); main.post(heartbeat); }
    @Override protected void onStop() { foreground = false; restoreCabin(); main.removeCallbacks(heartbeat); signal(); super.onStop(); }
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

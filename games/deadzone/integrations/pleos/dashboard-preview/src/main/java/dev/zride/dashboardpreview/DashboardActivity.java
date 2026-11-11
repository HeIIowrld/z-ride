package dev.zride.dashboardpreview;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.net.Uri;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.*;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;

/** Dedicated emulator preview; no Vehicle SDK or physical vehicle controls. */
public final class DashboardActivity extends Activity {
    private WebView web;
    private TextView status;
    private Uri origin;
    private static final String TAG = "ZRideDashboardPreview";
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN |
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        LinearLayout layout = new LinearLayout(this);layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.rgb(18,34,30));
        status = new TextView(this);status.setTextColor(Color.rgb(214,239,160));status.setTextSize(11);
        status.setPadding(18,7,18,7);status.setText("Z-RIDE  /  PLEOS WEBVIEW PREVIEW  ·  연결 중  ·  차량 SDK 미연결");
        layout.addView(status,new LinearLayout.LayoutParams(-1,-2));
        web = new WebView(this);layout.addView(web,new LinearLayout.LayoutParams(-1,0,1));setContentView(layout);
        String url = getIntent().getStringExtra("dashboard_url");
        if(url==null) url="http://10.0.2.2:8788/dashboard";
        origin=Uri.parse(url);
        if (!allowed(origin)) { status.setText("허용되지 않은 대시보드 주소입니다."); return; }
        WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setLoadWithOverviewMode(true);settings.setUseWideViewPort(true);
        web.setBackgroundColor(Color.rgb(236,238,229));
        web.addJavascriptInterface(new SnapshotBridge(),"ZRideDashboardBridge");
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest req){
                Uri u=req.getUrl();return !allowed(u)||!origin.getHost().equals(u.getHost()) || u.getPort()!=origin.getPort() || !u.getPath().startsWith("/dashboard");
            }
            @Override public void onPageFinished(WebView view,String url){
                Log.i(TAG,"PAGE_READY "+Uri.parse(url).getPath());
                status.setText("Z-RIDE  /  PLEOS WEBVIEW PREVIEW  ·  웹 연결됨  ·  차량 SDK 미연결");
            }
            @Override public void onReceivedError(WebView v,WebResourceRequest req,WebResourceError error){
                if(req.isForMainFrame())status.setText("대시보드 연결 실패: "+error.getDescription());
                Log.e(TAG,"WEB_ERROR "+error.getErrorCode()+" "+error.getDescription());
            }
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public boolean onConsoleMessage(ConsoleMessage msg){
                Log.i(TAG,"WEB_CONSOLE "+msg.messageLevel()+" "+msg.message());return true;
            }
        });
        web.loadUrl(url);
    }
    private boolean allowed(Uri u){
        if(u.getHost()==null)return false;
        if("https".equals(u.getScheme()))return false; // Local preview only; production belongs to the host app.
        String h=u.getHost();
        return BuildConfig.DEBUG && "http".equals(u.getScheme()) &&
            (h.equals("10.0.2.2")||h.equals("127.0.0.1")||h.equals("localhost"));
    }
    private final class SnapshotBridge {
        @JavascriptInterface public void onSnapshot(String json){
            if(json==null||json.length()>262144)return;
            try {
                JSONObject s=new JSONObject(json);
                if(!"zride.dashboard.v1".equals(s.optString("schema")))return;
                String message="Z-RIDE  /  PLEOS WEBVIEW PREVIEW  ·  LIVE "+s.optString("roomCode")+
                    "  ·  "+s.optInt("connectedPlayers")+"/"+s.optInt("targetPlayers")+"인  ·  WAVE "+s.optInt("wave")+"  ·  차량 SDK 미연결";
                Log.i(TAG,"SNAPSHOT room="+s.optString("roomCode")+" wave="+s.optInt("wave")+" players="+s.optInt("connectedPlayers"));
                runOnUiThread(()->status.setText(message));
            }catch(Exception e){Log.e(TAG,"SNAPSHOT_INVALID");}
        }
    }
    @Override protected void onDestroy(){if(web!=null){web.removeJavascriptInterface("ZRideDashboardBridge");web.stopLoading();web.destroy();}super.onDestroy();}
}

package ai.zride.car;

import android.os.Handler;
import android.os.Looper;
import org.json.JSONObject;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.*;

/**
 * CAR_HOST 연결. 세션 토큰은 메모리에만 두고 URL·로그·파일에 남기지 않는다.
 * WebSocket이 끊기면 같은 방으로 다시 인증한다(방을 새로 만들지 않음).
 * 모든 콜백은 메인 스레드에서 부른다.
 */
final class HostConnection {
    interface Listener {
        void onLink(String state);          // CONNECTING · LIVE · RETRYING · CLOSED
        void onRoom(JSONObject room);
        void onServerError(String code);
    }
    interface Done { void ok(JSONObject data); void fail(String code); }

    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private final OkHttpClient http = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS)
        .pingInterval(10, TimeUnit.SECONDS).build();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, Done> waiting = new HashMap<>();
    private final Listener listener;
    private String base, token, roomId;
    private WebSocket socket;
    private boolean live, closed;
    private long generation, reportSeq;
    private int retry;

    HostConnection(Listener listener) { this.listener = listener; }

    String roomId() { return roomId; }
    boolean isLive() { return live; }

    /** 세션 → 방 만들기 → 실시간 연결. */
    void open(String origin, String nickname, String accessKey, Done done) {
        closed = false;
        base = origin.trim().replaceAll("/+$", "");
        HttpUrl parsed = HttpUrl.parse(base);
        if (parsed == null || !(parsed.scheme().equals("http") || parsed.scheme().equals("https"))) { done.fail("INVALID_SERVER_URL"); return; }
        JSONObject body = new JSONObject();
        try { body.put("role", "CAR_HOST").put("nickname", nickname); if (accessKey != null && !accessKey.isEmpty()) body.put("accessKey", accessKey); } catch (Exception ignored) {}
        call("/api/session", body, false, new Done() {
            public void ok(JSONObject session) {
                token = session.optString("token", null);
                call("/api/rooms", new JSONObject(), true, new Done() {
                    public void ok(JSONObject joined) {
                        roomId = joined.optString("roomId", null);
                        JSONObject room = joined.optJSONObject("room");
                        if (room != null) listener.onRoom(room);
                        connect();
                        done.ok(joined);
                    }
                    public void fail(String code) { token = null; done.fail(code); }
                });
            }
            public void fail(String code) { done.fail(code); }
        });
    }

    /** 공개 설정: 테스트 접근키가 필요한지 확인한다. */
    void config(String origin, Done done) {
        String url = origin.trim().replaceAll("/+$", "") + "/api/client-config";
        if (HttpUrl.parse(url) == null) { done.fail("INVALID_SERVER_URL"); return; }
        io.execute(() -> {
            try (Response r = http.newCall(new Request.Builder().url(url).get().build()).execute()) {
                JSONObject data = new JSONObject(r.body() == null ? "{}" : r.body().string());
                main.post(() -> { if (r.isSuccessful()) done.ok(data); else done.fail("HTTP_" + r.code()); });
            } catch (Exception e) { main.post(() -> done.fail("NETWORK")); }
        });
    }

    void api(String path, JSONObject body, Done done) {
        if (token == null) { done.fail("NOT_CONNECTED"); return; }
        call(path, body, true, done);
    }

    private void call(String path, JSONObject body, boolean auth, Done done) {
        io.execute(() -> {
            Request.Builder request = new Request.Builder().url(base + path).post(RequestBody.create(body.toString(), JSON));
            if (auth && token != null) request.header("Authorization", "Bearer " + token);
            try (Response r = http.newCall(request.build()).execute()) {
                String text = r.body() == null ? "{}" : r.body().string();
                JSONObject data = text.isEmpty() ? new JSONObject() : new JSONObject(text);
                if (r.isSuccessful()) main.post(() -> done.ok(data));
                else {
                    JSONObject error = data.optJSONObject("error");
                    String code = error != null ? error.optString("code", "HTTP_" + r.code()) : "HTTP_" + r.code();
                    main.post(() -> done.fail(code));
                }
            } catch (Exception e) { main.post(() -> done.fail("NETWORK")); }
        });
    }

    private void connect() {
        if (closed || token == null || roomId == null) return;
        final long my = ++generation;
        live = false; reportSeq = 0;
        listener.onLink(retry == 0 ? "CONNECTING" : "RETRYING");
        String wsUrl = base.replaceFirst("^http", "ws") + "/ws";
        socket = http.newWebSocket(new Request.Builder().url(wsUrl).build(), new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response response) {
                try { ws.send(new JSONObject().put("type", "auth").put("token", token).put("roomId", roomId).toString()); } catch (Exception ignored) {}
            }
            @Override public void onMessage(WebSocket ws, String text) {
                main.post(() -> { if (my == generation) handle(text); });
            }
            @Override public void onFailure(WebSocket ws, Throwable error, Response response) { main.post(() -> dropped(my, 0)); }
            @Override public void onClosing(WebSocket ws, int code, String reason) { ws.close(1000, null); }
            @Override public void onClosed(WebSocket ws, int code, String reason) { main.post(() -> dropped(my, code)); }
        });
        // 열리지도 실패하지도 않고 멈추는 연결은 8초 뒤 버리고 다시 붙는다
        main.postDelayed(() -> { if (my == generation && !live && !closed) { WebSocket stuck = socket; if (stuck != null) stuck.cancel(); } }, 8000);
    }

    private void handle(String text) {
        JSONObject m;
        try { m = new JSONObject(text); } catch (Exception e) { return; }
        switch (m.optString("type")) {
            case "auth.ok": live = true; retry = 0; listener.onLink("LIVE"); break;
            case "snapshot": { JSONObject room = m.optJSONObject("room"); if (room != null) listener.onRoom(room); break; }
            case "result": {
                Done done = waiting.remove(m.optString("commandId"));
                if (done != null) {
                    if (m.optBoolean("ok")) done.ok(m.optJSONObject("data") == null ? new JSONObject() : m.optJSONObject("data"));
                    else done.fail(errorCode(m));
                }
                break;
            }
            case "error": listener.onServerError(errorCode(m)); break;
            default: break;
        }
    }
    private static String errorCode(JSONObject m) { JSONObject e = m.optJSONObject("error"); return e == null ? "ERROR" : e.optString("code", "ERROR"); }

    private void dropped(long my, int code) {
        if (my != generation) return;
        live = false; socket = null;
        failWaiting("WS_DISCONNECTED");
        // 4401 인증 만료 · 4409 다른 연결이 이어받음 · 4410 파티 해산 · 4429 명령 한도: 다시 붙지 않는다
        if (closed || code == 4401 || code == 4409 || code == 4410 || code == 4429) { listener.onLink(code == 4409 ? "REPLACED" : "CLOSED"); return; }
        listener.onLink("RETRYING");
        long delay = Math.min(10000, 1000L << Math.min(retry++, 4)) + (long) (Math.random() * 300);
        main.postDelayed(() -> { if (my == generation) connect(); }, delay);
    }

    /** 앱이 다시 보이거나 네트워크가 돌아왔을 때 끊긴 연결을 바로 다시 시도한다. */
    void nudge() { if (!closed && token != null && !live && socket == null) { retry = 0; connect(); } }

    void command(String action, long roomEpoch, JSONObject extra, Done done) {
        try {
            String id = action + "-" + UUID.randomUUID();
            JSONObject msg = extra == null ? new JSONObject() : new JSONObject(extra.toString());
            msg.put("type", "command").put("commandId", id).put("roomEpoch", roomEpoch).put("action", action);
            if (!send(msg)) { done.fail("WS_DISCONNECTED"); return; }
            waiting.put(id, done);
            main.postDelayed(() -> { Done late = waiting.remove(id); if (late != null) late.fail("TIMEOUT"); }, 8000);
        } catch (Exception e) { done.fail("ERROR"); }
    }

    /** 실제 차량 신호를 그대로 보낸다. 서버가 2초 보고·lease로 전투 가능 여부를 판정한다. */
    void report(String ux, String gear, boolean foreground) {
        if (!live) return;
        try {
            send(new JSONObject().put("type", "vehicle.report").put("commandId", "report-" + UUID.randomUUID())
                .put("reportSeq", ++reportSeq).put("ux", ux).put("gear", gear).put("foreground", foreground)
                .put("source", "AAOS_CAR_HOST")
                .put("charge", new JSONObject().put("state", "UNKNOWN").put("portConnection", "UNKNOWN").put("source", "NONE")));
        } catch (Exception ignored) {}
    }

    private boolean send(JSONObject message) { WebSocket ws = socket; return live && ws != null && ws.send(message.toString()); }
    private void failWaiting(String code) { Map<String, Done> copy = new HashMap<>(waiting); waiting.clear(); for (Done d : copy.values()) d.fail(code); }

    /** 파티를 끝낸다(해산 뒤 또는 앱 종료). 토큰을 지운다. */
    void close() {
        closed = true; generation++; live = false; token = null; roomId = null;
        failWaiting("CLOSED");
        WebSocket ws = socket; socket = null;
        if (ws != null) ws.close(1000, "Host closed");
    }
    void destroy() { close(); io.shutdownNow(); http.dispatcher().executorService().shutdown(); http.connectionPool().evictAll(); }
}

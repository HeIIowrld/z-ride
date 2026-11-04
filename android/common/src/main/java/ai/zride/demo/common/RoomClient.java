package ai.zride.demo.common;

import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.*;

/** Demo-only server client. Tokens remain in memory and never enter URLs/logs. */
public final class RoomClient {
    public interface Listener {
        void onStatus(String status);
        void onRoom(JSONObject room);
        void onResult(JSONObject result);
        void onDisconnected();
    }
    public interface ApiCallback {void onResponse(JSONObject value);void onError(String error);default void onErrorResponse(int status,JSONObject body){onError("HTTP "+status+" "+body);}}
    private static final class ApiException extends IOException {final int status;final JSONObject body;ApiException(int status,JSONObject body,String message){super(message);this.status=status;this.body=body;}}
    private final OkHttpClient http = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS)
        .pingInterval(10, TimeUnit.SECONDS).build();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Listener listener;
    private WebSocket socket;
    private String base, token, roomId, sessionId;
    private boolean closed;
    private volatile long authenticatedGeneration=-1;
    private volatile long generation;
    public RoomClient(Listener listener) { this.listener = listener; }

    public void connect(String baseUrl, boolean car, String nickname, String joinCode, String seat, String accessKey) {
        authenticatedGeneration=-1;
        final long attempt=++generation;
        io.execute(() -> {
            try {
                if(attempt!=generation)return;
                closed = false;
                base = baseUrl.replaceAll("/+$", "");
                HttpUrl parsed = HttpUrl.parse(base);
                if (parsed == null || !(parsed.scheme().equals("http") || parsed.scheme().equals("https")))
                    throw new IOException("Invalid HTTP server URL");
                listener.onStatus("Connecting to server");
                JSONObject enrollment = new JSONObject().put("role", car ? "CAR_HOST" : "PHONE").put("nickname", nickname);
                if (accessKey != null && !accessKey.isEmpty()) enrollment.put("accessKey", accessKey);
                JSONObject session = post("/api/session", enrollment, false);
                token = session.getString("token");
                sessionId = session.getString("sessionId");
                JSONObject joined = car ? post("/api/rooms", new JSONObject(), true)
                    : post("/api/join", new JSONObject().put("joinCode", joinCode.trim()).put("seat", seat), true);
                if(attempt!=generation)return;
                roomId = joined.getString("roomId");
                if (joined.has("room")) listener.onRoom(joined.getJSONObject("room"));
                String wsUrl = base.replaceFirst("^http", "ws") + "/ws";
                socket = http.newWebSocket(new Request.Builder().url(wsUrl).build(), new WebSocketListener() {
                    @Override public void onOpen(WebSocket ws, Response response) {
                        if(attempt!=generation){ws.close(1000,"Superseded");return;}
                        try { ws.send(new JSONObject().put("type", "auth").put("token", token).put("roomId", roomId).toString()); }
                        catch (Exception e) { listener.onStatus("Auth message error: " + e.getMessage()); }
                    }
                    @Override public void onMessage(WebSocket ws, String text) {
                        if(attempt!=generation)return;
                        try {
                            JSONObject msg = new JSONObject(text);
                            if ("auth.ok".equals(msg.optString("type"))) authenticatedGeneration=attempt;
                            if ("snapshot".equals(msg.optString("type"))) {
                                listener.onRoom(msg.getJSONObject("room"));
                                listener.onStatus("Connected · room " + roomId);
                            } else listener.onResult(msg);
                        } catch (Exception e) { listener.onStatus("Invalid server message: " + e.getMessage()); }
                    }
                    @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
                        if(attempt!=generation)return;
                        authenticatedGeneration=-1;
                        listener.onStatus("Disconnected: " + error.getClass().getSimpleName());
                        listener.onDisconnected();
                    }
                    @Override public void onClosed(WebSocket ws, int code, String reason) {
                        if(attempt!=generation)return;
                        authenticatedGeneration=-1;
                        listener.onStatus("Socket closed " + code);
                        listener.onDisconnected();
                    }
                });
            } catch (Exception e) {
                if(attempt!=generation)return;
                listener.onStatus("Connection failed: " + e.getMessage());
                listener.onDisconnected();
            }
        });
    }
    private JSONObject post(String path, JSONObject body, boolean authenticated) throws Exception {
        Request.Builder request = new Request.Builder().url(base + path)
            .post(RequestBody.create(body.toString(), MediaType.get("application/json; charset=utf-8")));
        if (authenticated) request.header("Authorization", "Bearer " + token);
        try (Response result = http.newCall(request.build()).execute()) {
            String text = result.body() == null ? "{}" : result.body().string();
            JSONObject data = new JSONObject(text);
            if (!result.isSuccessful()) {
                JSONObject error = data.optJSONObject("error");
                throw new ApiException(result.code(),data,"HTTP " + result.code() + " " + (error == null ? data.optString("message") : error.optString("code")));
            }
            return data;
        }
    }
    public void approve(String memberId, String seat) {
        io.execute(() -> {
            try {
                JSONObject data = post("/api/rooms/" + roomId + "/approve", new JSONObject().put("memberId", memberId).put("seat", seat), true);
                if (data.has("room")) listener.onRoom(data.getJSONObject("room"));
            } catch (Exception e) { listener.onStatus("Approval failed: " + e.getMessage()); }
        });
    }
    public void postApi(String path,JSONObject body,ApiCallback callback){
        if(path==null||!path.startsWith("/api/")||path.contains("://")){callback.onError("Invalid API path");return;}
        io.execute(()->{try{if(token==null||base==null)throw new IOException("Connect and obtain server approval first");callback.onResponse(post(path,body,true));}catch(ApiException e){callback.onErrorResponse(e.status,e.body);}catch(Exception e){callback.onError(e.getMessage());}});
    }
    public void getPublicConfig(String origin,ApiCallback callback){
        io.execute(()->{try{
            HttpUrl parsed=HttpUrl.parse(origin.replaceAll("/+$","")+"/api/client-config");
            if(parsed==null||!(parsed.scheme().equals("http")||parsed.scheme().equals("https")))throw new IOException("Invalid HTTP server URL");
            try(Response response=http.newCall(new Request.Builder().url(parsed).get().build()).execute()){
                if(!response.isSuccessful()||response.body()==null)throw new IOException("Configuration unavailable");
                callback.onResponse(new JSONObject(response.body().string()));
            }
        }catch(Exception e){callback.onError("Configuration unavailable");}});
    }
    // The HTTP room snapshot precedes WS auth. Never queue telemetry ahead of auth.
    public boolean send(JSONObject message) { WebSocket current=socket;return authenticatedGeneration==generation && current != null && !closed && current.send(message.toString()); }
    public String getSessionId() { return sessionId; }
    public void close() {
        generation++;
        closed = true;
        authenticatedGeneration=-1;
        if (socket != null) { socket.close(1000, "Activity finished"); socket = null; }
    }
    public void destroy() { close(); io.shutdownNow(); http.dispatcher().executorService().shutdown(); http.connectionPool().evictAll(); }
}

package ai.zride.car;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.*;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.MultiFormatWriter;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * PLY 차량 화면(CAR_HOST). 파티 열기 → QR 초대 → 동승자 승인 → 주차 중 전투 시작·지원.
 * 게임 화면은 동승자 폰에만 있고, 차량은 주차(P)·UX 허용일 때만 게임 정보를 보여 준다.
 * 토큰·초대 링크는 메모리에만 둔다(저장소·로그에 남기지 않음).
 */
public final class HostActivity extends Activity implements HostConnection.Listener, DrivingGate.Listener {
    private static final int BG = Color.rgb(14, 19, 22), CARD = Color.rgb(23, 32, 38), LINE = Color.rgb(40, 53, 61);
    private static final int TEXT = Color.rgb(232, 240, 242), MUTED = Color.rgb(143, 163, 173);
    private static final int ACCENT = Color.rgb(255, 107, 61), GOOD = Color.rgb(61, 220, 151), WARN = Color.rgb(255, 196, 77), BAD = Color.rgb(255, 99, 99);
    private static final Map<String, String> SEAT = Map.of("FRONT_PASSENGER", "앞 동승석", "REAR_LEFT", "뒤 왼쪽", "REAR_RIGHT", "뒤 오른쪽", "DRIVER", "운전석");
    private static final Map<String, String> STATE = Map.of("LOBBY", "대기", "READY", "시작 가능", "PLAYING", "전투 중", "PAUSED", "일시정지", "CLEARED", "공략 완료", "PENDING", "대기");
    private static final Map<String, String> GATE = Map.of("CAR_DISCONNECTED", "차량 연결 끊김", "APP_INACTIVE", "앱 비활성", "LEASE_EXPIRED", "차량 보고 만료",
        "UX_RESTRICTED", "주행 중", "UX_UNKNOWN", "UX 확인 중", "GEAR_NOT_P", "P단 아님", "GEAR_UNKNOWN", "기어 확인 중");
    private static final Map<String, String> ERR = Map.ofEntries(
        Map.entry("TEST_ACCESS_REQUIRED", "이 서버는 테스트 접근키가 필요해요. 설정에서 접근키를 입력하세요."),
        Map.entry("PUBLIC_ORIGIN_REQUIRED", "서버에 QR 주소가 설정되지 않았어요(ZRIDE_PUBLIC_ORIGIN)."),
        Map.entry("SUPPLY_REQUIRED", "보급품이 없어요. 동승자가 이동 중에 보급품을 모아야 해요."),
        Map.entry("GATE_CLOSED", "주차(P) 상태에서만 전투를 시작할 수 있어요."),
        Map.entry("OPERATOR_REQUIRED", "승인되고 접속 중인 동승자가 1명 이상 있어야 해요."),
        Map.entry("ALREADY_PLAYING", "이미 전투 중이에요."), Map.entry("NOT_PLAYING", "전투 중이 아니에요."),
        Map.entry("SEAT_TAKEN", "그 자리는 이미 접속 중인 다른 대원이 쓰고 있어요."),
        Map.entry("INVITE_EXPIRED", "QR이 만료됐어요. 새 QR을 받아 주세요."),
        Map.entry("STALE_EPOCH", "상태가 바뀌었어요. 다시 눌러 주세요."),
        Map.entry("NETWORK", "서버에 연결할 수 없어요. 주소와 네트워크를 확인해 주세요."),
        Map.entry("INVALID_SERVER_URL", "서버 주소가 올바르지 않아요."),
        Map.entry("WS_DISCONNECTED", "실시간 연결이 끊겼어요. 다시 연결하는 중이에요."),
        Map.entry("TIMEOUT", "서버 응답이 늦어요. 다시 눌러 주세요."));

    private final Handler main = new Handler(Looper.getMainLooper());
    private HostConnection conn;
    private DrivingGate gate;
    private Chimes chimes;
    private SharedPreferences prefs;
    private boolean foreground;

    private JSONObject room, prev;
    private String inviteUrl;
    private long inviteExpiresAt;
    private boolean inviteBusy, qrHidden, wasFull, ended;
    private String lastWhy = "";
    private boolean msgIsWhy;
    private final Set<String> busyMembers = new HashSet<>();

    // 화면
    private TextView linkPill, gatePill, soundButton;
    private LinearLayout setupView, partyView;
    private View setupPane, partyPane;
    private FrameLayout coverView;
    private TextView coverText, setupError;
    private EditText serverInput, keyInput, nameInput;
    private LinearLayout keyRow, settingsBox;
    private Button openButton;
    private ImageView qrImage;
    private TextView qrTimer, qrHint, qrError, crewTitle, battleState, zombiesValue, suppliesValue, killsValue, actionMsg;
    private Button qrRefresh, qrToggle, startButton, pauseButton, supportButton, disbandButton;
    private LinearLayout crewList;

    private final Runnable ticker = new Runnable() { public void run() { tick(); main.postDelayed(this, 500); } };
    private final Runnable reporter = new Runnable() { public void run() { report(); main.postDelayed(this, 2000); } };

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("host", MODE_PRIVATE);
        chimes = new Chimes(this);
        chimes.setEnabled(prefs.getBoolean("sound", true));
        conn = new HostConnection(this);
        buildUi();
        String url = debuggable() ? getIntent().getStringExtra("serverUrl") : null;
        serverInput.setText(url != null ? url : prefs.getString("server", "http://10.0.2.2:8000"));
        checkConfig();
        gate = new DrivingGate(this, this);
        gate.start();
        render();
    }

    @Override protected void onResume() {
        super.onResume();
        foreground = true;
        if (gate != null) gate.recheck();
        conn.nudge();
        main.post(reporter); main.post(ticker);
    }
    @Override protected void onPause() {
        foreground = false;
        report();
        main.removeCallbacks(reporter); main.removeCallbacks(ticker);
        render();
        super.onPause();
    }
    @Override protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if (keyInput != null) keyInput.setText("");
        if (gate != null) gate.close();
        conn.destroy(); chimes.close();
        super.onDestroy();
    }
    @Override public void onConfigurationChanged(Configuration config) { super.onConfigurationChanged(config); }

    private boolean debuggable() { return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0; }
    private String say(String code) { String v = ERR.get(code); return v != null ? v : "처리하지 못했어요 · " + code; }

    // ── 차량 신호 ───────────────────────────────────────────
    @Override public void onDriving(String ux, String gear) {
        report();
        if (allowedHere() && room != null && !ended && inviteUrl == null && freeSeats() > 0) newInvite();
        render();
    }
    private boolean allowedHere() { return foreground && gate != null && gate.parkedAndAllowed(); }
    private void report() { if (gate != null) conn.report(gate.ux(), gate.gear(), foreground); }

    // ── 서버 ────────────────────────────────────────────────
    private void checkConfig() {
        conn.config(serverInput.getText().toString(), new HostConnection.Done() {
            public void ok(JSONObject data) { keyRow.setVisibility(data.optBoolean("sessionAccessKeyRequired", true) ? View.VISIBLE : View.GONE); }
            public void fail(String code) { keyRow.setVisibility(View.VISIBLE); }
        });
    }

    private void openParty() {
        hideKeyboard();
        setupError.setText("");
        enable(openButton, false);
        String server = serverInput.getText().toString().trim();
        String name = nameInput.getText().toString().trim();
        String key = keyInput.getText().toString();
        keyInput.setText("");
        prefs.edit().putString("server", server).apply();
        chimes.tap();
        conn.open(server, name.isEmpty() ? "우리 차" : name, key, new HostConnection.Done() {
            public void ok(JSONObject data) {
                ended = false; prev = null; inviteUrl = null; qrHidden = false; wasFull = false; lastWhy = "";
                enable(openButton, true);
                if (allowedHere()) newInvite();
                render();
            }
            public void fail(String code) {
                enable(openButton, true);
                if ("TEST_ACCESS_REQUIRED".equals(code)) { settingsBox.setVisibility(View.VISIBLE); keyRow.setVisibility(View.VISIBLE); }
                setupError.setText(say(code));
            }
        });
    }

    @Override public void onLink(String state) {
        switch (state) {
            case "LIVE": pill(linkPill, "실시간 연결됨", GOOD); report(); break;
            case "CONNECTING": pill(linkPill, "연결 중…", MUTED); break;
            case "RETRYING": pill(linkPill, "연결 끊김 · 다시 연결 중", WARN); break;
            case "REPLACED": pill(linkPill, "다른 화면이 이 파티를 이어받았어요", BAD); break;
            default: pill(linkPill, ended ? "파티 해산됨" : "연결 종료", BAD); break;
        }
    }
    @Override public void onServerError(String code) { message(say(code)); }

    @Override public void onRoom(JSONObject next) {
        if (room != null && next.optString("roomId").equals(room.optString("roomId")) && next.optLong("stateVersion") < room.optLong("stateVersion")) return;
        JSONObject before = prev;
        room = next; prev = next;
        if (before != null) {
            int phonesNow = phones(next).size(), phonesBefore = phones(before).size();
            // QR 하나는 참가 3번까지만 받으므로(재시도 포함) 누가 들어올 때마다 새 QR로 바꿔 둔다
            if (phonesNow > phonesBefore) { chimes.join(); if (3 - phonesNow > 0) newInvite(); }
            if (approvedCount(next) > approvedCount(before)) chimes.approved();
            if (supplies(next) > supplies(before)) chimes.item();
            if ("CLEARED".equals(next.optString("state")) && !"CLEARED".equals(before.optString("state"))) chimes.clear();
        }
        JSONObject party = next.optJSONObject("party");
        if (party != null && "DISBANDED".equals(party.optString("status")) && !ended) partyEnded("파티가 해산됐어요.");
        render();
    }

    // ── QR 초대 ─────────────────────────────────────────────
    private void newInvite() {
        if (inviteBusy || conn.roomId() == null || ended) return;
        inviteBusy = true;
        qrError.setText("");
        conn.api("/api/rooms/" + conn.roomId() + "/party/invite", new JSONObject(), new HostConnection.Done() {
            public void ok(JSONObject data) {
                inviteBusy = false;
                String url = data.optString("joinUrl", "");
                if (!url.startsWith("http://") && !url.startsWith("https://")) { inviteUrl = null; qrError.setText("초대 주소가 올바르지 않아요."); render(); return; }
                inviteUrl = url; inviteExpiresAt = data.optLong("expiresAt");
                drawQr(); render();
            }
            public void fail(String code) { inviteBusy = false; inviteUrl = null; qrImage.setImageDrawable(null); qrError.setText(say(code)); render(); }
        });
    }
    private void drawQr() {
        if (inviteUrl == null) { qrImage.setImageDrawable(null); return; }
        try {
            Map<EncodeHintType, Object> hints = new EnumMap<>(EncodeHintType.class);
            hints.put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.M);
            hints.put(EncodeHintType.MARGIN, 2);
            hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
            int size = dp(300);
            BitMatrix bits = new MultiFormatWriter().encode(inviteUrl, BarcodeFormat.QR_CODE, size, size, hints);
            int w = bits.getWidth(), h = bits.getHeight();
            int[] px = new int[w * h];
            for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) px[y * w + x] = bits.get(x, y) ? Color.BLACK : Color.WHITE;
            Bitmap bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            bitmap.setPixels(px, 0, w, 0, 0, w, h);
            qrImage.setImageBitmap(bitmap);
        } catch (Exception e) { qrImage.setImageDrawable(null); qrError.setText("QR을 그리지 못했어요."); }
    }
    private void tick() {
        if (inviteUrl == null || ended) { qrTimer.setText(""); return; }
        long left = Math.max(0, (inviteExpiresAt - System.currentTimeMillis() + 999) / 1000);
        qrTimer.setText(left > 0 ? left + "초 남음" : "만료됨");
        qrTimer.setTextColor(left <= 20 ? WARN : MUTED);
        // 만료되면 빈자리가 있고 주차 중일 때만 새 QR (서버 기준 120초·최대 3번)
        if (left == 0 && freeSeats() > 0 && allowedHere()) newInvite();
    }

    // ── 대원 ────────────────────────────────────────────────
    private void approve(JSONObject member) {
        String id = member.optString("memberId"), seat = member.optString("seat");
        if (!busyMembers.add(id)) return;
        // 폰이 QR을 다시 찍어 새로 들어오면, 같은 자리에 오프라인으로 남은 옛 대원이 SEAT_TAKEN을 낸다 → 그 자리를 먼저 비운다
        JSONObject ghost = null;
        for (JSONObject m : phones(room)) if (!m.optString("memberId").equals(id) && m.optBoolean("approved") && !m.optBoolean("connected") && seat.equals(m.optString("seat"))) ghost = m;
        Runnable doApprove = () -> {
            JSONObject body = new JSONObject();
            try { body.put("memberId", id).put("seat", seat).put("allowManualUnknown", true); } catch (Exception ignored) {}
            conn.api("/api/rooms/" + conn.roomId() + "/approve", body, new HostConnection.Done() {
                public void ok(JSONObject data) { busyMembers.remove(id); message(member.optString("nickname") + " 님을 " + seatName(seat) + "에 승인했어요."); JSONObject r = data.optJSONObject("room"); if (r != null) onRoom(r); }
                public void fail(String code) { busyMembers.remove(id); message(say(code)); render(); }
            });
        };
        if (ghost == null) { doApprove.run(); render(); return; }
        JSONObject body = new JSONObject();
        try { body.put("memberId", ghost.optString("memberId")); } catch (Exception ignored) {}
        conn.api("/api/rooms/" + conn.roomId() + "/party/remove", body, new HostConnection.Done() {
            public void ok(JSONObject data) { newInvite(); doApprove.run(); }
            public void fail(String code) { busyMembers.remove(id); message(say(code)); render(); }
        });
        render();
    }
    private void removeMember(JSONObject member) {
        new AlertDialog.Builder(this).setTitle("대원 내보내기").setMessage(member.optString("nickname") + " 님을 파티에서 내보낼까요?")
            .setNegativeButton("취소", null)
            .setPositiveButton("내보내기", (d, w) -> {
                JSONObject body = new JSONObject();
                try { body.put("memberId", member.optString("memberId")); } catch (Exception ignored) {}
                // 내보내면 서버가 이 방의 초대를 모두 지우므로 새 QR을 받는다
                conn.api("/api/rooms/" + conn.roomId() + "/party/remove", body, new HostConnection.Done() {
                    public void ok(JSONObject data) { message(member.optString("nickname") + " 님을 내보냈어요."); inviteUrl = null; if (allowedHere()) newInvite(); render(); }
                    public void fail(String code) { message(say(code)); }
                });
            }).show();
    }

    // ── 전투 ────────────────────────────────────────────────
    private void command(String action, String success) {
        if (room == null) return;
        conn.command(action, room.optLong("roomEpoch"), null, new HostConnection.Done() {
            public void ok(JSONObject data) { message(success); if ("support.pulse".equals(action)) chimes.support(); }
            public void fail(String code) { message(say(code)); }
        });
    }
    private void disband() {
        new AlertDialog.Builder(this).setTitle("파티 해산").setMessage("파티를 해산할까요? 모든 대원이 나가고 지금 QR은 더 이상 쓸 수 없어요.")
            .setNegativeButton("취소", null)
            .setPositiveButton("해산", (d, w) -> conn.api("/api/rooms/" + conn.roomId() + "/party/disband", new JSONObject(), new HostConnection.Done() {
                public void ok(JSONObject data) { partyEnded("파티를 해산했어요. 새 파티를 열 수 있어요."); }
                public void fail(String code) { message(say(code)); }
            })).show();
    }
    private void partyEnded(String text) {
        ended = true; inviteUrl = null; room = null; prev = null;
        qrImage.setImageDrawable(null);
        conn.close();
        pill(linkPill, "파티 해산됨", MUTED);
        setupError.setText(text);
        render();
    }

    // ── 화면 갱신 ───────────────────────────────────────────
    private void render() {
        boolean inParty = room != null && !ended;
        boolean allowed = allowedHere();
        setupPane.setVisibility(inParty ? View.GONE : View.VISIBLE);
        partyPane.setVisibility(inParty ? View.VISIBLE : View.GONE);
        // 주행 중·차량 상태 미상이면 게임 정보를 모두 가린다(QR 포함)
        coverView.setVisibility(allowed ? View.GONE : View.VISIBLE);
        String ux = gate == null ? "UNKNOWN" : gate.ux(), gear = gate == null ? "UNKNOWN" : gate.gear();
        coverText.setText(!foreground ? "PLY가 화면 뒤에 있어요." :
            "RESTRICTED".equals(ux) || (!"P".equals(gear) && !"UNKNOWN".equals(gear)) ? "주행 중에는 게임 화면을 가려요.\nP에 두면 다시 보여요." :
            "차량 상태를 확인하는 중이에요.\n주차(P) 상태에서 열려요.");
        if (!allowed) pill(gatePill, "UNKNOWN".equals(gear) && "UNKNOWN".equals(ux) ? "차량 확인 중" : "주행 중 · 잠김", WARN);
        if (!inParty) { if (allowed) pill(gatePill, "주차 중", GOOD); return; }

        List<JSONObject> crew = phones(room);
        int free = 3 - crew.size();
        crewTitle.setText("탐험대원 " + crew.size() + " / 3");
        renderCrew(crew);

        boolean full = free <= 0;
        if (full) wasFull = true;
        else if (wasFull) { wasFull = false; inviteUrl = null; if (allowed) newInvite(); }
        boolean showQr = inviteUrl != null && !qrHidden && !full;
        qrImage.setVisibility(showQr ? View.VISIBLE : View.INVISIBLE);
        qrTimer.setVisibility(showQr ? View.VISIBLE : View.GONE);
        qrHint.setText(full ? "세 자리가 모두 찼어요.\n누가 나가면 새 QR이 떠요." : qrHidden ? "QR을 숨겼어요." : "동승자는 휴대폰 카메라로 찍어 합류하세요.");
        qrToggle.setText(qrHidden ? "QR 보이기" : "QR 숨기기");
        enable(qrRefresh, !full && !inviteBusy);

        JSONObject v = room.optJSONObject("vehicle");
        boolean serverAllowed = v != null && v.optBoolean("playAllowed");
        if (allowed) {
            if (serverAllowed) pill(gatePill, "전투 가능", GOOD);
            else {
                List<String> reasons = new ArrayList<>();
                JSONArray r = v == null ? null : v.optJSONArray("gateReasons");
                if (r != null) for (int i = 0; i < r.length(); i++) { String code = r.optString(i); reasons.add(GATE.getOrDefault(code, code)); }
                pill(gatePill, reasons.isEmpty() ? "서버 확인 중" : String.join(" · ", reasons), WARN);
            }
        }

        String st = room.optString("state");
        battleState.setText(STATE.getOrDefault(st, st));
        battleState.setTextColor("PLAYING".equals(st) ? ACCENT : "CLEARED".equals(st) ? GOOD : TEXT);
        JSONArray zombies = room.optJSONArray("zombies");
        int alive = 0, total = zombies == null ? 0 : zombies.length();
        for (int i = 0; i < total; i++) if (zombies.optJSONObject(i) != null && zombies.optJSONObject(i).optInt("hp") > 0) alive++;
        zombiesValue.setText(total > 0 ? alive + " / " + total : "-");
        suppliesValue.setText(String.valueOf(supplies(room)));
        JSONObject stats = room.optJSONObject("stats");
        killsValue.setText(String.valueOf(stats == null ? 0 : stats.optInt("kills")));

        boolean connectedCrew = false, approvedAny = false;
        for (JSONObject m : crew) { if (m.optBoolean("approved")) { approvedAny = true; if (m.optBoolean("connected")) connectedCrew = true; } }
        boolean playing = "PLAYING".equals(st), live = conn.isLive();
        enable(startButton, live && serverAllowed && !playing && connectedCrew);
        startButton.setText("CLEARED".equals(st) ? "다음 웨이브 시작" : "PAUSED".equals(st) ? "전투 재개" : "전투 시작");
        enable(pauseButton, live && playing);
        enable(supportButton, live && playing && serverAllowed && supplies(room) > 0);
        supportButton.setText(stats != null && stats.optBoolean("supportActive") ? "지원 사격 중!" : "지원 사격 (보급품 1)");
        // 왜 못 누르는지 버튼 아래에 알려 준다
        String why = playing ? "" : !live ? "실시간 연결을 기다리는 중이에요." : !serverAllowed ? "서버가 아직 주차 상태를 확인하지 못했어요." :
            !connectedCrew ? (approvedAny ? "승인된 대원의 폰이 오프라인이에요. 폰에서 PLY 화면을 다시 열어 주세요." : "승인된 대원이 1명 이상 있어야 시작할 수 있어요.") : "";
        // 방금 띄운 결과 메시지는 지우지 않고, 안내 문구만 바꾸거나 지운다
        if (!why.equals(lastWhy)) { if (!why.isEmpty() || msgIsWhy) { actionMsg.setText(why); msgIsWhy = true; } lastWhy = why; }
    }

    private String crewKey = "";
    private void renderCrew(List<JSONObject> crew) {
        StringBuilder key = new StringBuilder();
        for (JSONObject m : crew) key.append(m.optString("memberId")).append(m.optString("nickname")).append(m.optString("seat")).append(m.optBoolean("approved")).append(m.optBoolean("connected")).append(busyMembers.contains(m.optString("memberId"))).append('|');
        if (key.toString().equals(crewKey)) return;
        crewKey = key.toString();
        crewList.removeAllViews();
        if (crew.isEmpty()) { crewList.addView(label("아직 합류한 대원이 없어요.", 16, MUTED)); return; }
        for (JSONObject m : crew) {
            boolean approved = m.optBoolean("approved"), connected = m.optBoolean("connected");
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(14), dp(12), dp(10), dp(12));
            row.setBackground(round(approved ? Color.rgb(28, 42, 48) : Color.rgb(48, 40, 24), dp(12), approved ? LINE : WARN));
            LinearLayout text = new LinearLayout(this);
            text.setOrientation(LinearLayout.VERTICAL);
            TextView name = label(m.optString("nickname"), 18, TEXT); name.setTypeface(Typeface.DEFAULT_BOLD);
            String stateText = approved ? (connected ? "접속 중" : "오프라인") : "승인 대기";
            TextView meta = label(seatName(m.optString("seat")) + " · " + stateText, 14, approved ? (connected ? GOOD : MUTED) : WARN);
            text.addView(name); text.addView(meta);
            row.addView(text, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            boolean busy = busyMembers.contains(m.optString("memberId"));
            if (!approved) { Button b = button("승인", true, v -> approve(m)); enable(b, !busy); row.addView(b); }
            Button x = button("내보내기", false, v -> removeMember(m)); enable(x, !busy);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.leftMargin = dp(8);
            row.addView(x, lp);
            LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            rowLp.bottomMargin = dp(8);
            crewList.addView(row, rowLp);
        }
    }

    private void message(String text) { actionMsg.setText(text); msgIsWhy = false; }

    // ── 방 데이터 ───────────────────────────────────────────
    private static List<JSONObject> phones(JSONObject r) {
        List<JSONObject> out = new ArrayList<>();
        JSONArray members = r == null ? null : r.optJSONArray("members");
        if (members != null) for (int i = 0; i < members.length(); i++) { JSONObject m = members.optJSONObject(i); if (m != null && !"CAR_HOST".equals(m.optString("role"))) out.add(m); }
        return out;
    }
    private static int approvedCount(JSONObject r) { int n = 0; for (JSONObject m : phones(r)) if (m.optBoolean("approved")) n++; return n; }
    private static int supplies(JSONObject r) {
        JSONObject c = r == null ? null : r.optJSONObject("collection");
        JSONObject inv = c == null ? null : c.optJSONObject("inventory");
        return inv == null ? 0 : inv.optInt("supplies");
    }
    private int freeSeats() { return 3 - phones(room).size(); }
    private static String seatName(String seat) { String v = SEAT.get(seat); return v != null ? v : seat; }

    // ── 화면 구성 ───────────────────────────────────────────
    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(28), dp(20), dp(28), dp(20));
        root.addView(page, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 머리줄
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = label("PLY", 28, ACCENT); title.setTypeface(Typeface.DEFAULT_BOLD); title.setLetterSpacing(0.06f);
        header.addView(title);
        TextView sub = label("  가족 탐험대", 18, MUTED);
        header.addView(sub, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        gatePill = pillView(); header.addView(gatePill, gap(8));
        linkPill = pillView(); header.addView(linkPill, gap(8));
        soundButton = pillView();
        soundButton.setOnClickListener(v -> { chimes.setEnabled(!chimes.enabled()); prefs.edit().putBoolean("sound", chimes.enabled()).apply(); updateSound(); chimes.tap(); });
        header.addView(soundButton, gap(8));
        updateSound();
        pill(linkPill, "연결 전", MUTED);
        page.addView(header);

        FrameLayout body = new FrameLayout(this);
        LinearLayout.LayoutParams bodyLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1);
        bodyLp.topMargin = dp(18);
        page.addView(body, bodyLp);

        setupView = buildSetup();
        ScrollView setupScroll = new ScrollView(this);
        setupScroll.addView(setupView);
        body.addView(setupScroll);
        setupPane = setupScroll;
        partyView = buildParty();
        ScrollView partyScroll = new ScrollView(this);
        partyScroll.setFillViewport(true);
        partyScroll.addView(partyView);
        body.addView(partyScroll);
        partyPane = partyScroll;

        coverView = new FrameLayout(this);
        coverView.setBackgroundColor(Color.argb(250, 14, 19, 22));
        coverView.setClickable(true);
        coverText = label("", 30, TEXT);
        coverText.setGravity(Gravity.CENTER);
        coverText.setLineSpacing(dp(6), 1);
        coverView.addView(coverText, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        body.addView(coverView);
        setContentView(root);
    }

    private LinearLayout buildSetup() {
        LinearLayout box = card();
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        TextView h = label("파티를 열어 동승자를 불러 보세요", 26, TEXT); h.setTypeface(Typeface.DEFAULT_BOLD); h.setGravity(Gravity.CENTER);
        box.addView(h);
        TextView d = label("파티를 열면 QR이 떠요. 동승자가 휴대폰 카메라로 찍으면 합류 요청이 오고, 여기서 승인하면 같은 파티가 돼요. 전투는 주차(P) 중에만 시작할 수 있어요.", 16, MUTED);
        d.setGravity(Gravity.CENTER); d.setPadding(0, dp(10), 0, dp(20));
        box.addView(d, new LinearLayout.LayoutParams(dp(620), ViewGroup.LayoutParams.WRAP_CONTENT));
        openButton = button("파티 열기", true, v -> openParty());
        openButton.setTextSize(22); openButton.setPadding(dp(48), dp(18), dp(48), dp(18));
        box.addView(openButton);
        setupError = label("", 16, WARN); setupError.setGravity(Gravity.CENTER); setupError.setPadding(0, dp(12), 0, 0);
        box.addView(setupError);

        TextView toggle = label("설정 ▾", 15, MUTED);
        toggle.setPadding(dp(12), dp(18), dp(12), dp(6));
        box.addView(toggle);
        settingsBox = new LinearLayout(this);
        settingsBox.setOrientation(LinearLayout.VERTICAL);
        settingsBox.setVisibility(View.GONE);
        toggle.setOnClickListener(v -> settingsBox.setVisibility(settingsBox.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE));
        serverInput = input("서버 주소", InputType.TYPE_TEXT_VARIATION_URI);
        serverInput.setOnFocusChangeListener((v, has) -> { if (!has) checkConfig(); });
        settingsBox.addView(field("서버 주소", serverInput));
        nameInput = input("우리 차", InputType.TYPE_CLASS_TEXT);
        settingsBox.addView(field("차량 이름", nameInput));
        keyInput = input("테스트 접근키", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        keyRow = field("테스트 접근키 (저장하지 않음)", keyInput);
        keyRow.setVisibility(View.GONE);
        settingsBox.addView(keyRow);
        box.addView(settingsBox, new LinearLayout.LayoutParams(dp(520), ViewGroup.LayoutParams.WRAP_CONTENT));
        LinearLayout wrap = new LinearLayout(this);
        wrap.setGravity(Gravity.CENTER_HORIZONTAL);
        wrap.setPadding(0, dp(30), 0, dp(30));
        wrap.addView(box);
        return wrap;
    }

    private LinearLayout buildParty() {
        boolean wide = getResources().getConfiguration().screenWidthDp >= 900;
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(wide ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);

        // QR
        LinearLayout qr = card();
        qr.setGravity(Gravity.CENTER_HORIZONTAL);
        qr.addView(heading("QR로 합류"));
        FrameLayout qrFrame = new FrameLayout(this);
        qrFrame.setBackground(round(Color.WHITE, dp(14), Color.WHITE));
        qrFrame.setPadding(dp(8), dp(8), dp(8), dp(8));
        qrImage = new ImageView(this);
        qrImage.setContentDescription("동승자 합류 QR");
        qrImage.setScaleType(ImageView.ScaleType.FIT_CENTER);
        qrFrame.addView(qrImage, new FrameLayout.LayoutParams(dp(300), dp(300)));
        LinearLayout.LayoutParams qrLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        qrLp.topMargin = dp(10);
        qr.addView(qrFrame, qrLp);
        qrTimer = label("", 18, MUTED); qrTimer.setPadding(0, dp(10), 0, 0); qrTimer.setTypeface(Typeface.DEFAULT_BOLD);
        qr.addView(qrTimer);
        qrHint = label("", 15, MUTED); qrHint.setGravity(Gravity.CENTER); qrHint.setPadding(0, dp(6), 0, dp(6));
        qr.addView(qrHint);
        qrError = label("", 14, WARN); qrError.setGravity(Gravity.CENTER);
        qr.addView(qrError);
        LinearLayout qrButtons = new LinearLayout(this);
        qrRefresh = button("새 QR", false, v -> newInvite());
        qrToggle = button("QR 숨기기", false, v -> { qrHidden = !qrHidden; render(); });
        qrButtons.addView(qrRefresh); qrButtons.addView(qrToggle, gap(8));
        qr.addView(qrButtons);

        // 대원
        LinearLayout crew = card();
        crewTitle = heading("탐험대원 0 / 3");
        crew.addView(crewTitle);
        crew.addView(label("QR을 찍은 동승자가 여기에 떠요. 자리를 확인하고 승인해 주세요.", 14, MUTED));
        crewList = new LinearLayout(this);
        crewList.setOrientation(LinearLayout.VERTICAL);
        crewList.setPadding(0, dp(12), 0, 0);
        crew.addView(crewList);

        // 전투
        LinearLayout battle = card();
        battle.addView(heading("공동 전투"));
        battleState = label("대기", 26, TEXT); battleState.setTypeface(Typeface.DEFAULT_BOLD);
        battle.addView(battleState);
        LinearLayout stats = new LinearLayout(this);
        stats.setPadding(0, dp(10), 0, dp(14));
        zombiesValue = stat(stats, "남은 좀비");
        suppliesValue = stat(stats, "보급품");
        killsValue = stat(stats, "처치");
        battle.addView(stats);
        startButton = button("전투 시작", true, v -> command("round.start", "전투 시작! 동승자 폰에 전투 화면이 열려요."));
        startButton.setTextSize(20);
        battle.addView(startButton, fill());
        LinearLayout pair = new LinearLayout(this);
        pauseButton = button("일시정지", false, v -> command("round.pause", "일시정지했어요."));
        supportButton = button("지원 사격 (보급품 1)", false, v -> command("support.pulse", "차량 지원 사격! 5초 동안 동승자 사격 피해가 커져요."));
        pair.addView(pauseButton, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        LinearLayout.LayoutParams sLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.4f); sLp.leftMargin = dp(8);
        pair.addView(supportButton, sLp);
        LinearLayout.LayoutParams pairLp = fill(); pairLp.topMargin = dp(8);
        battle.addView(pair, pairLp);
        actionMsg = label("", 15, WARN); actionMsg.setPadding(0, dp(12), 0, dp(12));
        battle.addView(actionMsg);
        View spacer = new View(this);
        battle.addView(spacer, new LinearLayout.LayoutParams(1, 0, 1));
        disbandButton = button("파티 해산", false, v -> disband());
        disbandButton.setTextColor(BAD);
        battle.addView(disbandButton);

        if (wide) {
            row.addView(qr, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT));
            LinearLayout.LayoutParams c = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1); c.leftMargin = dp(16);
            row.addView(crew, c);
            LinearLayout.LayoutParams b = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1); b.leftMargin = dp(16);
            row.addView(battle, b);
        } else {
            for (LinearLayout part : new LinearLayout[]{qr, crew, battle}) {
                LinearLayout.LayoutParams lp = fill(); lp.bottomMargin = dp(14);
                row.addView(part, lp);
            }
        }
        return row;
    }

    // ── 작은 부품 ───────────────────────────────────────────
    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
    private LinearLayout.LayoutParams gap(int left) { LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT); lp.leftMargin = dp(left); return lp; }
    private LinearLayout.LayoutParams fill() { return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT); }
    private static GradientDrawable round(int color, int radius, int stroke) {
        GradientDrawable g = new GradientDrawable(); g.setColor(color); g.setCornerRadius(radius); g.setStroke(2, stroke); return g;
    }
    private TextView label(String value, int sp, int color) { TextView t = new TextView(this); t.setText(value); t.setTextSize(sp); t.setTextColor(color); return t; }
    private TextView heading(String value) { TextView t = label(value, 20, TEXT); t.setTypeface(Typeface.DEFAULT_BOLD); t.setPadding(0, 0, 0, dp(6)); return t; }
    private LinearLayout card() {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setPadding(dp(22), dp(20), dp(22), dp(20));
        c.setBackground(round(CARD, dp(20), LINE));
        return c;
    }
    private Button button(String title, boolean primary, View.OnClickListener action) {
        Button b = new Button(this);
        b.setText(title); b.setAllCaps(false); b.setTextSize(16);
        b.setTextColor(primary ? Color.rgb(20, 12, 8) : TEXT);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setBackground(round(primary ? ACCENT : Color.rgb(34, 46, 54), dp(12), primary ? ACCENT : LINE));
        b.setPadding(dp(20), dp(12), dp(20), dp(12));
        b.setMinHeight(dp(52));
        b.setStateListAnimator(null);
        b.setOnClickListener(action);
        b.setContentDescription(title);
        return b;
    }
    private void enable(Button b, boolean on) { b.setEnabled(on); b.setAlpha(on ? 1f : 0.38f); }
    private EditText input(String hint, int type) {
        EditText e = new EditText(this);
        e.setSingleLine(true); e.setInputType(type); e.setHint(hint);
        e.setTextColor(TEXT); e.setHintTextColor(MUTED); e.setTextSize(16);
        e.setContentDescription(hint);
        return e;
    }
    private LinearLayout field(String name, EditText input) {
        LinearLayout f = new LinearLayout(this);
        f.setOrientation(LinearLayout.VERTICAL);
        f.setPadding(0, dp(6), 0, dp(6));
        f.addView(label(name, 13, MUTED));
        f.addView(input, fill());
        return f;
    }
    private TextView stat(LinearLayout parent, String name) {
        LinearLayout s = new LinearLayout(this);
        s.setOrientation(LinearLayout.VERTICAL);
        s.addView(label(name, 13, MUTED));
        TextView value = label("-", 28, TEXT); value.setTypeface(Typeface.DEFAULT_BOLD);
        s.addView(value);
        parent.addView(s, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        return value;
    }
    private TextView pillView() { TextView t = label("", 14, TEXT); t.setPadding(dp(14), dp(7), dp(14), dp(7)); t.setTypeface(Typeface.DEFAULT_BOLD); return t; }
    private void pill(TextView t, String text, int color) {
        t.setText(text); t.setTextColor(color);
        t.setBackground(round(Color.argb(40, Color.red(color), Color.green(color), Color.blue(color)), dp(20), color));
    }
    private void updateSound() { pill(soundButton, chimes.enabled() ? "소리 켜짐" : "소리 꺼짐", chimes.enabled() ? TEXT : MUTED); }
    private void hideKeyboard() { InputMethodManager im = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE); View f = getCurrentFocus(); if (im != null && f != null) im.hideSoftInputFromWindow(f.getWindowToken(), 0); }

    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); }
}

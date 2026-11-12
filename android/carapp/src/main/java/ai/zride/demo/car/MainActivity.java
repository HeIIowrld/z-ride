package ai.zride.demo.car;

import android.os.Bundle;
import android.app.Dialog;
import android.content.pm.PackageManager;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import ai.zride.demo.common.DemoActivity;
import org.json.JSONObject;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import java.io.File;
import java.io.FileWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import ai.zride.demo.common.RoomClient;
import android.widget.TextView;

public final class MainActivity extends DemoActivity {
    private enum Game {
        THIEF("전기도둑", "숨은 도둑을 찾아라", R.drawable.arcade_thief, 0xff9ea7ff),
        RELAY("충전 릴레이", "그림이 정답까지 이어질까?", R.drawable.arcade_relay, 0xffffa16f),
        DEADZONE("DEADZONE", "한 대의 차량, 세 방향의 전투", R.drawable.arcade_deadzone, 0xffff796c);

        final String title, description;
        final int art, accent;

        Game(String title, String description, int art, int accent) {
            this.title = title;
            this.description = description;
            this.art = art;
            this.accent = accent;
        }
    }

    private static final String[] SEATS = {"FRONT_PASSENGER", "REAR_LEFT", "REAR_RIGHT"};
    private static final String[] SEAT_NAMES = {"조수석", "뒷좌석 왼쪽", "뒷좌석 오른쪽"};
    private LinearLayout venuePanel;
    private View arcadeViewport;
    private LinearLayout venueChoices, venueCover, venueSeats;
    private TextView venueLabel, venueLobbyDetail;
    private boolean venueLobbyArt;
    private TextView venueDetail;
    private TextView venueInstruction;
    private Button venueStart, venueNext, venueItem;
    private Game venueCoverGame;
    private boolean venuePending, venueStatusPending, venueVisible;
    private String venueStopName = "";
    private int venueActionVersion;

    private void requestVenue(String action, String kind) {
        boolean statusOnly = "status".equals(action);
        if (room == null || !localAllowed || !client.isAuthenticated() || venuePending
                || (statusOnly && venueStatusPending)) return;
        String roomId = room.optString("roomId");
        JSONObject body = newJSONObject("action", action);
        if (kind != null) try { body.put("kind", kind); } catch (org.json.JSONException error) { return; }
        if (statusOnly) venueStatusPending = true;
        else {
            venuePending = true;
            venueActionVersion++;
        }
        int version = venueActionVersion;
        client.postApi("/api/rooms/" + roomId + "/venue-game", body, new RoomClient.ApiCallback() {
            public void onResponse(JSONObject value) { main.post(() -> {
                if (statusOnly) venueStatusPending = false;
                else venuePending = false;
                if (version == venueActionVersion && room != null && roomId.equals(room.optString("roomId"))) showVenue(value);
            }); }
            public void onError(String error) { main.post(() -> {
                if (statusOnly) venueStatusPending = false;
                else {
                    venuePending = false;
                    if (foreground && room != null && roomId.equals(room.optString("roomId")))
                        android.widget.Toast.makeText(MainActivity.this,
                                "차량 상태와 동승자 연결을 확인해 주세요.", android.widget.Toast.LENGTH_SHORT).show();
                }
            }); }
        });
    }

    private void showVenue(JSONObject response) {
        if (venueCabinEffects != null)
            venueCabinEffects.update(room.optString("roomId"), response, probe);
        JSONObject stop = response.optJSONObject("stop");
        venueVisible = localAllowed && foreground && connected && stop != null;
        venueStopName = venueVisible ? stop.optString("name") : "";
        updateArcadeVisibility();
        if (!venueVisible) return;
        JSONObject game = response.optJSONObject("game");
        String phase = game == null ? "" : game.optString("phase");
        boolean choose = game == null || "END".equals(phase);
        venueChoices.setVisibility(choose ? View.VISIBLE : View.GONE);
        venueCover.setVisibility(game != null ? View.VISIBLE : View.GONE);
        boolean lobby = "LOBBY".equals(phase) || "BRIEFING".equals(phase);
        venueSeats.setVisibility(lobby ? View.VISIBLE : View.GONE);
        if (lobby) updateSeats(venueSeats, game, "BRIEFING".equals(phase));
        venueStart.setVisibility("LOBBY".equals(phase) ? android.view.View.VISIBLE : android.view.View.GONE);
        boolean next = java.util.Arrays.asList("RESULT","TALK","VERDICT","REVEAL","ROUND_END").contains(phase);
        venueNext.setVisibility(next ? android.view.View.VISIBLE : android.view.View.GONE);
        switch (phase) {
            case "RESULT": venueNext.setText("토론 시작"); break;
            case "TALK": venueNext.setText("투표 시작"); break;
            case "VERDICT": venueNext.setText("경기 계속"); break;
            case "REVEAL": venueNext.setText("다음 그림 보기"); break;
            case "ROUND_END": venueNext.setText("라운드 마치기"); break;
            default: break;
        }
        venueItem.setVisibility(response.optBoolean("canUseItem") && response.optInt("supplies") > 0
                ? android.view.View.VISIBLE : android.view.View.GONE);
        boolean thief = "thief".equals(response.optString("kind"));
        Game selected = thief ? Game.THIEF : Game.RELAY;
        if (game != null && (venueCoverGame != selected || venueLobbyArt != lobby)) {
            venueCoverGame = selected;
            venueLobbyArt = lobby;
            venueCover.setBackground(lobby ? cover(selected) : null);
            if (!lobby) styleVehicleCard(venueCover, selected == Game.THIEF ? 0xff1c2040 : 0xff35251f);
            venueCover.requestLayout();
        }
        venueItem.setText(thief ? "보급품 1개로 비상 퓨즈 사용" : "보급품 1개로 15초 연장");
        String placeName = stop.optString("name", "충전소");
        if (placeName.startsWith("이름 미등록")) placeName = "충전소";
        venueLabel.setText(game == null ? placeName + " · 충전 중" : selected.title);
        String detail = placeName + " · 충전 중";
        if (game != null) {
            String stage;
            switch (phase) {
                case "LOBBY": stage = selected.description; break;
                case "BRIEFING": stage = "폰에서 준비 중"; break;
                case "CHARGING": stage = "충전 " + game.optInt("soc") + "% · 다음 사건 " + game.optInt("nextAt") + "%"; break;
                case "CASE": stage = "동승자가 카드 선택 중"; break;
                case "RESULT": stage = "사건 결과 · 정전 " + game.optInt("blackouts") + "회"; break;
                case "TALK": stage = "토론 중"; break;
                case "VOTE": stage = "폰에서 투표 중"; break;
                case "VERDICT": stage = "투표 결과"; break;
                case "PLAY":
                    long remaining = Math.max(0, (game.optLong("deadline") - System.currentTimeMillis() + 999) / 1000);
                    stage = "릴레이 " + game.optInt("round") + "라운드 · " + remaining + "초";
                    break;
                case "REVEAL":
                    JSONObject reveal = game.optJSONObject("reveal");
                    stage = reveal == null ? "스케치북 공개" : "스케치북 공개 · " + reveal.optString("word");
                    break;
                case "ROUND_END": stage = "라운드 완료"; break;
                case "END":
                    JSONObject score = game.optJSONObject("family");
                    stage = thief ? ("FAMILY".equals(game.optString("winner")) ? "가족 승리" : "도둑 승리")
                            : score == null ? "경기 종료" : "전달 성공 " + score.optInt("success") + " / " + score.optInt("total");
                    break;
                default: stage = "진행 중";
            }
            detail = stage + " · 보급품 " + response.optInt("supplies") + "개";
        }
        venueLobbyDetail.setText(detail);
        venueDetail.setText(detail);
        venueLobbyDetail.setVisibility(lobby ? View.VISIBLE : View.GONE);
        venueDetail.setVisibility(lobby ? View.GONE : View.VISIBLE);
        String instruction;
        switch (phase) {
            case "LOBBY": instruction = ""; break;
            case "BRIEFING": instruction = "동승자는 폰에서 역할을 확인하고 준비를 눌러 주세요."; break;
            case "CASE": instruction = "동승자는 폰에서 카드를 선택해 주세요."; break;
            case "TALK": instruction = "함께 이야기한 뒤 차량에서 투표를 열어 주세요."; break;
            case "VOTE": instruction = "동승자는 폰에서 투표해 주세요."; break;
            case "PLAY": instruction = "동승자는 폰에서 그림이나 정답을 제출해 주세요."; break;
            case "END": instruction = "결과를 확인한 뒤 다음 게임을 선택할 수 있어요."; break;
            default: instruction = choose && approvedPassengers() < 2
                    ? "동승자 두 명이 연결되면 함께 플레이할 수 있어요." : "";
        }
        venueInstruction.setText(instruction);
        venueInstruction.setVisibility(instruction.isEmpty() ? android.view.View.GONE : android.view.View.VISIBLE);
        venueLabel.setVisibility(game == null ? View.GONE : View.VISIBLE);
        venueDetail.setVisibility(game == null ? View.GONE : View.VISIBLE);
        venueChoiceTitle.setText(game == null ? "충전소 게임" : "다음 게임");
    }

    private Button venueControl(String text, String action, String kind) {
        Button button = new Button(this);
        button.setText(text);
        styleVehicleButton(button);
        button.setOnClickListener(view -> requestVenue(action, kind));
        return button;
    }

    private TextView venueChoiceTitle;

    private void addVenueControls(LinearLayout container) {
        arcadeViewport = (View) container.getParent();
        venuePanel = column();
        venuePanel.setVisibility(View.GONE);
        venueCover = column();
        venueCover.setGravity(Gravity.CENTER_VERTICAL);
        venueCover.addOnLayoutChangeListener((view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            int height = venueLobbyArt ? Math.max(dp(152), Math.min((right - left) * 5 / 12,
                    arcadeViewport.getHeight() * 52 / 100)) : dp(112);
            if (venueCover.getMinimumHeight() != height) venueCover.setMinimumHeight(height);
        });
        venueCover.setPadding(dp(28), dp(12), dp(24), dp(12));
        venuePanel.addView(venueCover);
        venueLabel = dashboardText(venueCover, 44, true);
        venueLobbyDetail = dashboardText(venueCover, 20, false);
        venueDetail = dashboardText(venueCover, 32, true);
        venueInstruction = dashboardText(venuePanel, 20, true);
        venueSeats = seatStrip(venuePanel);
        venueStart = venueControl("게임 시작", "start", null);
        venueNext = venueControl("다음", "next", null);
        venueItem = venueControl("보급품 사용", "item", null);
        venuePanel.addView(venueStart);
        venuePanel.addView(venueNext);
        venuePanel.addView(venueItem);
        venueChoices = column();
        venuePanel.addView(venueChoices);
        venueChoiceTitle = dashboardText(venueChoices, 32, true);
        boolean wide = getResources().getConfiguration().screenWidthDp >= 660;
        LinearLayout cards = new LinearLayout(this);
        cards.setOrientation(wide ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        venueChoices.addView(cards);
        addGameCard(cards, Game.THIEF, wide, false, () -> requestVenue("open", "thief"));
        addGameCard(cards, Game.RELAY, wide, true, () -> requestVenue("open", "relay"));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(12);
        container.addView(venuePanel, params);
    }

    private TextView leaderboard;
    private TextView matchSummary, vehicleHealth;
    private android.widget.ProgressBar healthMeter;
    private LinearLayout healthCard;
    private LinearLayout ranking;
    private Button deadzoneStart;
    private Button repairVehicle;
    private Button leaveBoard;
    private LinearLayout deadzonePanel;
    private LinearLayout deadzoneCard, deadzoneSeats;
    private Button settingsButton;
    private LinearLayout arcadeToolbar;
    private Button cabinButton;
    private Button welcomeDestinationButton;
    private Button destinationToolbarButton;
    private Dialog destinationDialog;
    private TextView cabinSummary;
    private TextView journeySummary;
    private CabinPanel cabinPanel;
    private android.app.AlertDialog cabinDialog;
    private android.app.AlertDialog settingsDialog;
    private boolean showMatchOnly;

    private void focusMatch(boolean focus) {
        showMatchOnly = focus;
        updateArcadeVisibility();
    }
    private boolean deadzonePolling;
    private boolean deadzonePending;
    private boolean repairQueued;

    @Override protected void onGameVisibilityChanged() {
        navigationState = NavigationRelayService.currentState();
        if (arcadeToolbar != null)
            arcadeToolbar.setVisibility(foreground && localAllowed ? View.VISIBLE : View.GONE);
        if (!localAllowed && cabinDialog != null) cabinDialog.dismiss();
        if (destinationToolbarButton != null)
            destinationToolbarButton.setVisibility(connected ? View.VISIBLE : View.GONE);
        if ((!foreground || !localAllowed) && destinationDialog != null) destinationDialog.dismiss();
        updateArcadeVisibility();
    }

    private void updateArcadeVisibility() {
        if (deadzonePanel == null) return;
        boolean parked = foreground && localAllowed && connected;
        if (!parked) repairQueued = false;
        if (!parked) venueVisible = false;
        boolean showVenue = parked && venueVisible;
        boolean deadzoneAvailable = parked && !showVenue && !routeInProgress();
        boolean showDeadzone = deadzoneAvailable && showMatchOnly;
        venuePanel.setVisibility(showVenue ? View.VISIBLE : View.GONE);
        renderDriveGames(parked && !showVenue && !showDeadzone);
        deadzonePanel.setVisibility(showDeadzone ? View.VISIBLE : View.GONE);
        deadzoneCard.setVisibility(deadzoneAvailable && !showDeadzone
                && (approvedPassengers() > 0 || showVehicleDiagnostics()) ? View.VISIBLE : View.GONE);
        showVehicleLobby(!showDeadzone && (!showVenue || approvedPassengers() < 2));
        if (showVenue || showDeadzone) hideVehicleRoundControls();
        if (!showVehicleDiagnostics() && connected) status.setVisibility(View.GONE);
        deadzoneStart.setEnabled(showDeadzone && !deadzonePending && approvedPassengers() > 0);
        if (showDeadzone && !deadzonePolling) updateSeats(deadzoneSeats, null, false);
        cabinSummary.setVisibility(showVenue || showDeadzone ? View.VISIBLE : View.INVISIBLE);
        updateJourneySummary();
    }

    private static final String[] DRIVE_IDS = {"license-quiz", "pole-jump", "raindrop"};
    private static final String[] DRIVE_TITLES = {"운전면허 퀴즈", "폴짝 전봇대", "빗방울 캐치"};
    private static final int[] DRIVE_ACCENTS = {0xffb8b3ff, 0xffffc591, 0xff88e3db};
    private LinearLayout drivePanel, driveChoices;
    private TextView driveStatus;
    private boolean drivePending;

    private void addDriveGames(LinearLayout container) {
        drivePanel = column();
        drivePanel.setVisibility(View.GONE);
        drivePanel.setPadding(dp(18), dp(14), dp(18), dp(16));
        styleVehicleCard(drivePanel, 0xff181d30);
        dashboardText(drivePanel, 26, true).setText("주행 중 동승자 게임");
        driveStatus = dashboardText(drivePanel, 19, false);
        driveChoices = new LinearLayout(this);
        boolean wide = getResources().getConfiguration().screenWidthDp >= 660;
        driveChoices.setOrientation(wide ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        drivePanel.addView(driveChoices);
        for (int index = 0; index < DRIVE_IDS.length; index++) {
            int game = index;
            Button card = new Button(this);
            card.setText(DRIVE_TITLES[index]);
            card.setTextSize(18);
            card.setMinHeight(dp(64));
            styleVehicleButton(card);
            card.setOnClickListener(view -> selectDriveGame(DRIVE_IDS[game]));
            LinearLayout.LayoutParams layout = wide ? new LinearLayout.LayoutParams(0, -2, 1)
                    : new LinearLayout.LayoutParams(-1, -2);
            layout.topMargin = dp(8);
            if (wide && index > 0) layout.setMarginStart(dp(8));
            driveChoices.addView(card, layout);
        }
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-1, -2);
        layout.topMargin = dp(12);
        container.addView(drivePanel, Math.max(0, container.indexOfChild(roomLabel)), layout);
    }

    private void renderDriveGames(boolean parked) {
        if (drivePanel == null) return;
        boolean show = parked && room != null && room.optBoolean("driveGamesAvailable") && approvedPassengers() > 0;
        drivePanel.setVisibility(show ? View.VISIBLE : View.GONE);
        if (!show) return;
        String selection = room.optString("driveGame");
        String message = "출발 전에 동승자에게 추천할 게임을 고르세요.";
        for (int index = 0; index < DRIVE_IDS.length; index++) {
            Button card = (Button) driveChoices.getChildAt(index);
            boolean selected = DRIVE_IDS[index].equals(selection);
            card.setEnabled(!drivePending && !selected);
            card.setTextColor(selected ? DRIVE_ACCENTS[index] : drivePending ? 0xffa6aabe : 0xff101323);
            card.setSelected(selected);
            if (selected) message = DRIVE_TITLES[index] + " · 출발 후 동승자 폰에 표시";
        }
        if (!message.contentEquals(driveStatus.getText())) driveStatus.setText(message);
    }

    private void selectDriveGame(String game) {
        if (!foreground || !localAllowed || !connected || drivePending || room == null) return;
        drivePending = true;
        updateArcadeVisibility();
        client.postApi("/api/rooms/" + room.optString("roomId") + "/drive-game",
                newJSONObject("game", game), new RoomClient.ApiCallback() {
            public void onResponse(JSONObject value) { main.post(() -> finishDriveSelection(false)); }
            public void onError(String error) { main.post(() -> finishDriveSelection(true)); }
        });
    }

    private void finishDriveSelection(boolean failed) {
        drivePending = false;
        updateArcadeVisibility();
        if (failed && foreground) android.widget.Toast.makeText(this, "주차 상태와 파티 연결을 확인해 주세요.",
                android.widget.Toast.LENGTH_SHORT).show();
    }

    private boolean routeInProgress() {
        if (navigationState == null) return false;
        String state = navigationState.optString("status");
        return "SEARCHING".equals(state) || "ROUTE_READY".equals(state) || "ROUTE_DRIVE".equals(state);
    }

    private void updateJourneySummary() {
        if (journeySummary == null) return;
        String state = navigationState == null ? "" : navigationState.optString("status");
        String destination = navigationState == null || navigationState.isNull("destination")
                ? "" : navigationState.optString("destination");
        String text;
        if (venueVisible) {
            text = venueStopName.isEmpty() ? "충전 경유지" : "충전 중 · " + venueStopName;
        } else if ("ARRIVED".equals(state)) {
            text = destination.isEmpty() ? "목적지 도착" : "목적지 도착 · " + destination;
        } else if (routeInProgress()) {
            text = destination.isEmpty() ? "순정 내비 · 경로 확인 중" : "가는 중 · " + destination;
            int remaining = navigationState.optInt("remainingDistanceM", -1);
            if (!destination.isEmpty() && remaining >= 0) {
                text += remaining < 1000 ? " · " + remaining + " m"
                        : String.format(java.util.Locale.KOREA, " · %.1f km", remaining / 1000.0);
            }
        } else {
            text = "";
        }
        journeySummary.setVisibility(foreground && connected && !text.isEmpty() ? View.VISIBLE : View.GONE);
        if (!text.contentEquals(journeySummary.getText())) journeySummary.setText(text);
    }

    private int approvedPassengers() {
        int count = 0;
        for (String seat : SEATS) {
            JSONObject member = seatMember(seat);
            if (member != null && member.optBoolean("approved") && member.optBoolean("connected")) count++;
        }
        return count;
    }

    private JSONObject seatMember(String seat) {
        org.json.JSONArray members = room == null ? null : room.optJSONArray("members");
        if (members == null) return null;
        JSONObject pending = null;
        for (int i = 0; i < members.length(); i++) {
            JSONObject member = members.optJSONObject(i);
            if (member == null || !seat.equals(member.optString("seat"))
                    || "EMPTY".equals(member.optString("seatEvidence"))) continue;
            if (member.optBoolean("approved")) return member;
            pending = member;
        }
        return pending;
    }

    private void syncDeadzone(boolean create) { syncDeadzone(create, false); }

    private void syncDeadzone(boolean create, boolean repair) {
        if (room == null || !foreground || !localAllowed || !showMatchOnly || !client.isAuthenticated()) return;
        if (deadzonePending) {
            if (repair) repairQueued = true;
            return;
        }
        String roomId = room.optString("roomId");
        JSONObject request = new JSONObject();
        try {
            request.put("create", create).put("enableAmbient", ambientEnabled).put("repair", repair);
        } catch (org.json.JSONException error) {
            return;
        }
        deadzonePending = true;
        updateArcadeVisibility();
        client.postApi("/api/rooms/" + roomId + "/deadzone", request, new RoomClient.ApiCallback() {
            public void onResponse(JSONObject response) {
                main.post(() -> {
                    deadzonePending = false;
                    if (room == null || !roomId.equals(room.optString("roomId")) || !showMatchOnly) {
                        repairQueued = false;
                        return;
                    }
                    JSONObject match = response.optJSONObject("match");
                    deadzonePolling = match != null;
                    if (match == null) {
                        repairQueued = false;
                        updateArcadeVisibility();
                        return;
                    }
                    boolean ended = "ended".equals(match.optString("state"));
                    deadzoneStart.setVisibility(View.GONE);
                    deadzoneSeats.setVisibility(View.GONE);
                    ranking.setVisibility(View.VISIBLE);
                    leaderboard.setText(ended ? "DEADZONE 결과" : "DEADZONE");
                    focusMatch(true);
                    matchSummary.setText("웨이브 " + match.optInt("wave") + "   ·   팀 점수 " + match.optInt("score"));
                    var players = match.optJSONArray("players");
                    var ranked = new java.util.ArrayList<JSONObject>();
                    if (players != null) for (int i = 0; i < players.length(); i++) {
                        JSONObject player = players.optJSONObject(i);
                        if (player != null) ranked.add(player);
                    }
                    ranked.sort(java.util.Comparator.comparingInt((JSONObject player) -> player.optInt("score")).reversed());
                    updateRanking(ranked);
                    JSONObject vehicle = match.optJSONObject("vehicle");
                    int maxHp = vehicle == null ? 0 : vehicle.optInt("maxHp");
                    healthCard.setVisibility(View.VISIBLE);
                    healthMeter.setVisibility(maxHp > 0 ? View.VISIBLE : View.GONE);
                    if (maxHp > 0) {
                        healthMeter.setMax(maxHp);
                        healthMeter.setProgress(vehicle.optInt("hp"), true);
                    }
                    vehicleHealth.setText((vehicle == null ? "" : "차량 내구도 " + vehicle.optInt("hp")
                            + " / " + vehicle.optInt("maxHp") + "   ·   ")
                            + "파티 보급품 " + match.optInt("supplies") + "개");
                    repairVehicle.setVisibility(match.optBoolean("repairAvailable")
                            ? android.view.View.VISIBLE : android.view.View.GONE);
                    boolean queued = repairQueued;
                    repairQueued = false;
                    if (queued && !repair && match.optBoolean("repairAvailable")) syncDeadzone(false, true);
                });
            }
            public void onError(String error) {
                main.post(() -> {
                    deadzonePending = false;
                    boolean queued = repairQueued;
                    repairQueued = false;
                    updateArcadeVisibility();
                    if (showMatchOnly) matchSummary.setText(create ? "게임을 열지 못했어요. 참가자를 확인하고 다시 시도하세요."
                            : repair ? "수리 가능 구간과 보급품을 확인해 주세요." : "게임 상태를 다시 연결하는 중입니다");
                    if (queued && !repair && room != null && roomId.equals(room.optString("roomId")))
                        syncDeadzone(false, true);
                });
            }
        });
    }

    private VehicleProbe probe;
    private AmbientPulse ambient;
    private VenueCabinEffects venueCabinEffects;
    private boolean ambientEnabled;
    private long effectSequence;
    private String effectSession = "";

    @Override public void onResult(JSONObject value) {
        String type = value.optString("type");
        if (!type.startsWith("vehicle.effect.")) {
            super.onResult(value);
            return;
        }
        main.post(() -> {
            if (ambient == null || room == null
                    || !room.optString("roomId").equals(value.optString("roomId"))
                    || room.optLong("roomEpoch") != value.optLong("roomEpoch")) return;
            if ("vehicle.effect.stop".equals(type)) {
                ambient.stop(value);
                return;
            }
            if (!"vehicle.effect.intent".equals(type) || !"AMBIENT".equals(value.optString("channel"))) return;
            String session = value.optString("effectSessionId");
            long sequence = value.optLong("effectSeq");
            if (session.isEmpty() || sequence <= 0 || (session.equals(effectSession) && sequence <= effectSequence)) return;
            effectSession = session;
            effectSequence = sequence;
            ambient.start(client, probe == null ? null : probe.ambientLight(), value);
        });
    }

    @Override public void onDisconnected() {
        super.onDisconnected();
        main.post(this::resetGameEffects);
    }

    @Override protected void applyVehicle(JSONObject state, boolean allowed) {
        super.applyVehicle(state, allowed);
        if (!localAllowed) main.post(this::resetGameEffects);
    }
    @Override protected void sendVehicle() {
        NavigationRelayService.reportVehicle();
    }

    private String appliedRouteCommand;
    private boolean routePending;
    private TextView navigationLabel;
    private JSONObject navigationState;
    private boolean sdkNavigationOwned;
    // Private fixed demo input written by the emulator operator, never a production navigation source.
    @Override protected void onVehicleDemoTick(){
        if(connected)NavigationRelayService.attach(client);
        probe=NavigationRelayService.probe();JSONObject v=NavigationRelayService.vehicle();if(v!=null)applyVehicle(v,NavigationRelayService.vehicleAllowed());
        JSONObject cabin=NavigationRelayService.cabin();if(cabin!=null&&showVehicleDiagnostics())applyExtraDiagnostics(cabin);
        navigationState=NavigationRelayService.currentState();sdkNavigationOwned=NavigationRelayService.sdkMode();
        updateWelcomeDestination();
        if (routeInProgress() && showMatchOnly) {
            showMatchOnly = false;
            deadzonePolling = false;
        }
        updateArcadeVisibility();
        updateCabinPanel();
        if(navigationLabel!=null&&navigationState!=null)navigationLabel.setText("Pleos Navi SDK · "+navigationState.optString("status",navigationState.optString("event"))+" · "+navigationState.optString("destination","—")+" · "+navigationState.optString("error",""));
        if(deadzonePolling)syncDeadzone(false);
        if(venuePanel != null && !showMatchOnly) requestVenue("status", null);
        if(sdkNavigationOwned)return;
        if((getApplicationInfo().flags&android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)==0||!connected||room==null||routePending)return;
        File input=new File(getFilesDir(),"demo-route.json");if(!input.isFile()||input.length()>32768)return;
        try{
            JSONObject request=new JSONObject(new String(Files.readAllBytes(input.toPath()),StandardCharsets.UTF_8));
            String command=request.getString("commandId"),roomId=room.getString("roomId");
            if(command.equals(appliedRouteCommand)||!roomId.equals(request.getString("roomId")))return;
            String source=request.getString("source");if(!source.equals("DEMO_ROUTE")&&!source.equals("NONE"))return;
            JSONObject route=room.getJSONObject("party").getJSONObject("route");
            JSONObject body=new JSONObject().put("commandId",command).put("expectedRouteRevision",route.getInt("routeRevision")).put("source",source);
            if(source.equals("DEMO_ROUTE"))body.put("geometry",request.getJSONArray("geometry"));
            routePending=true;
            client.postApi("/api/rooms/"+roomId+"/route",body,new RoomClient.ApiCallback(){
                public void onResponse(JSONObject result){main.post(()->{routePending=false;appliedRouteCommand=command;saveRouteReceipt(command,result,null);});}
                public void onError(String error){main.post(()->{routePending=false;appliedRouteCommand=command;saveRouteReceipt(command,null,"ROUTE_SUBMIT_FAILED");});}
            });
        }catch(Exception ignored){}
    }
    private void saveRouteReceipt(String command,JSONObject route,String error){try(FileWriter f=new FileWriter(new File(getFilesDir(),"demo-route-result.json"))){f.write(new JSONObject().put("commandId",command).put("route",route==null?JSONObject.NULL:route).put("error",error==null?JSONObject.NULL:error).toString());}catch(Exception ignored){}}
    @Override protected boolean isCar() { return true; }
    @Override protected void addVehicleWelcomeActions(LinearLayout menu) {
        welcomeDestinationButton = destinationButton();
        welcomeDestinationButton.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        welcomeDestinationButton.setPaddingRelative(dp(20), 0, dp(20), 0);
        welcomeDestinationButton.setSingleLine();
        welcomeDestinationButton.setEllipsize(android.text.TextUtils.TruncateAt.END);
        menu.addView(welcomeDestinationButton, new LinearLayout.LayoutParams(-1, dp(58)));
    }

    private void updateWelcomeDestination() {
        if (welcomeDestinationButton == null) return;
        String state = navigationState == null ? "" : navigationState.optString("status");
        String name = "";
        if ("ROUTE_DRIVE".equals(state) || "ROUTE_READY".equals(state)) {
            if (!navigationState.isNull("destination")) name = navigationState.optString("destination");
        }
        String label = name.isEmpty() ? "목적지 설정" : "목적지 · " + name;
        if (!label.contentEquals(welcomeDestinationButton.getText())) {
            welcomeDestinationButton.setText(label);
            welcomeDestinationButton.setContentDescription(name.isEmpty() ? label : label + ", 변경");
        }
    }

    private Button destinationButton() {
        Button button = new Button(this);
        button.setText("목적지 설정");
        styleVehicleButton(button, false);
        button.setOnClickListener(view -> openDestinationSearch());
        return button;
    }

    private void openDestinationSearch() {
        if (!foreground || !localAllowed || destinationDialog != null) return;
        Dialog dialog = new Dialog(this);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        LinearLayout content = column();
        content.setPadding(dp(30), dp(23), dp(30), dp(25));
        content.setBackground(destinationSurface(0xff141924, 0xff383d56, 22));
        content.setFocusableInTouchMode(true);
        LinearLayout heading = new LinearLayout(this);
        heading.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = dashboardText(heading, 32, true);
        title.setText("목적지 검색");
        title.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
        Button close = new Button(this);
        close.setText("닫기");
        styleVehicleButton(close, false);
        close.setOnClickListener(view -> dialog.dismiss());
        heading.addView(close, new LinearLayout.LayoutParams(dp(88), dp(54)));
        content.addView(heading);

        EditText query = new EditText(this);
        query.setHint("장소 이름 또는 주소");
        query.setSingleLine(true);
        query.setTextSize(23);
        query.setTextColor(0xfff5f7ff);
        query.setHintTextColor(0xffa7afc5);
        query.setPaddingRelative(dp(20), 0, dp(20), 0);
        query.setBackground(destinationSurface(0xff0c101a, 0xff505976, 13));
        query.setOnFocusChangeListener((view, focused) ->
                query.setBackground(destinationSurface(0xff0c101a, focused ? 0xffaeb7ff : 0xff505976, 13)));
        query.setInputType(android.text.InputType.TYPE_CLASS_TEXT);
        query.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH);
        query.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(80)});
        query.setSaveEnabled(false);
        LinearLayout.LayoutParams field = new LinearLayout.LayoutParams(-1, dp(64));
        field.topMargin = dp(19);
        content.addView(query, field);
        TextView feedback = dashboardText(content, 16, false);
        feedback.setTextColor(0xffffb9ac);
        feedback.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        feedback.setVisibility(View.GONE);
        Button submit = new Button(this);
        submit.setText("순정 내비에서 검색");
        styleVehicleButton(submit);
        LinearLayout.LayoutParams action = new LinearLayout.LayoutParams(-2, dp(58));
        action.gravity = Gravity.END;
        action.topMargin = dp(17);
        content.addView(submit, action);
        dialog.setContentView(content);
        destinationDialog = dialog;
        dialog.setOnDismissListener(ignored -> destinationDialog = null);
        dialog.show();
        Window window = dialog.getWindow();
        window.setBackgroundDrawableResource(android.R.color.transparent);
        window.setDimAmount(.62f);
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                | WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        window.setLayout(Math.min(dp(680), getWindow().getDecorView().getWidth() - dp(36)), -2);
        content.requestFocus();
        Runnable search = () -> {
            String keyword = query.getText().toString().trim();
            if (keyword.isEmpty()) {
                feedback.setText("장소 이름이나 주소를 입력해 주세요.");
                feedback.setVisibility(View.VISIBLE);
            } else if (!foreground || !localAllowed) {
                dialog.dismiss();
            } else if (NavigationRelayService.searchPlace(keyword)) {
                dialog.dismiss();
            } else {
                feedback.setText("순정 내비에 연결 중이에요. 잠시 후 다시 검색해 주세요.");
                feedback.setVisibility(View.VISIBLE);
            }
        };
        submit.setOnClickListener(view -> search.run());
        query.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId != android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH) return false;
            search.run();
            return true;
        });
    }

    private GradientDrawable destinationSurface(int fill, int border, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radius));
        drawable.setStroke(dp(1), border);
        return drawable;
    }

    @Override protected Drawable vehicleCover() {
        return new GameCover(this, R.drawable.arcade_zride, 0xffb5bcff, dp(20));
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        venueCabinEffects = new VenueCabinEffects(main, () -> ambientEnabled && foreground && localAllowed
                && connected && NavigationRelayService.vehicleAllowed() && client.isAuthenticated());
        ambient = new AmbientPulse(main, () -> ambientEnabled && foreground && localAllowed
                && NavigationRelayService.vehicleAllowed() && client.isAuthenticated(), (status, value) -> {
            if (!showVehicleDiagnostics()) return;
            switch (status) {
                case "DISPATCHED": ambientObservation.setText("앰비언트 밝기 · 이전 " + value); break;
                case "APPLIED_CONFIRMED": ambientObservation.append(" → 적용 " + value); break;
                case "STOPPED": if (value != null) ambientObservation.append(" → 복원 " + value); break;
                case "UNSUPPORTED": case "FAILED": ambientObservation.setText("앰비언트 밝기 · " + status); break;
            }
        });
        startForegroundService(new android.content.Intent(this,NavigationRelayService.class));
        if (checkSelfPermission("android.car.permission.CAR_SPEED") != PackageManager.PERMISSION_GRANTED
                && !getPreferences(MODE_PRIVATE).getBoolean("speedPermissionRequested", false)) {
            getPreferences(MODE_PRIVATE).edit().putBoolean("speedPermissionRequested", true).apply();
            requestPermissions(new String[]{"android.car.permission.CAR_SPEED"}, 103);
        }
        JSONObject prior=NavigationRelayService.currentRoom();if(prior!=null)onRoom(prior);

    }
    @Override protected void addVehicleControls(LinearLayout container){addVenueControls(container);addDriveGames(container);addDeadzonePanel(container);if(!showVehicleDiagnostics())return;Button request=new Button(this);request.setText("충전 정보 권한 요청 (선택)");request.setContentDescription("충전 정보 권한 요청");request.setOnClickListener(v->{if(checkSelfPermission("android.car.permission.CAR_ENERGY")!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{"android.car.permission.CAR_ENERGY"},101);else if(probe!=null)probe.refresh();});container.addView(request);Button inspect=new Button(this);inspect.setText("벨트 · 공조 · 도어 · 창문 · 조명 읽기 진단");inspect.setOnClickListener(v->{if(probe!=null)probe.inspectCabin();});container.addView(inspect);addNavigationControls(container);}
    private void addDeadzonePanel(LinearLayout container){
        arcadeToolbar = new LinearLayout(this);
        arcadeToolbar.setGravity(Gravity.CENTER_VERTICAL);
        container.addView(arcadeToolbar, Math.min(1, container.getChildCount()));
        journeySummary = new TextView(this);
        journeySummary.setTextColor(0xffe3e6ff);
        journeySummary.setTextSize(18);
        journeySummary.setMaxLines(1);
        journeySummary.setEllipsize(android.text.TextUtils.TruncateAt.END);
        journeySummary.setPadding(dp(18), dp(10), dp(18), dp(10));
        styleVehicleCard(journeySummary, 0xff171a29);
        journeySummary.setVisibility(View.GONE);
        container.addView(journeySummary, container.indexOfChild(arcadeToolbar) + 1);
        cabinButton = new Button(this);
        cabinButton.setText("차량 상태");
        styleVehicleButton(cabinButton, false);
        cabinButton.setOnClickListener(view -> openCabinPanel());
        arcadeToolbar.addView(cabinButton, new LinearLayout.LayoutParams(-2, -2));
        destinationToolbarButton = destinationButton();
        arcadeToolbar.addView(destinationToolbarButton, new LinearLayout.LayoutParams(-2, -2));
        cabinSummary = new TextView(this);
        cabinSummary.setTextSize(17);
        cabinSummary.setTextColor(0xffc3c9e0);
        cabinSummary.setPadding(dp(16), 0, dp(12), 0);
        arcadeToolbar.addView(cabinSummary, new LinearLayout.LayoutParams(0, -2, 1));
        settingsButton = new Button(this);
        settingsButton.setText("설정");
        styleVehicleButton(settingsButton, false);
        LinearLayout.LayoutParams settingsLayout = new LinearLayout.LayoutParams(dp(112), -2);
        arcadeToolbar.addView(settingsButton, settingsLayout);
        settingsButton.setOnClickListener(view -> openGameSettings());
        deadzoneCard = column();
        addGameCard(deadzoneCard, Game.DEADZONE, false, false, () -> {
            if (routeInProgress() || venueVisible) return;
            resetMatchBoard();
            focusMatch(true);
        });
        container.addView(deadzoneCard, Math.max(0, container.indexOfChild(roomLabel)));
        deadzonePanel = column();
        deadzonePanel.setVisibility(View.GONE);
        LinearLayout.LayoutParams panelParams = new LinearLayout.LayoutParams(-1, -2);
        panelParams.topMargin = dp(12);
        container.addView(deadzonePanel, panelParams);
        LinearLayout title = column();
        title.setGravity(Gravity.CENTER_VERTICAL);
        sizeLobbyCover(title);
        title.setPadding(dp(28), dp(12), dp(24), dp(12));
        title.setBackground(cover(Game.DEADZONE));
        deadzonePanel.addView(title);
        leaderboard = dashboardText(title, 48, true);
        matchSummary = dashboardText(title, 21, true);
        deadzoneSeats = seatStrip(deadzonePanel);
        healthCard = column();
        healthCard.setPadding(dp(16), dp(10), dp(16), dp(10));
        styleVehicleCard(healthCard, 0xff251b29);
        LinearLayout.LayoutParams healthLayout = new LinearLayout.LayoutParams(-1, -2);
        healthLayout.topMargin = dp(8);
        healthLayout.bottomMargin = dp(8);
        deadzonePanel.addView(healthCard, healthLayout);
        vehicleHealth = dashboardText(healthCard, 20, true);
        healthMeter = new android.widget.ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        healthMeter.setProgressTintList(android.content.res.ColorStateList.valueOf(Game.DEADZONE.accent));
        healthMeter.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(0xff4d3243));
        healthMeter.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        healthCard.addView(healthMeter, new LinearLayout.LayoutParams(-1, dp(14)));
        ranking = column();
        deadzonePanel.addView(ranking);
        deadzoneStart = new Button(this);
        deadzoneStart.setText("게임 열기");
        deadzoneStart.setMinHeight(dp(48));
        deadzoneStart.setTextSize(16);
        styleVehicleButton(deadzoneStart);
        deadzoneStart.setOnClickListener(view -> syncDeadzone(true));
        deadzonePanel.addView(deadzoneStart);
        repairVehicle = new Button(this);
        repairVehicle.setText("보급품 1개로 차량 수리");
        styleVehicleButton(repairVehicle);
        repairVehicle.setVisibility(android.view.View.GONE);
        repairVehicle.setOnClickListener(view -> syncDeadzone(false, true));
        deadzonePanel.addView(repairVehicle);
        leaveBoard = new Button(this);
        leaveBoard.setText("‹  게임 선택");
        styleVehicleButton(leaveBoard, false);
        leaveBoard.setOnClickListener(view -> {
            repairQueued = false;
            deadzonePolling = false;
            repairVehicle.setVisibility(android.view.View.GONE);
            focusMatch(false);
            resetMatchBoard();
            resetGameEffects();
            updateGameVisibility();
        });
        deadzonePanel.addView(leaveBoard);
        ambientObservation = new TextView(this);
        if (showVehicleDiagnostics()) deadzonePanel.addView(ambientObservation);
        resetMatchBoard();
    }

    private void openCabinPanel() {
        if (!foreground || !localAllowed || cabinDialog != null) return;
        boolean debug = (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        cabinPanel = new CabinPanel(this, debug);
        android.widget.ScrollView scroll = new android.widget.ScrollView(this);
        scroll.addView(cabinPanel);
        cabinDialog = new android.app.AlertDialog.Builder(this)
                .setTitle("차량 상태")
                .setView(scroll)
                .setPositiveButton("닫기", null)
                .create();
        cabinDialog.setOnDismissListener(dialog -> { cabinPanel = null; cabinDialog = null; });
        updateCabinPanel();
        cabinDialog.show();
        if (cabinDialog.getWindow() != null) {
            android.graphics.drawable.GradientDrawable surface = new android.graphics.drawable.GradientDrawable();
            surface.setColor(0xff151827);
            surface.setCornerRadius(dp(20));
            cabinDialog.getWindow().setBackgroundDrawable(surface);
            cabinDialog.getWindow().setDimAmount(.38f);
            int width = Math.min(dp(880), arcadeViewport.getWidth() - dp(32));
            cabinDialog.getWindow().setLayout(width, -2);
        }
        cabinDialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setTextColor(0xffb5bcff);
    }

    private void updateCabinPanel() {
        if (!foreground || cabinButton == null) return;
        JSONObject cabin = NavigationRelayService.cabin();
        String buttonLabel = CabinPanel.buttonLabel(cabin);
        if (!buttonLabel.contentEquals(cabinButton.getText())) cabinButton.setText(buttonLabel);
        String effects = CabinPanel.effectStatus(cabin);
        if (!effects.contentEquals(cabinSummary.getText())) cabinSummary.setText(effects);
        if (cabinPanel != null)
            cabinPanel.update(latestVehicle, cabin, navigationState, probe == null ? null : probe.rangeMeters());
    }

    private void openGameSettings() {
        if (!foreground || !localAllowed || settingsDialog != null) return;
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(24), dp(12), dp(24), dp(16));
        android.widget.Switch lights = new android.widget.Switch(this);
        lights.setText("차량 조명·송풍 효과");
        lights.setTextSize(20);
        lights.setMinHeight(dp(56));
        lights.setChecked(ambientEnabled);
        lights.setOnCheckedChangeListener((view, enabled) -> {
            ambientEnabled = enabled && foreground && localAllowed;
            if (!ambientEnabled) {
                if (ambient != null) ambient.stop();
                if (venueCabinEffects != null) venueCabinEffects.stop();
            }
        });
        content.addView(lights);
        dashboardText(content, 16, false).setText(
                "주차 중 전기도둑 사건에는 조명과 송풍 단계가, DEADZONE 웨이브 완료에는 조명이 잠깐 반응해요.");
        settingsDialog = new android.app.AlertDialog.Builder(this)
                .setTitle("게임 설정")
                .setView(content)
                .setPositiveButton("닫기", null)
                .create();
        settingsDialog.setOnDismissListener(dialog -> settingsDialog = null);
        settingsDialog.show();
    }

    private void resetGameEffects() {
        ambientEnabled = false;
        if (ambient != null) ambient.stop();
        if (venueCabinEffects != null) venueCabinEffects.stop();
        if (settingsDialog != null) settingsDialog.dismiss();
    }

    private LinearLayout column() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        return view;
    }

    private Drawable cover(Game game) {
        return new GameCover(this, game.art, game.accent, dp(20));
    }

    private void sizeLobbyCover(View cover) {
        cover.setMinimumHeight(dp(200));
        arcadeViewport.addOnLayoutChangeListener((view, left, top, right, bottom,
                                                   oldLeft, oldTop, oldRight, oldBottom) -> {
            int paneHeight = bottom - top;
            int height = Math.max(dp(200), Math.min(paneHeight * 56 / 100, paneHeight - dp(320)));
            if (cover.getMinimumHeight() != height) cover.setMinimumHeight(height);
        });
    }

    private void addGameCard(LinearLayout row, Game game, boolean horizontal,
                             boolean second, Runnable open) {
        LinearLayout card = column();
        card.setMinimumHeight(dp(horizontal ? 248 : 152));
        if (!horizontal) {
            card.addOnLayoutChangeListener((view, left, top, right, bottom,
                                            oldLeft, oldTop, oldRight, oldBottom) -> {
                int height = Math.max(dp(152), Math.min((right - left) * 9 / 16,
                        arcadeViewport.getHeight() * 40 / 100));
                if (card.getMinimumHeight() != height) card.setMinimumHeight(height);
            });
        }
        card.setGravity(Gravity.BOTTOM);
        card.setPadding(dp(24), dp(12), dp(20), dp(20));
        card.setBackground(cover(game));
        dashboardText(card, 30, true).setText(game.title);
        dashboardText(card, 18, false).setText(game.description);
        TextView select = dashboardText(card, 17, true);
        select.setText("로비 열기  ›");
        select.setTextColor(game.accent);
        card.setContentDescription(game.title + " 로비 열기");
        card.setFocusable(true);
        card.setOnClickListener(view -> open.run());
        android.util.TypedValue focus = new android.util.TypedValue();
        getTheme().resolveAttribute(android.R.attr.selectableItemBackground, focus, true);
        if (focus.resourceId != 0) card.setForeground(getDrawable(focus.resourceId));
        LinearLayout.LayoutParams layout = horizontal
                ? new LinearLayout.LayoutParams(0, -2, 1)
                : new LinearLayout.LayoutParams(-1, -2);
        layout.topMargin = dp(8);
        if (horizontal && second) layout.setMarginStart(dp(12));
        row.addView(card, layout);
    }

    private LinearLayout seatStrip(LinearLayout container) {
        LinearLayout seats = new LinearLayout(this);
        boolean wide = getResources().getConfiguration().screenWidthDp >= 540;
        seats.setOrientation(wide ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        for (int index = 0; index < SEATS.length; index++) {
            LinearLayout tile = column();
            tile.setPadding(dp(16), dp(10), dp(16), dp(10));
            styleVehicleCard(tile, 0xff191d31);
            LinearLayout.LayoutParams layout = wide ? new LinearLayout.LayoutParams(0, -2, 1)
                    : new LinearLayout.LayoutParams(-1, -2);
            layout.topMargin = dp(8);
            if (wide && index > 0) layout.setMarginStart(dp(8));
            seats.addView(tile, layout);
            dashboardText(tile, 15, false).setText(SEAT_NAMES[index]);
            TextView label = dashboardText(tile, 19, true);
            label.setSingleLine(true);
            label.setEllipsize(android.text.TextUtils.TruncateAt.END);
        }
        container.addView(seats);
        return seats;
    }

    private JSONObject gamePlayer(JSONObject game, String id) {
        org.json.JSONArray players = game == null ? null : game.optJSONArray("players");
        if (players == null) return null;
        for (int index = 0; index < players.length(); index++) {
            JSONObject player = players.optJSONObject(index);
            if (player != null && id.equals(player.optString("id"))) return player;
        }
        return null;
    }

    private void updateSeats(LinearLayout seats, JSONObject game, boolean briefing) {
        for (int index = 0; index < SEATS.length; index++) {
            TextView label = (TextView) ((LinearLayout) seats.getChildAt(index)).getChildAt(1);
            JSONObject member = seatMember(SEATS[index]);
            String message = "빈 좌석";
            int color = 0xffa5acc9;
            if (member != null) {
                JSONObject player = gamePlayer(game, member.optString("memberId"));
                String state;
                if (!member.optBoolean("approved")) state = "승인 대기";
                else if (!member.optBoolean("connected")) state = "연결 끊김";
                else if (game != null && player == null) state = "미참가";
                else {
                    state = briefing ? (player != null && player.optBoolean("done") ? "준비 완료" : "준비 중") : "연결됨";
                    color = 0xffa8efce;
                }
                message = member.optString("nickname") + " · " + state;
            }
            if (!message.contentEquals(label.getText())) label.setText(message);
            label.setTextColor(color);
        }
    }

    private TextView dashboardText(LinearLayout panel, int size, boolean heading) {
        TextView text = new TextView(this);
        text.setTextSize(size);
        text.setTextColor(heading ? 0xfff5f7ff : 0xffc3c9e0);
        text.setPadding(0, dp(4), 0, dp(4));
        if (heading) text.setTypeface(null, android.graphics.Typeface.BOLD);
        panel.addView(text);
        return text;
    }

    private void resetMatchBoard() {
        leaderboard.setText(Game.DEADZONE.title);
        matchSummary.setText(Game.DEADZONE.description);
        deadzoneStart.setVisibility(View.VISIBLE);
        deadzoneSeats.setVisibility(View.VISIBLE);
        ranking.setVisibility(View.GONE);
        ranking.removeAllViews();
        vehicleHealth.setText("");
        healthCard.setVisibility(View.GONE);
    }

    private void updateRanking(java.util.List<JSONObject> players) {
        if (players.isEmpty()) {
            ranking.removeAllViews();
            matchSummary.setText("동승자의 참가를 기다리는 중");
        }
        while (ranking.getChildCount() > players.size()) {
            ranking.removeViewAt(ranking.getChildCount() - 1);
        }
        int rank = 1;
        for (int i = 0; i < players.size(); i++) {
            JSONObject player = players.get(i);
            LinearLayout row = (LinearLayout) ranking.getChildAt(i);
            if (row == null) {
                row = new LinearLayout(this);
                row.setGravity(android.view.Gravity.CENTER_VERTICAL);
                row.setPadding(dp(14), dp(6), dp(14), dp(6));
                styleVehicleCard(row, 0xff191d31);
                LinearLayout.LayoutParams spacing = new LinearLayout.LayoutParams(-1, -2);
                spacing.bottomMargin = dp(6);
                ranking.addView(row, spacing);
                TextView name = dashboardText(row, 20, true);
                name.setMaxLines(1);
                name.setEllipsize(android.text.TextUtils.TruncateAt.END);
                name.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
                dashboardText(row, 20, false);
            }
            if (i > 0 && player.optInt("score") != players.get(i - 1).optInt("score")) rank = i + 1;
            ((TextView) row.getChildAt(0)).setText(rank + "    " + player.optString("name"));
            ((TextView) row.getChildAt(1)).setText(player.optInt("score") + "점");
        }
    }
    private TextView ambientObservation;
    private void addNavigationControls(LinearLayout container){
        navigationLabel=new TextView(this);navigationLabel.setText("Pleos Navi SDK 연결 대기");container.addView(navigationLabel);
        Button permission=new Button(this);permission.setText("내비 SDK 권한 요청");permission.setOnClickListener(v->requestPermissions(new String[]{"pleos.car.permission.NAVI_ROUTE","pleos.car.permission.NAVI_ROUTE_SEARCH","android.permission.ACCESS_FINE_LOCATION","android.permission.ACCESS_COARSE_LOCATION"},102));container.addView(permission);
        String[] names={"여의도 동쪽 목적지 (실제 내비)","여의도 서쪽 목적지 (실제 내비)"};
        for(int n=0;n<2;n++){final int index=n;Button b=new Button(this);b.setText(names[n]);b.setOnClickListener(v->{if(localAllowed){NavigationRelayService.destination(index==0?37.532:37.529,index==0?126.932:126.910,names[index]);}});container.addView(b);}
        Button reroute=new Button(this);reroute.setText("실제 내비 재탐색");reroute.setOnClickListener(v->{if(localAllowed)NavigationRelayService.reroute();});container.addView(reroute);
        Button cancel=new Button(this);cancel.setText("실제 내비 안내 취소");cancel.setOnClickListener(v->{if(localAllowed)NavigationRelayService.cancel();});container.addView(cancel);
    }
    @Override protected void onVehicleForegroundChanged(boolean value){
        if (!value && destinationDialog != null) destinationDialog.dismiss();
        NavigationRelayService.setUiForeground(value);
        NavigationRelayService.watchCabin(value ? this::updateCabinPanel : null);
        updateArcadeVisibility();
        if(!value)resetGameEffects();
    }
    @Override protected void inspectExtraDiagnostics(){if(probe!=null)probe.inspectCabin();}
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results){super.onRequestPermissionsResult(code,permissions,results);if(probe!=null)probe.refresh();NavigationRelayService.enableGnss();}
    @Override protected RoomClient retainedClient(){return NavigationRelayService.sharedClient();}
    @Override protected boolean retainClientOnDestroy(){return NavigationRelayService.detach(client);}
    @Override protected void onRoomData(JSONObject value){NavigationRelayService.attach(client,value);}
    @Override protected void onDestroy(){super.onDestroy();}
}

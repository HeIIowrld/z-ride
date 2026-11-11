package ai.zride.demo.car;

import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

final class CabinPanel extends LinearLayout {
    private static final String[] SEATS = {"DRIVER", "FRONT_PASSENGER", "REAR_LEFT", "REAR_RIGHT"};
    private static final String[] AREAS = {"ROW_1_LEFT", "ROW_1_RIGHT", "ROW_2_LEFT", "ROW_2_RIGHT"};
    private static final String[] NAMES = {"운전석", "조수석", "뒷좌석 왼쪽", "뒷좌석 오른쪽"};
    private static final int MUTED = 0xffc3c9e0;
    private static final int OPEN = 0xffffb16e;
    private final TextView[] occupancy = new TextView[4];
    private final TextView[] openings = new TextView[4];
    private final TextView trip, climate, closures;
    private final boolean emulatorSeats;

    CabinPanel(Context context, boolean debug) {
        super(context);
        setOrientation(VERTICAL);
        setPadding(dp(24), dp(8), dp(24), dp(20));
        // Vehicle SDK 2.3.2 returns the vacant enum as true on this emulator image.
        emulatorSeats = debug && "crp_avd_x86_64".equals(Build.DEVICE)
                && "release_connect_v2.1.0".equals(Build.VERSION.INCREMENTAL);
        trip = label(this, 20, true);
        for (int row = 0; row < 2; row++) {
            LinearLayout pair = new LinearLayout(context);
            addView(pair, new LayoutParams(-1, -2));
            for (int column = 0; column < 2; column++) {
                int index = row * 2 + column;
                LinearLayout tile = new LinearLayout(context);
                tile.setOrientation(VERTICAL);
                tile.setPadding(dp(16), dp(10), dp(16), dp(10));
                GradientDrawable surface = new GradientDrawable();
                surface.setColor(0xff22263b);
                surface.setCornerRadius(dp(12));
                tile.setBackground(surface);
                LayoutParams layout = new LayoutParams(0, -2, 1);
                layout.topMargin = dp(8);
                if (column == 1) layout.setMarginStart(dp(8));
                pair.addView(tile, layout);
                label(tile, 16, true).setText(NAMES[index]);
                occupancy[index] = label(tile, 20, true);
                openings[index] = label(tile, 16, false);
            }
        }
        closures = label(this, 18, true);
        climate = label(this, 17, false);
    }

    void update(JSONObject vehicle, JSONObject cabin, JSONObject navigation, Float rangeMeters) {
        for (int index = 0; index < SEATS.length; index++) {
            String area = AREAS[index];
            String seat = seatStatus(vehicle, SEATS[index]);
            Object belt = signal(cabin, "seatbelt", area);
            occupancy[index].setText(seat + "  ·  벨트 " + (belt instanceof Boolean
                    ? ((Boolean) belt ? "착용" : "미착용") : "미수신"));
            occupancy[index].setTextColor("착석".equals(seat) ? 0xffa8efce : MUTED);
            Object door = signal(cabin, "door.position", area);
            Object window = signal(cabin, "window.position", area);
            openings[index].setText("문 " + opening(door) + "  ·  창문 " + opening(window));
            openings[index].setTextColor(isOpen(door) || isOpen(window) ? OPEN : MUTED);
        }
        Object hood = signal(cabin, "door.position", "HOOD");
        Object trunk = signal(cabin, "door.position", "REAR");
        closures.setText("보닛 " + opening(hood) + "  ·  트렁크 " + opening(trunk));
        closures.setTextColor(isOpen(hood) || isOpen(trunk) ? OPEN : MUTED);
        JSONObject charge = vehicle.optJSONObject("charge");
        Object soc = charge == null ? null : charge.opt("socPercent");
        String charging = "";
        if (charge != null) {
            if ("CHARGING".equals(charge.optString("state"))) charging = " · 충전 중";
            else if ("CONNECTED".equals(charge.optString("portConnection"))) charging = " · 충전기 연결";
        }
        climate.setText("배터리 " + reading(soc, "%") + charging + "  ·  " + effectStatus(cabin));
        String gear = vehicle.optString("gear", "UNKNOWN");
        String speed = vehicle.opt("speedMps") instanceof Number
                ? Math.round(vehicle.optDouble("speedMps") * 3.6) + " km/h" : "미수신";
        String routeStatus = navigation == null ? "" : navigation.optString("status");
        String destination = "안내 전";
        if ("ARRIVED".equals(routeStatus)) destination = "도착";
        else if ("ROUTE_DRIVE".equals(routeStatus) || "ROUTE_READY".equals(routeStatus))
            destination = distance(navigation.opt("remainingDistanceM"));
        String waypoint = navigation == null || navigation.isNull("nextWaypoint")
                ? "" : navigation.optString("nextWaypoint", "");
        String passed = navigation == null || navigation.isNull("arrivedWaypoint")
                ? "" : navigation.optString("arrivedWaypoint", "");
        String via = !waypoint.isEmpty() ? "\n경유지 " + waypoint + " · " + distance(navigation.opt("nextWaypointDistanceM"))
                : !passed.isEmpty() ? "\n경유지 도착 · " + passed : "";
        trip.setText(("UNKNOWN".equals(gear) ? "기어 미수신" : gear) + "  ·  속도 " + speed
                + "  ·  주행 가능 " + distance(rangeMeters)
                + "  ·  목적지 " + destination + via);
    }

    static String effectStatus(JSONObject cabin) {
        Object fan = signal(cabin, "hvac.fanSpeed", "ROW_1_LEFT, ROW_1_RIGHT");
        Object power = signal(cabin, "hvac.power", "ROW_1_LEFT, ROW_1_RIGHT, ROW_2_LEFT, ROW_2_CENTER, ROW_2_RIGHT");
        Object light = signal(cabin, "ambient.brightness", "ROW_1_LEFT, ROW_1_RIGHT, ROW_2_LEFT, ROW_2_CENTER, ROW_2_RIGHT");
        String airflow = (Boolean.TRUE.equals(power) ? "송풍 " : "송풍 설정 ") + reading(fan, "단");
        if (Boolean.FALSE.equals(power)) airflow = "공조 꺼짐  ·  " + airflow;
        return airflow + "  ·  실내 조명 밝기 " + reading(light, "%");
    }

    private String seatStatus(JSONObject vehicle, String name) {
        JSONArray seats = vehicle.optJSONArray("seats");
        if (seats != null) for (int index = 0; index < seats.length(); index++) {
            JSONObject seat = seats.optJSONObject(index);
            if (seat != null && name.equals(seat.optString("seat"))) {
                String occupancy = seat.optString("occupancy");
                if ("OCCUPIED".equals(occupancy)) return "착석";
                if ("EMPTY".equals(occupancy)) return "빈 좌석";
                break;
            }
        }
        JSONObject raw = vehicle.optJSONObject("rawSdkSeatOccupied");
        if (emulatorSeats && raw != null && raw.opt(name) instanceof Boolean)
            return raw.optBoolean(name) ? "빈 좌석" : "착석";
        return "착석 미수신";
    }

    static String buttonLabel(JSONObject cabin) {
        int doors = 0;
        for (String area : AREAS) if (isOpen(signal(cabin, "door.position", area))) doors++;
        boolean hood = isOpen(signal(cabin, "door.position", "HOOD"));
        boolean trunk = isOpen(signal(cabin, "door.position", "REAR"));
        if (doors > 0) return "차량 상태 · 문 " + doors + "개 열림";
        if (hood && trunk) return "차량 상태 · 보닛·트렁크 열림";
        if (hood || trunk) return "차량 상태 · " + (hood ? "보닛" : "트렁크") + " 열림";
        return "차량 상태";
    }

    private static Object signal(JSONObject cabin, String feature, String area) {
        JSONObject item = cabin == null ? null : cabin.optJSONObject(feature + " / [" + area + "]");
        return item == null || "ERROR".equals(item.optString("kind")) ? null : item.opt("value");
    }

    private static boolean isOpen(Object value) { return value instanceof Number && ((Number) value).intValue() > 0; }
    private static String opening(Object value) {
        if (!(value instanceof Number) || ((Number) value).intValue() < 0) return "미수신";
        return isOpen(value) ? "열림" : "닫힘";
    }
    private static String reading(Object value, String unit) { return value instanceof Number ? value + unit : "미수신"; }
    private static String distance(Object meters) {
        if (!(meters instanceof Number) || ((Number) meters).doubleValue() < 0) return "미수신";
        double value = ((Number) meters).doubleValue();
        return value >= 1000 ? String.format(Locale.KOREA, "%,.1f km", value / 1000) : Math.round(value) + " m";
    }
    private int dp(int value) { return Math.round(getResources().getDisplayMetrics().density * value); }
    private TextView label(LinearLayout parent, int size, boolean bold) {
        TextView text = new TextView(getContext());
        text.setTextSize(size);
        text.setTextColor(bold ? 0xfff5f7ff : MUTED);
        text.setPadding(0, dp(4), 0, dp(4));
        if (bold) text.setTypeface(null, Typeface.BOLD);
        parent.addView(text);
        return text;
    }
}

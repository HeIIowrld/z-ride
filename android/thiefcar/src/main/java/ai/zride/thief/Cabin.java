package ai.zride.thief;

import android.content.SharedPreferences;
import android.os.Handler;
import android.util.Log;
import ai.pleos.playground.vehicle.Vehicle;
import ai.pleos.playground.vehicle.api.HVAC;
import ai.pleos.playground.vehicle.api.Light;
import ai.pleos.playground.vehicle.api.model.area.SeatArea;
import ai.pleos.playground.vehicle.constant.unit.TemperatureUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import kotlin.Unit;

/**
 * 게임의 cabin 값을 차 실내에 적용한다. 무드등과 설정 온도만 바꾸고,
 * 처음 값을 기억했다가 NORMAL이 오거나 앱이 물러나면 되돌린다.
 * 두 좌석에 온도를 연달아 보내면 성공 응답이 와도 한쪽이 안 바뀔 수 있어서,
 * 좌석을 차례로 보내고 다시 읽어 맞을 때까지 재시도한다.
 * 게임 중 앱이 죽어도 사용자 설정을 잃지 않게 처음 값을 저장해 두고, 다음 실행 때 되돌린다.
 */
final class Cabin {
    private static final String TAG = "ZRideThief";
    private static final int ALERT_BRIGHTNESS = 100;
    private static final float COLD_CELSIUS = 16f;
    private static final int STEP_MS = 400, MAX_TRIES = 6;
    private final Light light;
    private final HVAC hvac;
    private final int alertColor;
    private final Handler car;
    private final SharedPreferences saved;
    private int climateRun;
    private final Map<SeatArea, Integer> brightness = new HashMap<>(), color = new HashMap<>();
    private final Map<SeatArea, Float> temperature = new HashMap<>();
    private String lightMode = "NORMAL", climateMode = "NORMAL";

    Cabin(Vehicle vehicle, int alertColor, Handler car, SharedPreferences saved) {
        light = vehicle.getLight(); hvac = vehicle.getHVAC();
        this.alertColor = alertColor; this.car = car; this.saved = saved;
    }

    /** 게임을 바꾸기 전 원래 값을 읽어 둔다. */
    void remember() {
        if (!lightMode.equals("NORMAL") || !climateMode.equals("NORMAL")) return; // 바뀐 값을 원래 값으로 착각하지 않는다
        light.checkAmbientLightBrightnessCapabilities((cap, ranges) -> {
            for (SeatArea area : ranges.keySet()) light.getAmbientLightBrightness(area, v -> { brightness.put(area, saved.getInt(key("b", area), v)); return Unit.INSTANCE; }, this::failed);
            return Unit.INSTANCE;
        }, this::failed);
        light.checkAmbientLightBrightnessColorCapabilities((cap, areas) -> {
            for (SeatArea area : areas) light.getAmbientLightBrightnessColor(area, v -> { color.put(area, saved.getInt(key("c", area), v)); return Unit.INSTANCE; }, this::failed);
            return Unit.INSTANCE;
        }, this::failed);
        hvac.checkHvacTemperatureCapabilities((cap, ranges, conversion) -> {
            for (SeatArea area : ranges.keySet()) hvac.getHvacTemperature(area, TemperatureUnit.CELSIUS, v -> { temperature.put(area, saved.getFloat(key("t", area), v)); return Unit.INSTANCE; }, this::failed);
            return Unit.INSTANCE;
        }, this::failed);
        if (saved.getBoolean("dirty", false)) car.postDelayed(this::recover, 1500);
    }

    /** 지난번에 복구하지 못하고 끝났으면 저장한 값으로 되돌린다. */
    private void recover() {
        if (!"NORMAL".equals(lightMode) || !"NORMAL".equals(climateMode)) return;
        Log.i(TAG, "recovering cabin");
        applyLight(); applyClimate();
    }

    private void keepOriginals() {
        if (saved.getBoolean("dirty", false)) return;
        SharedPreferences.Editor edit = saved.edit().putBoolean("dirty", true);
        brightness.forEach((area, v) -> edit.putInt(key("b", area), v));
        color.forEach((area, v) -> edit.putInt(key("c", area), v));
        temperature.forEach((area, v) -> edit.putFloat(key("t", area), v));
        edit.commit();
    }

    void apply(String nextLight, String nextClimate) {
        if (!"NORMAL".equals(nextLight) || !"NORMAL".equals(nextClimate)) keepOriginals();
        if (!nextLight.equals(lightMode)) { lightMode = nextLight; applyLight(); }
        if (!nextClimate.equals(climateMode)) { climateMode = nextClimate; applyClimate(); }
    }

    void restore() { apply("NORMAL", "NORMAL"); }

    private void applyLight() {
        Log.i(TAG, "light " + lightMode);
        for (Map.Entry<SeatArea, Integer> e : brightness.entrySet()) {
            int value = "OFF".equals(lightMode) ? 0 : "RED".equals(lightMode) ? ALERT_BRIGHTNESS : e.getValue();
            light.setAmbientLightBrightness(e.getKey(), value, (a, v) -> Unit.INSTANCE, this::failed);
        }
        for (Map.Entry<SeatArea, Integer> e : color.entrySet()) {
            int value = "RED".equals(lightMode) ? alertColor : e.getValue();
            light.setAmbientLightBrightnessColor(e.getKey(), value, (a, v) -> Unit.INSTANCE, this::failed);
        }
    }

    private float climateTarget(float original) { return "COLD".equals(climateMode) ? COLD_CELSIUS : original; }

    private void applyClimate() {
        Log.i(TAG, "climate " + climateMode);
        settleClimate(++climateRun, new ArrayList<>(temperature.keySet()), 0, 1);
    }

    /** 좌석을 하나씩 맞춘다. 새 명령이 오면(run이 바뀌면) 멈춘다. */
    private void settleClimate(int run, List<SeatArea> areas, int index, int tries) {
        if (run != climateRun) return;
        if (index >= areas.size()) {
            Log.i(TAG, "climate settled " + climateMode);
            if ("NORMAL".equals(lightMode) && "NORMAL".equals(climateMode) && !areas.isEmpty()) saved.edit().clear().commit();
            return;
        }
        SeatArea area = areas.get(index);
        float target = climateTarget(temperature.get(area));
        hvac.getHvacTemperature(area, TemperatureUnit.CELSIUS, value -> {
            car.post(() -> {
                if (Math.abs(value - target) < 0.1f) { settleClimate(run, areas, index + 1, 1); return; }
                if (tries > MAX_TRIES) { Log.w(TAG, "climate not settled"); settleClimate(run, areas, index + 1, 1); return; }
                hvac.setHvacTemperature(area, target, TemperatureUnit.CELSIUS, (a, v) -> Unit.INSTANCE, this::failed);
                car.postDelayed(() -> settleClimate(run, areas, index, tries + 1), STEP_MS);
            });
            return Unit.INSTANCE;
        }, this::failed);
    }

    /** SeatArea의 hashCode는 실행마다 달라서 좌석 값으로 저장 키를 만든다. */
    private static String key(String prefix, SeatArea area) { return prefix + Arrays.toString(area.getValues()); }

    private Unit failed(Exception error) { Log.w(TAG, "cabin: " + error); return Unit.INSTANCE; }
}

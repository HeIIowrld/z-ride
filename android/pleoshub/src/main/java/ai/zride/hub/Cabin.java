package ai.zride.hub;

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
import java.util.concurrent.ConcurrentHashMap;
import java.util.List;
import java.util.Map;
import kotlin.Unit;

/**
 * 게임의 cabin 값을 차 실내에 적용한다. 무드등, 바람세기, 설정 온도만 바꾸고,
 * 처음 값을 기억했다가 NORMAL이 오거나 앱이 물러나면 되돌린다.
 * 바람과 온도는 공조가 켜져 있는 좌석에만 적용하고, 공조를 새로 켜지 않는다.
 * 온도는 원래 값에서 3°만 움직이고, 바람 GUST는 몇 초만 세게 틀었다가 원래 세기로 돌아간다(충전 중 전력 부담을 줄인다).
 * 두 좌석에 온도를 연달아 보내면 성공 응답이 와도 한쪽이 안 바뀔 수 있어서,
 * 좌석을 차례로 보내고 다시 읽어 맞을 때까지 재시도한다.
 * 게임 중 앱이 죽어도 사용자 설정을 잃지 않게 처음 값을 저장해 두고, 다음 실행 때 되돌린다.
 */
final class Cabin {
    private static final String TAG = "ZRideHub";
    private static final int ALERT_BRIGHTNESS = 100;
    private static final float CLIMATE_STEP = 3f, MIN_CELSIUS = 16f, MAX_CELSIUS = 30f;
    private static final int GUST_MS = 4000;
    /** 게임이 고를 수 있는 무드등 색(RGB). NORMAL은 원래 값, OFF는 밝기 0. */
    static final Map<String, Integer> COLORS = Map.of("RED", 0xFF2020, "BLUE", 0x2060FF, "GREEN", 0x20E060, "YELLOW", 0xFFD020, "PURPLE", 0xA040FF);
    static final List<String> LIGHTS = List.of("NORMAL", "OFF", "RED", "BLUE", "GREEN", "YELLOW", "PURPLE");
    static final List<String> CLIMATES = List.of("NORMAL", "COLD", "WARM");
    /** 바람: LOW는 가장 약하게(정전 느낌), GUST는 몇 초 동안 가장 세게. */
    static final List<String> AIRS = List.of("NORMAL", "LOW", "GUST");
    private static final int STEP_MS = 400, MAX_TRIES = 6;
    private final Light light;
    private final HVAC hvac;
    private final Handler car;
    private final SharedPreferences saved;
    private int climateRun, airRun;
    private boolean climateBusy;
    private final Map<SeatArea, Integer> brightness = new ConcurrentHashMap<>(), color = new ConcurrentHashMap<>();
    private final Map<SeatArea, Float> temperature = new ConcurrentHashMap<>();
    private final Map<SeatArea, Integer> fan = new ConcurrentHashMap<>(), fanMin = new ConcurrentHashMap<>(), fanMax = new ConcurrentHashMap<>();
    private final Map<SeatArea, Boolean> auto = new ConcurrentHashMap<>();
    /** 공조 전원. 바람세기 좌석과 전원 좌석이 다를 수 있어 따로 읽는다. 못 읽으면 null(바람세기 > 0이면 켜진 것으로 본다). */
    private volatile Boolean hvacOn;
    private String lightMode = "NORMAL", climateMode = "NORMAL", airMode = "NORMAL";

    private boolean normal() { return "NORMAL".equals(lightMode) && "NORMAL".equals(climateMode) && "NORMAL".equals(airMode); }

    Cabin(Vehicle vehicle, Handler car, SharedPreferences saved) {
        light = vehicle.getLight(); hvac = vehicle.getHVAC();
        this.car = car; this.saved = saved;
    }

    private boolean recoverChecked;

    /** 게임을 바꾸기 전 원래 값을 읽어 둔다. */
    void remember() {
        if (!normal()) return; // 바뀐 값을 원래 값으로 착각하지 않는다
        read(false);
    }

    /**
     * onlyMissing이면 아직 못 읽은 좌석만 읽는다. 못 읽은 좌석은 게임이 건드리지 않았으므로
     * 게임 중에 읽어도 원래 값이다.
     */
    private void read(boolean onlyMissing) {
        light.checkAmbientLightBrightnessCapabilities((cap, ranges) -> {
            for (SeatArea area : ranges.keySet()) if (!onlyMissing || !has(brightness, area)) light.getAmbientLightBrightness(area, v -> { put(brightness, area, saved.getInt(key("b", area), v)); return Unit.INSTANCE; }, this::failed);
            return Unit.INSTANCE;
        }, this::failed);
        light.checkAmbientLightBrightnessColorCapabilities((cap, areas) -> {
            for (SeatArea area : areas) if (!onlyMissing || !has(color, area)) light.getAmbientLightBrightnessColor(area, v -> { put(color, area, saved.getInt(key("c", area), v)); return Unit.INSTANCE; }, this::failed);
            return Unit.INSTANCE;
        }, this::failed);
        hvac.checkHvacTemperatureCapabilities((cap, ranges, conversion) -> {
            for (SeatArea area : ranges.keySet()) if (!onlyMissing || !has(temperature, area)) hvac.getHvacTemperature(area, TemperatureUnit.CELSIUS, v -> { put(temperature, area, saved.getFloat(key("t", area), v)); return Unit.INSTANCE; }, this::failed);
            return Unit.INSTANCE;
        }, this::failed);
        hvac.checkHvacFanSpeedCapabilities((cap, bounds) -> {
            for (Map.Entry<SeatArea, ai.pleos.playground.vehicle.api.model.capability.AreaBounds<Integer>> e : bounds.entrySet()) {
                SeatArea area = e.getKey();
                put(fanMin, area, e.getValue().getMinValue()); put(fanMax, area, e.getValue().getMaxValue());
                if (onlyMissing && has(fan, area)) continue;
                hvac.getHvacFanSpeed(area, v -> { put(fan, area, saved.getInt(key("f", area), v)); return Unit.INSTANCE; }, this::failed);
                hvac.getHvacAutoState(area, v -> { put(auto, area, saved.contains(key("a", area)) ? saved.getBoolean(key("a", area), v) : v); return Unit.INSTANCE; }, this::failed);
            }
            return Unit.INSTANCE;
        }, this::failed);
        hvac.checkHvacPowerCapabilities((cap, areas) -> {
            java.util.concurrent.atomic.AtomicBoolean any = new java.util.concurrent.atomic.AtomicBoolean(false);
            for (SeatArea area : areas) hvac.getHvacPowerState(area, v -> { if (v) any.set(true); hvacOn = any.get(); return Unit.INSTANCE; }, this::failed);
            return Unit.INSTANCE;
        }, this::failed);
        if (!recoverChecked && saved.getBoolean("dirty", false)) car.postDelayed(this::recover, 1500);
        recoverChecked = true;
    }

    /**
     * 2초마다 부른다. 게임이 차를 건드리지 않은 동안에는 사용자가 바꾼 값을 원래 값으로 계속 따라가고,
     * 건드린 뒤에는 처음에 못 읽은 좌석(공조가 꺼져 있던 경우 등)만 채운다.
     */
    void refresh() {
        if (normal() && !saved.getBoolean("dirty", false)) read(false);
        else if (temperature.isEmpty() || brightness.isEmpty() || color.isEmpty() || fan.isEmpty()) read(true);
    }

    /** 지난번에 복구하지 못하고 끝났으면 저장한 값으로 되돌린다. */
    private void recover() {
        if (!normal()) return;
        Log.i(TAG, "recovering cabin");
        applyLight(); applyClimate(); applyAir();
    }

    /** 바꾸기 전 값을 저장한다. 처음엔 못 읽었던 좌석도 나중에 읽히면 그때 채운다(이미 저장한 값은 덮지 않는다). */
    private void keepOriginals() {
        SharedPreferences.Editor edit = saved.edit().putBoolean("dirty", true);
        brightness.forEach((area, v) -> { if (!saved.contains(key("b", area))) edit.putInt(key("b", area), v); });
        color.forEach((area, v) -> { if (!saved.contains(key("c", area))) edit.putInt(key("c", area), v); });
        temperature.forEach((area, v) -> { if (!saved.contains(key("t", area))) edit.putFloat(key("t", area), v); });
        fan.forEach((area, v) -> { if (!saved.contains(key("f", area))) edit.putInt(key("f", area), v); });
        auto.forEach((area, v) -> { if (!saved.contains(key("a", area))) edit.putBoolean(key("a", area), v); });
        edit.commit();
    }

    void apply(String nextLight, String nextClimate, String nextAir) {
        if (!"NORMAL".equals(nextLight) || !"NORMAL".equals(nextClimate) || !"NORMAL".equals(nextAir)) keepOriginals();
        if (!nextLight.equals(lightMode)) { lightMode = nextLight; applyLight(); }
        if (!nextClimate.equals(climateMode)) { climateMode = nextClimate; applyClimate(); }
        if (!nextAir.equals(airMode)) { airMode = nextAir; applyAir(); }
        clearIfNormal();
    }

    void restore() { apply("NORMAL", "NORMAL", "NORMAL"); }

    /** 다 원래대로 돌아갔으면 저장한 원래 값을 지운다(온도는 맞춘 뒤에). */
    private void clearIfNormal() {
        if (normal() && !climateBusy && saved.getBoolean("dirty", false)) car.postDelayed(() -> { if (normal() && !climateBusy) saved.edit().clear().commit(); }, STEP_MS * 2);
    }

    /** 공조가 켜진 좌석만. GUST는 GUST_MS 동안만 세게 틀고 원래 세기로 돌아간다. */
    private void applyAir() {
        Log.i(TAG, "air " + airMode + " fans=" + fan.size() + " hvacOn=" + hvacOn);
        int run = ++airRun;
        for (Map.Entry<SeatArea, Integer> e : fan.entrySet()) {
            SeatArea area = e.getKey();
            if (Boolean.FALSE.equals(hvacOn) || e.getValue() <= 0) continue; // 공조가 꺼져 있으면 건드리지 않는다
            Integer min = get(fanMin, area), max = get(fanMax, area);
            int target = "GUST".equals(airMode) && max != null ? max : "LOW".equals(airMode) && min != null ? Math.max(1, min) : e.getValue();
            setFan(area, target, "NORMAL".equals(airMode));
            if ("GUST".equals(airMode)) car.postDelayed(() -> { if (run == airRun) setFan(area, e.getValue(), true); }, GUST_MS);
        }
    }

    /** 바람세기를 직접 바꾸면 차가 오토를 풀 수 있어서, 원래 오토였으면 되돌릴 때 다시 켠다. */
    private void setFan(SeatArea area, int speed, boolean original) {
        hvac.setHvacFanSpeed(area, speed, (a, v) -> { Log.i(TAG, "fan " + Arrays.toString(a.getValues()) + " -> " + v); return Unit.INSTANCE; }, this::failed);
        if (original && Boolean.TRUE.equals(get(auto, area))) car.postDelayed(() -> hvac.setHvacAuto(area, true, (a, v) -> Unit.INSTANCE, this::failed), STEP_MS);
    }

    private void applyLight() {
        Log.i(TAG, "light " + lightMode);
        for (Map.Entry<SeatArea, Integer> e : brightness.entrySet()) {
            int value = "OFF".equals(lightMode) ? 0 : COLORS.containsKey(lightMode) ? ALERT_BRIGHTNESS : e.getValue();
            light.setAmbientLightBrightness(e.getKey(), value, (a, v) -> Unit.INSTANCE, this::failed);
        }
        for (Map.Entry<SeatArea, Integer> e : color.entrySet()) {
            Integer preset = COLORS.get(lightMode);
            int value = preset != null ? preset : e.getValue();
            light.setAmbientLightBrightnessColor(e.getKey(), value, (a, v) -> Unit.INSTANCE, this::failed);
        }
    }

    private float climateTarget(float original) {
        float step = "COLD".equals(climateMode) ? -CLIMATE_STEP : "WARM".equals(climateMode) ? CLIMATE_STEP : 0f;
        return Math.max(MIN_CELSIUS, Math.min(MAX_CELSIUS, original + step));
    }

    private void applyClimate() {
        Log.i(TAG, "climate " + climateMode);
        climateBusy = true;
        settleClimate(++climateRun, new ArrayList<>(temperature.keySet()), 0, 1);
    }

    /** 좌석을 하나씩 맞춘다. 새 명령이 오면(run이 바뀌면) 멈춘다. */
    private void settleClimate(int run, List<SeatArea> areas, int index, int tries) {
        if (run != climateRun) return;
        if (index >= areas.size()) {
            Log.i(TAG, "climate settled " + climateMode);
            climateBusy = false;
            clearIfNormal();
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

    /** SeatArea는 같은 좌석이어도 객체가 달라서, 같은 좌석 값을 지우고 넣는다. */
    private static <T> void put(Map<SeatArea, T> map, SeatArea area, T value) {
        map.keySet().removeIf(known -> Arrays.equals(known.getValues(), area.getValues()));
        map.put(area, value);
    }

    private static <T> T get(Map<SeatArea, T> map, SeatArea area) {
        for (Map.Entry<SeatArea, T> e : map.entrySet()) if (Arrays.equals(e.getKey().getValues(), area.getValues())) return e.getValue();
        return null;
    }

    private static boolean has(Map<SeatArea, ?> map, SeatArea area) {
        for (SeatArea known : map.keySet()) if (Arrays.equals(known.getValues(), area.getValues())) return true;
        return false;
    }

    /** SeatArea의 hashCode는 실행마다 달라서 좌석 값으로 저장 키를 만든다. */
    private static String key(String prefix, SeatArea area) { return prefix + Arrays.toString(area.getValues()); }

    private Unit failed(Exception error) { Log.w(TAG, "cabin: " + error); return Unit.INSTANCE; }
}

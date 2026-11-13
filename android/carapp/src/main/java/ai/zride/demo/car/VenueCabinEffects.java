package ai.zride.demo.car;

import ai.pleos.playground.vehicle.api.model.area.SeatArea;
import ai.pleos.playground.vehicle.api.model.capability.AccessType;
import ai.pleos.playground.vehicle.api.model.capability.AreaBounds;
import ai.pleos.playground.vehicle.api.model.capability.CapabilityConfig;
import android.os.Handler;
import android.util.Log;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.function.IntBinaryOperator;
import kotlin.Unit;
import kotlin.jvm.functions.Function1;
import kotlin.jvm.functions.Function2;
import org.json.JSONObject;

/** Translates a charging game's public incident to bounded, reversible SDK writes. */
final class VenueCabinEffects {
    interface Observation {
        void accept(String channel, String status, Integer value);
    }

    private final Handler main;
    private final BooleanSupplier allowed;
    private final Observation observation;
    private final Channel light = new Channel("light");
    private final Channel fan = new Channel("fan");
    private String lastIncident = "";

    VenueCabinEffects(Handler main, BooleanSupplier allowed, Observation observation) {
        this.main = main;
        this.allowed = allowed;
        this.observation = observation;
    }

    void update(String room, JSONObject response, VehicleProbe probe) {
        JSONObject game = response.optJSONObject("game");
        JSONObject result = game == null ? null : game.optJSONObject("result");
        JSONObject cabin = game == null ? null : game.optJSONObject("cabin");
        if (!allowed.getAsBoolean() || probe == null || response.optJSONObject("stop") == null
                || !"thief".equals(response.optString("kind")) || result == null || cabin == null
                || !"RESULT".equals(game.optString("phase")) || result.optBoolean("saved")) {
            stop();
            return;
        }
        long deadline = game.optLong("deadline");
        long duration = Math.min(4000, deadline - System.currentTimeMillis());
        String incident = room + "/" + game.optInt("caseNo") + "/" + deadline;
        if (duration < 200 || incident.equals(lastIncident)) return;
        lastIncident = incident;
        var lights = probe.ambientLight();
        String lightCue = cabin.optString("light");
        if (lights != null && ("OFF".equals(lightCue) || "RED".equals(lightCue))) {
            light.start(duration, "OFF".equals(lightCue) ? -1 : 1,
                    lights::checkAmbientLightBrightnessCapabilities, lights::getAmbientLightBrightness,
                    lights::setAmbientLightBrightness, (min, max) -> Math.max(1, (max - min) / 4));
        }
        var hvac = probe.hvac();
        String fanCue = cabin.optString("air");
        if (hvac != null && ("LOW".equals(fanCue) || "GUST".equals(fanCue))) {
            fan.start(duration, "LOW".equals(fanCue) ? -1 : 1,
                    hvac::checkHvacFanSpeedCapabilities, hvac::getHvacFanSpeed,
                    hvac::setHvacFanSpeed, (min, max) -> 1);
        }
    }

    void stop() {
        light.stop();
        fan.stop();
    }

    private interface Capability {
        void read(Function2<CapabilityConfig, Map<SeatArea, AreaBounds<Integer>>, Unit> ok,
                  Function1<Exception, Unit> fail);
    }
    private interface Read {
        void value(SeatArea area, Function1<Integer, Unit> ok, Function1<Exception, Unit> fail);
    }
    private interface Write {
        void value(SeatArea area, int value, Function2<SeatArea, Integer, Unit> ok,
                   Function1<Exception, Unit> fail);
    }

    private Unit dispatch(Runnable action) {
        main.post(action);
        return Unit.INSTANCE;
    }

    private final class Channel {
        final String name;
        Change current;
        Channel(String name) { this.name = name; }

        void start(long duration, int direction, Capability capability, Read read, Write write,
                   IntBinaryOperator step) {
            if (current != null) return;
            Change change = new Change(read, write);
            current = change;
            main.postDelayed(change.expiry, duration);
            capability.read((config, areas) -> dispatch(() -> {
                if (!canApply(change)) return;
                if (config == null || config.getAccessType() != AccessType.READ_WRITE || areas.isEmpty()) {
                    done(change, "UNSUPPORTED", null);
                    return;
                }
                var entry = areas.entrySet().iterator().next();
                change.area = entry.getKey();
                int min = entry.getValue().getMinValue(), max = entry.getValue().getMaxValue();
                read.value(change.area, value -> dispatch(() -> {
                    if (!canApply(change)) return;
                    if (value == null || value < min || value > max || min >= max) {
                        done(change, "UNAVAILABLE", null);
                        return;
                    }
                    change.original = value;
                    change.applied = Math.max(min, Math.min(max, value + direction * step.applyAsInt(min, max)));
                    observe("BASELINE", value);
                    if (change.applied == value) { done(change, "AT_LIMIT", value); return; }
                    change.writing = true;
                    write.value(change.area, change.applied, (area, ignored) -> dispatch(() -> {
                        change.writing = false;
                        if (change.stopping) restore(change);
                        else confirm(change);
                    }), error -> dispatch(() -> {
                        change.writing = false;
                        if (current == change) observe("WRITE_FAILED", null);
                        stop();
                    }));
                }), error -> dispatch(() -> done(change, "READ_FAILED", null)));
            }), error -> dispatch(() -> done(change, "CAPABILITY_FAILED", null)));
        }

        boolean canApply(Change change) {
            return current == change && !change.stopping && allowed.getAsBoolean();
        }

        void confirm(Change change) {
            if (!canApply(change)) return;
            change.read.value(change.area, observed -> dispatch(() -> {
                if (!canApply(change)) return;
                if (Integer.valueOf(change.applied).equals(observed)) {
                    change.confirmed = true;
                    observe("APPLIED", observed);
                } else {
                    main.postDelayed(change.confirmation, 250);
                }
            }), error -> dispatch(() -> {
                if (canApply(change)) main.postDelayed(change.confirmation, 250);
            }));
        }

        void stop() {
            Change change = current;
            if (change == null || change.stopping) return;
            change.stopping = true;
            main.removeCallbacks(change.confirmation);
            if (!change.writing) restore(change);
        }

        void restore(Change change) {
            if (change.original == null) { done(change, "STOPPED", null); return; }
            change.read.value(change.area, value -> dispatch(() -> {
                if (!Integer.valueOf(change.applied).equals(value)) {
                    done(change, change.confirmed ? "UNCHANGED" : "NOT_CONFIRMED", value);
                    return;
                }
                change.write.value(change.area, change.original, (area, ignored) -> dispatch(() ->
                    change.read.value(area, restored -> dispatch(() ->
                        done(change, change.original.equals(restored) ? "RESTORED" : "RESTORE_FAILED", restored)),
                        error -> dispatch(() -> done(change, "RESTORE_FAILED", null)))),
                    error -> dispatch(() -> done(change, "RESTORE_FAILED", null)));
            }), error -> dispatch(() -> done(change, "RESTORE_FAILED", null)));
        }

        void done(Change change, String status, Integer value) {
            if (current != change) return;
            main.removeCallbacks(change.expiry);
            current = null;
            observe(status, value);
        }

        void observe(String status, Integer value) {
            Log.i("ZRideVenueCabin", name + " " + status + (value == null ? "" : " " + value));
            observation.accept(name, status, value);
        }

        final class Change {
            final Read read;
            final Write write;
            final Runnable expiry = Channel.this::stop;
            final Runnable confirmation = () -> confirm(this);
            SeatArea area;
            Integer original;
            int applied;
            boolean writing, stopping, confirmed;
            Change(Read read, Write write) { this.read = read; this.write = write; }
        }
    }
}

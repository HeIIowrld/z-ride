package ai.zride.demo.car;

import android.os.Handler;
import android.util.Log;
import ai.pleos.playground.vehicle.api.Light;
import ai.pleos.playground.vehicle.api.model.area.SeatArea;
import ai.pleos.playground.vehicle.api.model.capability.AccessType;
import ai.zride.demo.common.RoomClient;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import kotlin.Unit;
import org.json.JSONObject;

/** Executes one temporary ambient brightness change at a time on the main thread. */
final class AmbientPulse {
    private static final String TAG = "ZRideAmbient";
    private final Handler main;
    private final BooleanSupplier allowed;
    private final java.util.function.BiConsumer<String, Integer> observation;
    private Pulse active;

    private static final class Pulse {
        final RoomClient client;
        final Light light;
        final JSONObject intent;
        SeatArea area;
        Integer original;
        int applied;
        boolean writePending;
        boolean stopping;
        Runnable expiry;

        Pulse(RoomClient client, Light light, JSONObject intent) {
            this.client = client;
            this.light = light;
            this.intent = intent;
        }

        long remaining() {
            return intent.optLong("expiresAt") - System.currentTimeMillis();
        }
    }

    AmbientPulse(Handler main, BooleanSupplier allowed, java.util.function.BiConsumer<String, Integer> observation) {
        this.main = main;
        this.allowed = allowed;
        this.observation = observation;
    }

    void start(RoomClient client, Light light, JSONObject intent) {
        Pulse pulse = new Pulse(client, light, intent);
        if (active != null || !allowed.getAsBoolean() || pulse.remaining() < 100) {
            report(pulse, "REJECTED_GATE", null);
            return;
        }
        if (light == null) {
            report(pulse, "UNSUPPORTED", null);
            return;
        }
        double intensity = intent.optDouble("intensity01", 0);
        if (!Double.isFinite(intensity) || intensity <= 0 || intensity > 1) return;
        active = pulse;
        pulse.expiry = this::stop;
        main.postDelayed(pulse.expiry, Math.min(5000, pulse.remaining()));
        report(pulse, "RECEIVED", null);
        light.checkAmbientLightBrightnessCapabilities((cap, bounds) -> dispatch(() -> {
            if (!canWrite(pulse)) return;
            if (cap == null || cap.getAccessType() != AccessType.READ_WRITE || bounds.isEmpty()) {
                finish(pulse, "UNSUPPORTED", null);
                return;
            }
            var entry = bounds.entrySet().iterator().next();
            pulse.area = entry.getKey();
            int min = entry.getValue().getMinValue();
            int max = entry.getValue().getMaxValue();
            light.getAmbientLightBrightness(pulse.area, value -> dispatch(() -> {
                if (!canWrite(pulse)) return;
                if (value == null || value < min || value > max || min >= max) {
                    finish(pulse, "UNSUPPORTED", null);
                    return;
                }
                pulse.original = value;
                int step = Math.max(1, (int) Math.round((max - min) * Math.min(intensity, 0.25)));
                pulse.applied = value < max ? Math.min(max, value + step) : Math.max(min, value - step);
                pulse.writePending = true;
                report(pulse, "DISPATCHED", pulse.original);
                light.setAmbientLightBrightness(pulse.area, pulse.applied, (area, ignored) -> dispatch(() -> {
                    pulse.writePending = false;
                    if (pulse.stopping) restore(pulse);
                    else confirm(pulse);
                }), error -> dispatch(() -> {
                    pulse.writePending = false;
                    Log.w(TAG, "Ambient setter failed", error);
                    finish(pulse, "FAILED", null);
                }));
            }), error -> dispatch(() -> finish(pulse, "FAILED", null)));
        }), error -> dispatch(() -> finish(pulse, "FAILED", null)));
    }

    private boolean canWrite(Pulse pulse) {
        return active == pulse && !pulse.stopping && pulse.remaining() > 0
                && allowed.getAsBoolean() && pulse.client.isAuthenticated();
    }

    private void confirm(Pulse pulse) {
        pulse.light.getAmbientLightBrightness(pulse.area, value -> dispatch(() -> {
            if (active != pulse || pulse.stopping) return;
            if (value != null && value == pulse.applied) report(pulse, "APPLIED_CONFIRMED", value);
            else report(pulse, "FAILED", value);
        }), error -> dispatch(() -> report(pulse, "FAILED", null)));
    }

    void stop(JSONObject message) {
        if (active == null || !active.intent.optString("effectSessionId").equals(message.optString("effectSessionId"))) return;
        var channels = message.optJSONArray("channels");
        if (channels == null) return;
        for (int i = 0; i < channels.length(); i++) {
            if ("AMBIENT".equals(channels.optString(i))) { stop(); return; }
        }
    }

    void stop() {
        Pulse pulse = active;
        if (pulse == null || pulse.stopping) return;
        pulse.stopping = true;
        if (!pulse.writePending) restore(pulse);
    }

    private void restore(Pulse pulse) {
        if (pulse.original == null) {
            finish(pulse, "STOPPED", null);
            return;
        }
        pulse.light.getAmbientLightBrightness(pulse.area, value -> dispatch(() -> {
            if (active != pulse) return;
            if (value == null || value != pulse.applied) {
                finish(pulse, value == null ? "FAILED" : "USER_OVERRIDDEN", value);
                return;
            }
            pulse.light.setAmbientLightBrightness(pulse.area, pulse.original, (area, ignored) -> dispatch(() ->
                pulse.light.getAmbientLightBrightness(pulse.area, restored -> dispatch(() ->
                    finish(pulse, pulse.original.equals(restored) ? "STOPPED" : "FAILED", restored)),
                    error -> dispatch(() -> finish(pulse, "FAILED", null)))),
                error -> dispatch(() -> finish(pulse, "FAILED", null)));
        }), error -> dispatch(() -> finish(pulse, "FAILED", null)));
    }

    private void finish(Pulse pulse, String status, Integer value) {
        if (active != pulse) return;
        main.removeCallbacks(pulse.expiry);
        active = null;
        report(pulse, status, value);
    }

    private Unit dispatch(Runnable task) {
        main.post(task);
        return Unit.INSTANCE;
    }

    private void report(Pulse pulse, String status, Integer value) {
        Log.i(TAG, status + (value == null ? "" : " brightness=" + value));
        observation.accept(status, value);
        try {
            pulse.client.send(new JSONObject().put("type", "vehicle.effect.report")
                    .put("commandId", UUID.randomUUID().toString())
                    .put("effectSessionId", pulse.intent.getString("effectSessionId"))
                    .put("effectId", pulse.intent.getString("effectId"))
                    .put("effectSeq", pulse.intent.getLong("effectSeq"))
                    .put("status", status).put("observedValue", value));
        } catch (org.json.JSONException error) {
            Log.w(TAG, "Invalid effect report fields");
        }
    }
}

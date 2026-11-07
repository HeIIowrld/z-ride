package ai.zride.thief;

import android.car.Car;
import android.car.VehicleGear;
import android.car.VehiclePropertyIds;
import android.car.drivingstate.CarUxRestrictions;
import android.car.drivingstate.CarUxRestrictionsManager;
import android.car.hardware.CarPropertyValue;
import android.car.hardware.property.CarPropertyManager;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

/**
 * 표준 AAOS에서 UX 제한과 기어만 읽는다. 읽기 전용이며 차량 설정을 쓰지 않는다.
 * 모르는 값은 UNKNOWN(잠금)으로 두고, 주행 허용 여부는 서버 gate가 최종 판정한다.
 */
final class DrivingGate {
    interface Listener { void onDriving(String ux, String gear); }
    private static final String TAG = "ZRideThief";
    private final Context context;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Car car;
    private CarUxRestrictionsManager uxManager;
    private CarPropertyManager properties;
    private volatile String ux = "UNKNOWN", gear = "UNKNOWN";
    private boolean closed;

    DrivingGate(Context context, Listener listener) { this.context = context; this.listener = listener; }

    private final CarPropertyManager.CarPropertyEventCallback gearCallback = new CarPropertyManager.CarPropertyEventCallback() {
        @Override public void onChangeEvent(CarPropertyValue value) { setGear(value); }
        @Override public void onErrorEvent(int propertyId, int areaId) { gear = "UNKNOWN"; emit(); }
    };

    void start() {
        emit();
        try {
            car = Car.createCar(context, null, Car.CAR_WAIT_TIMEOUT_DO_NOT_WAIT, (service, ready) -> {
                if (closed) return;
                if (!ready) { ux = "UNKNOWN"; gear = "UNKNOWN"; emit(); return; }
                try {
                    uxManager = (CarUxRestrictionsManager) service.getCarManager(Car.CAR_UX_RESTRICTION_SERVICE);
                    uxManager.registerListener(this::setUx);
                    setUx(uxManager.getCurrentCarUxRestrictions());
                } catch (Exception e) { Log.w(TAG, "UX restrictions unavailable", e); ux = "UNKNOWN"; emit(); }
                try {
                    properties = (CarPropertyManager) service.getCarManager(Car.PROPERTY_SERVICE);
                    properties.registerCallback(gearCallback, VehiclePropertyIds.GEAR_SELECTION, CarPropertyManager.SENSOR_RATE_ONCHANGE);
                    setGear(properties.getProperty(Integer.class, VehiclePropertyIds.GEAR_SELECTION, 0));
                } catch (Exception e) { Log.w(TAG, "Gear unavailable", e); gear = "UNKNOWN"; emit(); }
            });
        } catch (Throwable e) {
            // 차량 라이브러리가 없는 기기(일반 폰 등): 계속 잠금
            Log.w(TAG, "Car service unavailable", e);
            emit();
        }
    }

    /** 앱이 다시 보일 때 현재값을 다시 읽는다(콜백을 놓쳤을 수 있음). */
    void recheck() {
        try { if (uxManager != null) setUx(uxManager.getCurrentCarUxRestrictions()); } catch (Exception e) { ux = "UNKNOWN"; }
        try { if (properties != null) setGear(properties.getProperty(Integer.class, VehiclePropertyIds.GEAR_SELECTION, 0)); } catch (Exception e) { gear = "UNKNOWN"; }
        emit();
    }

    String ux() { return ux; }
    String gear() { return gear; }
    boolean parkedAndAllowed() { return "ALLOWED".equals(ux) && "P".equals(gear); }

    private void setUx(CarUxRestrictions value) {
        ux = value == null ? "UNKNOWN" : (value.isRequiresDistractionOptimization() ? "RESTRICTED" : "ALLOWED");
        emit();
    }
    private void setGear(CarPropertyValue<?> value) {
        Object raw = value == null ? null : value.getValue();
        boolean ok = value != null && value.getStatus() == CarPropertyValue.STATUS_AVAILABLE && raw instanceof Integer;
        gear = ok ? gearName((Integer) raw) : "UNKNOWN";
        emit();
    }
    private static String gearName(int value) {
        if (value == VehicleGear.GEAR_PARK) return "P";
        if (value == VehicleGear.GEAR_DRIVE) return "D";
        if (value == VehicleGear.GEAR_REVERSE) return "R";
        if (value == VehicleGear.GEAR_NEUTRAL) return "N";
        return "UNKNOWN";
    }
    private void emit() { final String u = ux, g = gear; main.post(() -> { if (!closed) listener.onDriving(u, g); }); }

    void close() {
        closed = true;
        try { if (uxManager != null) uxManager.unregisterListener(); } catch (Exception ignored) {}
        try { if (properties != null) properties.unregisterCallback(gearCallback); } catch (Exception ignored) {}
        try { if (car != null) car.disconnect(); } catch (Exception ignored) {}
    }
}

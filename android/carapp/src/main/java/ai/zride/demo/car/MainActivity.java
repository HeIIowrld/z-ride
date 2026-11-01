package ai.zride.demo.car;

import android.os.Bundle;
import android.content.pm.PackageManager;
import ai.zride.demo.common.DemoActivity;
import org.json.JSONObject;
import android.widget.Button;
import android.widget.LinearLayout;

public final class MainActivity extends DemoActivity {
    private VehicleProbe probe;
    @Override protected boolean isCar() { return true; }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        probe=new VehicleProbe(this,new VehicleProbe.Listener(){
            public void onVehicle(JSONObject state,boolean allowed){applyVehicle(state,allowed);}
            public void onDiagnostic(JSONObject line){event("vehicle.diagnostic",line);}
            public void onCabinState(JSONObject state){applyExtraDiagnostics(state);}
        });
        probe.start();
    }
    @Override protected void addVehicleControls(LinearLayout container){Button request=new Button(this);request.setText("충전 정보 권한 요청 (선택)");request.setContentDescription("충전 정보 권한 요청");request.setOnClickListener(v->{if(checkSelfPermission("android.car.permission.CAR_ENERGY")!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{"android.car.permission.CAR_ENERGY"},101);else if(probe!=null)probe.refresh();});container.addView(request);Button inspect=new Button(this);inspect.setText("벨트 · 공조 · 도어 · 창문 · 조명 읽기 진단");inspect.setOnClickListener(v->{if(probe!=null)probe.inspectCabin();});container.addView(inspect);}
    @Override protected void onVehicleForegroundChanged(boolean value){if(probe!=null)probe.setForeground(value);}
    @Override protected void inspectExtraDiagnostics(){if(probe!=null)probe.inspectCabin();}
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results){super.onRequestPermissionsResult(code,permissions,results);if(probe!=null)probe.refresh();}
    @Override protected void onDestroy(){if(probe!=null)probe.close();super.onDestroy();}
}

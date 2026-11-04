package ai.zride.demo.car;

import android.os.Bundle;
import android.content.pm.PackageManager;
import ai.zride.demo.common.DemoActivity;
import org.json.JSONObject;
import android.widget.Button;
import android.widget.LinearLayout;
import java.io.File;
import java.io.FileWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import ai.zride.demo.common.RoomClient;

public final class MainActivity extends DemoActivity {
    private VehicleProbe probe;
    private String appliedRouteCommand;
    private boolean routePending;
    // Private fixed demo input written by the emulator operator, never a production navigation source.
    @Override protected void onVehicleDemoTick(){
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

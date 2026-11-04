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
import android.widget.TextView;

public final class MainActivity extends DemoActivity {
    private VehicleProbe probe;
    private String appliedRouteCommand;
    private boolean routePending;
    private TextView navigationLabel;
    private JSONObject navigationState;
    private boolean sdkNavigationOwned;
    // Private fixed demo input written by the emulator operator, never a production navigation source.
    @Override protected void onVehicleDemoTick(){
        if(connected)NavigationRelayService.attach(client);
        probe=NavigationRelayService.probe();JSONObject v=NavigationRelayService.vehicle();if(v!=null)applyVehicle(v,NavigationRelayService.vehicleAllowed());
        JSONObject cabin=NavigationRelayService.cabin();if(cabin!=null)applyExtraDiagnostics(cabin);
        navigationState=NavigationRelayService.currentState();sdkNavigationOwned=NavigationRelayService.sdkMode();
        if(navigationLabel!=null&&navigationState!=null)navigationLabel.setText("Pleos Navi SDK · "+navigationState.optString("status",navigationState.optString("event"))+" · "+navigationState.optString("destination","—")+" · "+navigationState.optString("error",""));
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
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        startForegroundService(new android.content.Intent(this,NavigationRelayService.class));
        JSONObject prior=NavigationRelayService.currentRoom();if(prior!=null)onRoom(prior);

    }
    @Override protected void addVehicleControls(LinearLayout container){Button request=new Button(this);request.setText("충전 정보 권한 요청 (선택)");request.setContentDescription("충전 정보 권한 요청");request.setOnClickListener(v->{if(checkSelfPermission("android.car.permission.CAR_ENERGY")!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{"android.car.permission.CAR_ENERGY"},101);else if(probe!=null)probe.refresh();});container.addView(request);Button inspect=new Button(this);inspect.setText("벨트 · 공조 · 도어 · 창문 · 조명 읽기 진단");inspect.setOnClickListener(v->{if(probe!=null)probe.inspectCabin();});container.addView(inspect);addNavigationControls(container);}
    private void addNavigationControls(LinearLayout container){
        navigationLabel=new TextView(this);navigationLabel.setText("Pleos Navi SDK 연결 대기");container.addView(navigationLabel);
        Button permission=new Button(this);permission.setText("내비 SDK 권한 요청");permission.setOnClickListener(v->requestPermissions(new String[]{"pleos.car.permission.NAVI_ROUTE","pleos.car.permission.NAVI_ROUTE_SEARCH","android.permission.ACCESS_FINE_LOCATION","android.permission.ACCESS_COARSE_LOCATION"},102));container.addView(permission);
        String[] names={"여의도 동쪽 목적지 (실제 내비)","여의도 서쪽 목적지 (실제 내비)"};
        for(int n=0;n<2;n++){final int index=n;Button b=new Button(this);b.setText(names[n]);b.setOnClickListener(v->{if(localAllowed){NavigationRelayService.destination(index==0?37.532:37.529,index==0?126.932:126.910,names[index]);}});container.addView(b);}
        Button reroute=new Button(this);reroute.setText("실제 내비 재탐색");reroute.setOnClickListener(v->{if(localAllowed)NavigationRelayService.reroute();});container.addView(reroute);
        Button cancel=new Button(this);cancel.setText("실제 내비 안내 취소");cancel.setOnClickListener(v->{if(localAllowed)NavigationRelayService.cancel();});container.addView(cancel);
    }
    @Override protected void onVehicleForegroundChanged(boolean value){NavigationRelayService.setUiForeground(value);}
    @Override protected void inspectExtraDiagnostics(){if(probe!=null)probe.inspectCabin();}
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results){super.onRequestPermissionsResult(code,permissions,results);if(probe!=null)probe.refresh();NavigationRelayService.enableGnss();}
    @Override protected RoomClient retainedClient(){return NavigationRelayService.sharedClient();}
    @Override protected boolean retainClientOnDestroy(){return NavigationRelayService.detach(client);}
    @Override protected void onRoomData(JSONObject value){NavigationRelayService.attach(client,value);}
    @Override protected void onDestroy(){super.onDestroy();}
}

package ai.zride.demo.car;

import android.app.*;import android.content.*;import android.os.*;
import ai.zride.demo.common.RoomClient;import org.json.*;
import java.io.*;import java.nio.charset.StandardCharsets;import java.nio.file.Files;

/** Keeps the observed OEM navigation feed alive when the game Activity is removed.
 * Unexported; credentials stay in the shared RoomClient's process memory.
 * No game rendering, vehicle writes, or driving restriction exemption. */
public final class NavigationRelayService extends Service implements RoomClient.Listener {
    private static NavigationRelayService instance;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private NavigationProbe probe;private RoomClient client;private JSONObject state,room;
    private long sequence;private String lastCommand;private boolean sdkMode;
    private VehicleProbe vehicleProbe;private volatile JSONObject vehicle,cabin;private volatile boolean vehicleAllowed;
    private static boolean uiForeground;
    private static Runnable cabinObserver;
    private android.location.LocationManager locations;private Notification notification;
    private final android.location.LocationListener gps=new android.location.LocationListener(){public void onLocationChanged(android.location.Location value){if(probe!=null)probe.gnss(value);}public void onStatusChanged(String provider,int status,Bundle extras){}public void onProviderEnabled(String provider){}public void onProviderDisabled(String provider){}};
    public static void enableGnss(){if(instance!=null)instance.startGnss();}
    private void startGnss(){if(checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)!=android.content.pm.PackageManager.PERMISSION_GRANTED)return;
        try{if(Build.VERSION.SDK_INT>=29)startForeground(81,notification,android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC|android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);else startForeground(81,notification);locations=getSystemService(android.location.LocationManager.class);locations.requestLocationUpdates(android.location.LocationManager.GPS_PROVIDER,1000,0,gps,Looper.getMainLooper());}catch(SecurityException ignored){}
    }
    public static JSONObject vehicle(){return instance==null?null:instance.vehicle;}
    public static JSONObject cabin(){return instance==null?null:instance.cabin;}
    public static void watchCabin(Runnable observer){cabinObserver=observer;}
    public static VehicleProbe probe(){return instance==null?null:instance.vehicleProbe;}
    public static boolean vehicleAllowed(){return instance!=null&&instance.vehicleAllowed;}
    public static void reportVehicle(){if(instance!=null)instance.sendVehicleSnapshot();}
    public static void setUiForeground(boolean value){uiForeground=value;if(instance!=null&&instance.vehicleProbe!=null)instance.vehicleProbe.setForeground(value);}
    public static RoomClient sharedClient(){return instance==null?null:instance.client;}
    public static JSONObject currentState(){return instance==null?null:instance.state;}
    public static JSONObject currentRoom(){return instance==null||instance.client==null||!instance.client.isAuthenticated()?null:instance.room;}
    public static boolean sdkMode(){return instance!=null&&instance.sdkMode;}
    public static boolean searchPlace(String keyword) {
        return instance != null && uiForeground && instance.vehicleAllowed
                && instance.probe != null && instance.probe.searchPlace(keyword);
    }
    public static void attach(RoomClient c){if(instance!=null)instance.client=c;}
    public static void attach(RoomClient c,JSONObject room){if(instance!=null){instance.client=c;instance.room=room;}}
    public static boolean detach(RoomClient c){if(instance==null||instance.client!=c)return false;c.setListener(instance);return true;}
    public static void destination(double lat,double lon,String name){if(instance!=null){instance.sdkMode=true;instance.probe.destination(lat,lon,name);}}
    public static void reroute(){if(instance!=null)instance.probe.reroute();}
    public static void cancel(){if(instance!=null)instance.probe.cancel();}
    @Override public void onCreate(){super.onCreate();instance=this;
        NotificationManager manager=getSystemService(NotificationManager.class);manager.createNotificationChannel(new NotificationChannel("navigation-relay","차량 내비 상태 연결",NotificationManager.IMPORTANCE_LOW));
        notification=new Notification.Builder(this,"navigation-relay").setContentTitle("차량 내비 상태 연결 중").setContentText("내비 SDK 상태를 현재 파티에 전달합니다.").setSmallIcon(android.R.drawable.ic_menu_mylocation).setOngoing(true).build();
        if(Build.VERSION.SDK_INT>=29)startForeground(81,notification,android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);else startForeground(81,notification);
        probe=new NavigationProbe(this,value->{write("navigation-sdk-state.json",value);value.remove("nativeLatitude");value.remove("nativeLongitude");value.remove("nativeRouteIndex");value.remove("tripInspection");state=value;String s=value.optString("status");if(s.equals("ROUTE_DRIVE")||s.equals("ROUTE_READY"))sdkMode=true;if(s.equals("CANCELLED")||s.equals("FREE_DRIVE"))sdkMode=false;});probe.start();
        boolean debuggable=(getApplicationInfo().flags&android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)!=0;
        vehicleProbe=new VehicleProbe(this,new VehicleProbe.Listener(){
            public void onVehicle(JSONObject v,boolean allowed){
                vehicle=v;vehicleAllowed=allowed;
                if(debuggable){
                    JSONObject motion=new JSONObject();
                    try{
                        motion.put("gear",v.optString("gear"));
                        motion.put("speedMps",v.opt("speedMps"));
                        motion.put("seats",v.opt("seats"));
                        motion.put("rawSdkSeatOccupied",v.opt("rawSdkSeatOccupied"));
                        motion.put("observedAt",System.currentTimeMillis());
                        write("vehicle-motion.json",motion);
                    }catch(JSONException ignored){}
                }
            }
            public void onDiagnostic(JSONObject value){}
            public void onCabinState(JSONObject value){
                cabin=value;
                if(debuggable)write("cabin-state.json",value);
                handler.post(()->{if(cabinObserver!=null)cabinObserver.run();});
            }
        });vehicleProbe.setForeground(uiForeground);vehicleProbe.start();startGnss();handler.post(tick);
    }
    private void sendVehicleSnapshot(){
        JSONObject observed=vehicle;
        if(client==null||observed==null)return;
        try{client.send(new JSONObject(observed.toString()).put("type","vehicle.report")
                .put("commandId",java.util.UUID.randomUUID().toString())
                .put("reportSeq",client.nextVehicleReportSequence()));}
        catch(JSONException ignored){}
    }
    private final Runnable tick=new Runnable(){public void run(){readCommand();sendVehicleSnapshot();if(client!=null)try{if(state!=null){JSONObject n=new JSONObject(state.toString()).put("owned",sdkMode);if(n.has("locationMeasuredAt"))n.put("locationAgeMs",Math.max(0,System.currentTimeMillis()-n.getLong("locationMeasuredAt")));n.remove("locationMeasuredAt");n.remove("nextWaypoint");n.remove("nextWaypointDistanceM");n.remove("arrivedWaypoint");client.send(new JSONObject().put("type","navigation.report").put("commandId",java.util.UUID.randomUUID().toString()).put("reportSeq",++sequence).put("navigation",n));}}catch(Exception ignored){}handler.postDelayed(this,2000);}};
    private void readCommand(){if(probe==null||!probe.ready()||(getApplicationInfo().flags&android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)==0)return;File f=new File(getFilesDir(),"navigation-command.json");if(!f.isFile()||f.length()>4096)return;
        try{JSONObject c=new JSONObject(new String(Files.readAllBytes(f.toPath()),StandardCharsets.UTF_8));String id=c.getString("commandId");if(id.equals(lastCommand))return;String action=c.getString("action");
            if(action.equals("destination")||action.equals("inspectTrip")){
                double lat=c.getDouble("latitude"),lon=c.getDouble("longitude");
                if(!Double.isFinite(lat)||!Double.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return;
                String name=c.optString("name","내비 목적지");
                if(action.equals("inspectTrip"))probe.inspectTrip(lat,lon,name);
                else if(c.has("waypoint")){
                    JSONObject via=c.getJSONObject("waypoint");
                    double viaLat=via.getDouble("latitude"),viaLon=via.getDouble("longitude");
                    if(!Double.isFinite(viaLat)||!Double.isFinite(viaLon)||Math.abs(viaLat)>90||Math.abs(viaLon)>180)return;
                    sdkMode=true;
                    probe.destination(lat,lon,name,new ai.pleos.playground.navi.data.RequestWaypointInfo(
                            viaLat,viaLon,via.getString("name"),
                            ai.pleos.playground.navi.constants.WaypointIndex.FIRST,"","","0",""));
                } else destination(lat,lon,name);
            }else if(action.equals("reroute"))reroute();else if(action.equals("cancel"))cancel();else return;lastCommand=id;
        }catch(Exception ignored){}
    }
    private void write(String name,JSONObject value){try{File temp=new File(getFilesDir(),name+".tmp");try(FileWriter file=new FileWriter(temp)){file.write(value.toString());}temp.renameTo(new File(getFilesDir(),name));}catch(Exception ignored){}}
    @Override public void onRoom(JSONObject value){room=value;write("room-state.json",value);}
    @Override public void onStatus(String value){}
    @Override public void onDisconnected(){}
    @Override public void onResult(JSONObject value){}
    @Override public int onStartCommand(Intent intent,int flags,int startId){return START_NOT_STICKY;}
    @Override public IBinder onBind(Intent intent){return null;}
    @Override public void onDestroy(){handler.removeCallbacksAndMessages(null);if(locations!=null)locations.removeUpdates(gps);if(probe!=null)probe.close();if(vehicleProbe!=null)vehicleProbe.close();if(client!=null)client.destroy();if(instance==this)instance=null;super.onDestroy();}
}

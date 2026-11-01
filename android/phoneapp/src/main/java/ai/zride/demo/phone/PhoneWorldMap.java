package ai.zride.demo.phone;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.PointF;
import android.graphics.RectF;
import android.location.*;
import android.os.*;
import android.widget.*;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.*;
import ai.zride.demo.common.RoomClient;
import org.maplibre.android.MapLibre;
import org.maplibre.android.camera.CameraPosition;
import org.maplibre.android.geometry.LatLng;
import org.maplibre.android.maps.*;
import org.maplibre.android.style.layers.CircleLayer;
import org.maplibre.android.style.sources.GeoJsonSource;
import org.maplibre.geojson.*;
import static org.maplibre.android.style.layers.PropertyFactory.*;

/** Real native map + Android location + authenticated server world requests. */
final class PhoneWorldMap {
    private static final String STYLE="https://tiles.openfreemap.org/styles/liberty";
    private static final double SEOUL_LAT=37.5665,SEOUL_LON=126.978;
    static final int LOCATION_PERMISSION=203;
    private final Activity activity;
    private final Supplier<RoomClient> client;
    private final Supplier<JSONObject> room;
    private final BooleanSupplier passengerConfirmed;
    private final BiConsumer<String,JSONObject> log;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final TextView status,selection;
    private final Button claim;
    private final LocationManager locations;
    private MapView mapView;
    private MapLibreMap map;
    private Style style;
    private GeoJsonSource spawnsSource,playerSource;
    private Location lastLocation;
    private String selectedSpawnId,nearbySchedule;
    private JSONArray visibleSpawns=new JSONArray();
    private final Map<String,JSONObject> knownSpawns=new HashMap<>();
    private final Map<String,String> spawnSchedules=new HashMap<>();
    private final JSONObject evidence=new JSONObject();
    private final AtomicBoolean snapshotPending=new AtomicBoolean(true);
    private long lastNearbyRequest;
    private boolean nearbyPending,approved,started,closed,frameReady;
    private final Runnable freshness=new Runnable(){public void run(){if(closed)return;if(lastLocation!=null)record("location",locationJson());updateLabels();main.postDelayed(this,1000);}};

    PhoneWorldMap(Activity activity,LinearLayout parent,Bundle saved,Supplier<RoomClient> client,Supplier<JSONObject> room,BooleanSupplier passengerConfirmed,BiConsumer<String,JSONObject> log){
        this.activity=activity;this.client=client;this.room=room;this.passengerConfirmed=passengerConfirmed;this.log=log;
        locations=(LocationManager)activity.getSystemService(Context.LOCATION_SERVICE);
        parent.addView(label("서울 실지도 · 주변 보급 지점",18));
        status=label("서울 지도 탐색 · 위치 미허용 / 방문 검증 아님",12);parent.addView(status);
        LinearLayout buttons=new LinearLayout(activity);parent.addView(buttons);
        buttons.addView(button("위치 사용·조회",this::requestLocationPermission),new LinearLayout.LayoutParams(0,-2,1));
        buttons.addView(button("근처 지점 조회",()->refreshNearby(true)),new LinearLayout.LayoutParams(0,-2,1));
        buttons.addView(button("내 위치",this::focusLocation),new LinearLayout.LayoutParams(0,-2,1));
        try{
            MapLibre.getInstance(activity);
            mapView=new MapView(activity,new MapLibreMapOptions().textureMode(true));
            parent.addView(mapView,new LinearLayout.LayoutParams(-1,(int)(300*activity.getResources().getDisplayMetrics().density)));
            mapView.onCreate(saved);
            mapView.addOnDidFailLoadingMapListener(message->record("loadError",message));
            mapView.addOnDidFinishLoadingMapListener(()->record("mapLoadFinished",true));
            mapView.addOnDidFinishRenderingFrameListener((fully,encoding,rendering)->{if(fully&&style!=null){frameReady=true;recordOnce("fullyRenderedFrame",true);if(snapshotPending.compareAndSet(true,false))captureSnapshot();}});
            mapView.getMapAsync(ready->{map=ready;map.setCameraPosition(new CameraPosition.Builder().target(new LatLng(SEOUL_LAT,SEOUL_LON)).zoom(16).tilt(40).build());
                map.setStyle(new Style.Builder().fromUri(STYLE),loaded->{style=loaded;
                    spawnsSource=new GeoJsonSource("zride-world-spawns",FeatureCollection.fromFeatures(new Feature[]{}));style.addSource(spawnsSource);
                    style.addLayer(new CircleLayer("zride-world-spawns","zride-world-spawns").withProperties(circleRadius(9f),circleColor(Color.rgb(236,112,61)),circleStrokeColor(Color.WHITE),circleStrokeWidth(2f)));
                    playerSource=new GeoJsonSource("zride-phone-position",FeatureCollection.fromFeatures(new Feature[]{}));style.addSource(playerSource);
                    style.addLayer(new CircleLayer("zride-phone-position","zride-phone-position").withProperties(circleRadius(8f),circleColor(Color.rgb(40,136,240)),circleStrokeColor(Color.WHITE),circleStrokeWidth(3f)));
                    record("styleLoaded",true);record("building3dLayerPresent",style.getLayer("building-3d")!=null);record("realMapSourcePresent",style.getSource("openmaptiles")!=null);
                    updateMapSources();refreshNearby(false);
                });
                map.addOnMapClickListener(point->{PointF pixel=map.getProjection().toScreenLocation(point);List<Feature> matches=map.queryRenderedFeatures(new RectF(pixel.x-30,pixel.y-30,pixel.x+30,pixel.y+30),"zride-world-spawns");if(!matches.isEmpty()){selectedSpawnId=matches.get(0).getStringProperty("spawnId");updateLabels();return true;}return false;});
            });
        }catch(Exception|LinkageError error){record("initializationError",error.getClass().getSimpleName()+":"+error.getMessage());}
        parent.addView(label("© OpenStreetMap contributors · OpenFreeMap · MapLibre",10));
        selection=label("지도 지점 선택 · 실제 충전소가 아닌 테스트 게임 지점",12);parent.addView(selection);
        claim=button("선택 지점 수집 · 현재 위치 검사",()->claim(null));claim.setEnabled(false);parent.addView(claim);
        record("styleUri",STYLE);record("gpsHardwareAttested",false);JSONObject center=json("latitude",SEOUL_LAT);try{center.put("longitude",SEOUL_LON);}catch(Exception ignored){}record("mapDefaultCenter",center);
    }
    private TextView label(String text,int size){TextView view=new TextView(activity);view.setText(text);view.setTextColor(Color.WHITE);view.setTextSize(size);view.setPadding(0,5,0,5);return view;}
    private Button button(String text,Runnable action){Button view=new Button(activity);view.setText(text);view.setOnClickListener(v->action.run());return view;}
    void onStart(){started=true;if(mapView!=null)mapView.onStart();}
    void onResume(){if(mapView!=null)mapView.onResume();refreshLocation();main.post(freshness);}
    void onPause(){main.removeCallbacks(freshness);try{locations.removeUpdates(locationListener);}catch(Exception ignored){}if(mapView!=null)mapView.onPause();}
    void onStop(){started=false;if(mapView!=null)mapView.onStop();}
    void onDestroy(){closed=true;main.removeCallbacksAndMessages(null);try{locations.removeUpdates(locationListener);}catch(Exception ignored){}if(mapView!=null)mapView.onDestroy();}
    void onLowMemory(){if(mapView!=null)mapView.onLowMemory();}
    void onSave(Bundle out){if(mapView!=null)mapView.onSaveInstanceState(out);}
    private void requestLocationPermission(){if(activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)!=PackageManager.PERMISSION_GRANTED)activity.requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION},LOCATION_PERMISSION);else refreshLocation();}
    void refreshLocation(){
        boolean fine=activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED;
        boolean coarse=activity.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED;
        record("fineLocationPermission",fine);if(!fine&&!coarse){lastLocation=null;record("location",JSONObject.NULL);updateMapSources();updateLabels();return;}
        try{locations.removeUpdates(locationListener);for(String provider:new String[]{LocationManager.GPS_PROVIDER,LocationManager.NETWORK_PROVIDER}){
            if(provider.equals(LocationManager.GPS_PROVIDER)&&!fine)continue;
            if(locations.getProvider(provider)==null||!locations.isProviderEnabled(provider))continue;
            locations.requestLocationUpdates(provider,2000,0,locationListener,Looper.getMainLooper());
            Location cached=locations.getLastKnownLocation(provider);if(cached!=null)acceptLocation(cached);
        }}catch(Exception e){record("locationError",e.getClass().getSimpleName()+":"+e.getMessage());}updateLabels();
    }
    private final LocationListener locationListener=new LocationListener(){
        @Override public void onLocationChanged(Location value){acceptLocation(value);}
        @Override public void onProviderDisabled(String provider){record("providerDisabled",provider);updateLabels();}
        @Override public void onProviderEnabled(String provider){record("providerEnabled",provider);}
        @Override public void onStatusChanged(String provider,int status,Bundle extras){}
    };
    private void acceptLocation(Location value){
        if(closed)return;if(lastLocation!=null&&value.getElapsedRealtimeNanos()<lastLocation.getElapsedRealtimeNanos())return;
        if(lastLocation!=null&&freshLocation()&&(!value.hasAccuracy()||value.getAccuracy()>50))return;
        lastLocation=new Location(value);record("locationProvider",value.getProvider());record("location",locationJson());updateMapSources();updateLabels();refreshNearby(false);
    }
    private long measuredAge(){if(lastLocation==null)return Long.MAX_VALUE;long elapsed=lastLocation.getElapsedRealtimeNanos(),now=SystemClock.elapsedRealtimeNanos();return elapsed<=0||elapsed>now+100000000?Long.MAX_VALUE:Math.max(0,(now-elapsed)/1000000);}
    private boolean freshLocation(){boolean permission=activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED||activity.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED;return permission&&lastLocation!=null&&lastLocation.hasAccuracy()&&lastLocation.getAccuracy()>0&&lastLocation.getAccuracy()<=50&&measuredAge()<=10000;}
    private String source(){if(lastLocation==null)return"NONE";String hardware=Build.HARDWARE.toLowerCase(Locale.ROOT);if(hardware.contains("ranchu")||hardware.contains("goldfish")||Build.FINGERPRINT.startsWith("generic"))return LocationManager.GPS_PROVIDER.equals(lastLocation.getProvider())?"EMULATOR_GPS":"MOCK";return LocationManager.GPS_PROVIDER.equals(lastLocation.getProvider())?"ANDROID_GPS":"ANDROID_NETWORK";}
    private JSONObject locationJson(){JSONObject data=new JSONObject();if(lastLocation==null)return data;try{data.put("latitude",lastLocation.getLatitude()).put("longitude",lastLocation.getLongitude()).put("accuracyM",lastLocation.hasAccuracy()?lastLocation.getAccuracy():JSONObject.NULL).put("measuredAgeMs",measuredAge()).put("source",source()).put("isMock",Build.VERSION.SDK_INT>=31?lastLocation.isMock():lastLocation.isFromMockProvider());}catch(Exception ignored){}return data;}
    void onRoom(JSONObject data){approved=false;JSONArray members=data.optJSONArray("members");RoomClient connection=client.get();if(members!=null&&connection!=null)for(int i=0;i<members.length();i++){JSONObject member=members.optJSONObject(i);if(member!=null&&member.optString("sessionId").equals(connection.getSessionId()))approved=member.optBoolean("approved")&&!member.optString("seat").equals("DRIVER")&&!member.optString("role").equals("CAR_HOST");}updateLabels();if(approved)refreshNearby(false);}
    void refreshNearby(boolean manual){
        if(closed||nearbyPending||!approved||client.get()==null)return;
        long elapsed=SystemClock.elapsedRealtime()-lastNearbyRequest;if(elapsed<5000){if(manual)main.postDelayed(()->refreshNearby(false),5000-elapsed);return;}
        double latitude=lastLocation==null?SEOUL_LAT:lastLocation.getLatitude(),longitude=lastLocation==null?SEOUL_LON:lastLocation.getLongitude();
        if(lastLocation==null&&map!=null&&map.getCameraPosition().target!=null){latitude=map.getCameraPosition().target.getLatitude();longitude=map.getCameraPosition().target.getLongitude();}
        JSONObject query=new JSONObject();try{query.put("latitude",latitude).put("longitude",longitude).put("radiusM",500);}catch(Exception ignored){}
        nearbyPending=true;lastNearbyRequest=SystemClock.elapsedRealtime();
        client.get().postApi("/api/world/nearby",query,new RoomClient.ApiCallback(){
            public void onResponse(JSONObject data){main.post(()->{if(closed)return;nearbyPending=false;visibleSpawns=data.optJSONArray("spawns");if(visibleSpawns==null)visibleSpawns=new JSONArray();nearbySchedule=data.optString("scheduleId");for(int i=0;i<visibleSpawns.length();i++){JSONObject spawn=visibleSpawns.optJSONObject(i);if(spawn!=null){knownSpawns.put(spawn.optString("spawnId"),spawn);spawnSchedules.put(spawn.optString("spawnId"),nearbySchedule);}}if(selectedSpawnId==null&&visibleSpawns.length()>0)selectedSpawnId=visibleSpawns.optJSONObject(0).optString("spawnId");record("nearbySpawnCount",visibleSpawns.length());record("nearbySchedule",nearbySchedule);record("nearby",data);write("world-nearby.json",data);snapshotPending.set(true);updateMapSources();updateLabels();});}
            public void onError(String error){main.post(()->{nearbyPending=false;record("nearbyError",error);updateLabels();});}
        });
    }
    void claim(String spawnId){
        if(spawnId!=null)selectedSpawnId=spawnId;
        JSONObject spawn=knownSpawns.get(selectedSpawnId);
        if(!approved||!passengerConfirmed.getAsBoolean()||spawn==null||!freshLocation()){record("claimLocalError","approved passenger, confirmation, discovered spawn and fresh accurate Android fix required");write("world-last-result.json",json("localError","LOCATION_OR_PASSENGER_NOT_READY"));return;}
        try{JSONObject request=new JSONObject().put("commandId",UUID.randomUUID().toString()).put("spawnId",selectedSpawnId).put("scheduleId",spawnSchedules.get(selectedSpawnId)).put("version",spawn.get("version")).put("passengerConfirmed",true).put("location",locationJson());
            client.get().postApi("/api/world/claim",request,new RoomClient.ApiCallback(){public void onResponse(JSONObject data){main.post(()->{write("world-last-result.json",data);record("lastClaim",data);if(data.optBoolean("claimed")){try{spawn.put("claimed",true);}catch(Exception ignored){}updateMapSources();}updateLabels();});}public void onError(String error){main.post(()->{write("world-last-result.json",json("error",error));record("claimError",error);updateLabels();});}public void onErrorResponse(int status,JSONObject body){main.post(()->{try{body.put("httpStatus",status);}catch(Exception ignored){}write("world-last-result.json",body);record("claimError",body);updateLabels();});}});
        }catch(Exception e){record("claimError",e.toString());}
    }
    private void updateMapSources(){if(style==null||spawnsSource==null||playerSource==null)return;frameReady=false;List<Feature> features=new ArrayList<>();for(int i=0;i<visibleSpawns.length();i++){JSONObject spawn=visibleSpawns.optJSONObject(i);if(spawn==null)continue;Feature feature=Feature.fromGeometry(Point.fromLngLat(spawn.optDouble("longitude"),spawn.optDouble("latitude")));feature.addStringProperty("spawnId",spawn.optString("spawnId"));feature.addStringProperty("title",spawn.optString("title"));features.add(feature);}spawnsSource.setGeoJson(FeatureCollection.fromFeatures(features));playerSource.setGeoJson(lastLocation==null?FeatureCollection.fromFeatures(new Feature[]{}):FeatureCollection.fromFeatures(new Feature[]{Feature.fromGeometry(Point.fromLngLat(lastLocation.getLongitude(),lastLocation.getLatitude()))}));}
    private void updateLabels(){if(closed)return;String position=lastLocation==null?"서울 지도 탐색 · 위치 미허용/미수신":source()+" · 정확도 "+(lastLocation.hasAccuracy()?String.format(Locale.ROOT,"%.1fm",lastLocation.getAccuracy()):"미상")+" · "+(measuredAge()/1000)+"초 전";status.setText(activity.getString(R.string.world_map_status,position,style==null?"로딩 중":"표시",visibleSpawns.length()));
        JSONObject spawn=knownSpawns.get(selectedSpawnId);double distance=Double.POSITIVE_INFINITY;if(spawn!=null&&lastLocation!=null){float[] result=new float[1];Location.distanceBetween(lastLocation.getLatitude(),lastLocation.getLongitude(),spawn.optDouble("latitude"),spawn.optDouble("longitude"),result);distance=result[0];}
        if(selection!=null)selection.setText(spawn==null?"지도 지점을 선택하세요 · 실제 충전소가 아닌 테스트 게임 지점":spawn.optString("title")+" · "+(Double.isFinite(distance)?Math.round(distance)+"m":"위치 미상")+" / 수집 반경 "+spawn.optInt("collectRadiusM",80)+"m"+(spawn.optBoolean("claimed")?" · 수집됨":""));
        if(claim!=null)claim.setEnabled(approved&&passengerConfirmed.getAsBoolean()&&freshLocation()&&spawn!=null&&!spawn.optBoolean("claimed")&&distance<=spawn.optInt("collectRadiusM",80));
    }
    void focusLocation(){if(map!=null&&lastLocation!=null){frameReady=false;snapshotPending.set(true);map.setCameraPosition(new CameraPosition.Builder().target(new LatLng(lastLocation.getLatitude(),lastLocation.getLongitude())).zoom(16).tilt(40).build());}}
    void requestSnapshot(){snapshotPending.set(true);if(style!=null&&frameReady&&started&&map!=null&&snapshotPending.compareAndSet(true,false))captureSnapshot();}
    private void captureSnapshot(){if(map==null||!started||closed)return;map.snapshot(bitmap->{if(closed)return;try(FileOutputStream file=new FileOutputStream(new File(activity.getFilesDir(),"map-snapshot.png"))){bitmap.compress(Bitmap.CompressFormat.PNG,100,file);record("snapshotSaved",true);record("snapshotWidth",bitmap.getWidth());record("snapshotHeight",bitmap.getHeight());}catch(Exception e){record("snapshotError",e.toString());}});}
    private synchronized void record(String key,Object value){if(closed)return;try{evidence.put(key,value==null?JSONObject.NULL:value).put("updatedAt",System.currentTimeMillis());write("map-state.json",evidence);if(!key.equals("location")&&!key.equals("nearby"))log.accept("map."+key,json("value",value));}catch(Exception ignored){}}
    private synchronized void recordOnce(String key,Object value){if(!evidence.has(key))record(key,value);}
    private void write(String name,JSONObject value){try(FileWriter file=new FileWriter(new File(activity.getFilesDir(),name),false)){file.write(value.toString(2));}catch(Exception ignored){}}
    private static JSONObject json(String key,Object value){JSONObject data=new JSONObject();try{data.put(key,value);}catch(Exception ignored){}return data;}
}

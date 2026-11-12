package ai.zride.demo.car;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import ai.pleos.playground.navi.helper.NaviHelper;
import ai.pleos.playground.navi.helper.listener.NaviHelperEventListener;
import ai.pleos.playground.navi.constants.*;
import ai.pleos.playground.navi.data.*;
import kotlin.Unit;
import org.json.*;

/** Public NaviHelper only. A callback is evidence; a successful request is not a route. */
final class NavigationProbe implements AutoCloseable {
    interface Listener{void changed(JSONObject value);}
    private final NaviHelper sdk;
    private final Listener sink;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final JSONObject state=new JSONObject();
    private boolean ready,closed;
    private boolean arrived;
    private long revision;
    private String destinationSignature;
    private long gnssAt;
    void gnss(android.location.Location location){gnssAt=android.os.SystemClock.elapsedRealtime();put("latitude",location.getLatitude());put("longitude",location.getLongitude());put("heading",(double)location.getBearing());put("positionSource","ANDROID_GNSS");long age=Math.max(0,(android.os.SystemClock.elapsedRealtimeNanos()-location.getElapsedRealtimeNanos())/1000000);put("locationMeasuredAt",System.currentTimeMillis()-age);emit("GNSS_LOCATION");}
    private final Runnable poll=new Runnable(){public void run(){if(closed)return;if(ready){try{sdk.getCurrentLocationInfo();sdk.getDestinationInfo();sdk.getRouteStateInfo();if(!arrived)sdk.getWaypointInfo();}catch(Exception e){failure("QUERY_FAILED");}}main.postDelayed(this,3000);}};
    NavigationProbe(Context context,Listener sink){this.sink=sink;sdk=new NaviHelper(context.getApplicationContext());}
    boolean ready(){return ready;}
    boolean searchPlace(String keyword) {
        if (!ready || closed) return false;
        try {
            sdk.requestNavigationScreen(new NavigationScreenRequest.SearchPlace(keyword));
            return true;
        } catch (RuntimeException unavailable) {
            android.util.Log.w("ZRideNavigation", "Could not open native search: "
                    + unavailable.getClass().getSimpleName());
            return false;
        }
    }
    private void put(String key,Object value){try{state.put(key,value==null?JSONObject.NULL:value);}catch(JSONException ignored){}}
    private synchronized void emit(String event){try{put("source","PLEOS_NAVI_HELPER");put("event",event);put("sdkConnected",ready);put("routeRevision",revision);put("geometryAvailable",false);sink.changed(new JSONObject(state.toString()));}catch(JSONException ignored){}}
    void start(){emit("INITIALIZING");sdk.initialize(()->{main.post(()->{if(closed)return;ready=true;sdk.addListener(events);emit("CONNECTED");main.post(poll);});return Unit.INSTANCE;},error->{main.post(()->failure("SDK_CONNECTION_FAILED"));return Unit.INSTANCE;});}
    void destination(double lat,double lon,String name){destination(lat,lon,name,null);}
    void destination(double lat,double lon,String name,RequestWaypointInfo waypoint){
        if(!ready){failure("SDK_NOT_CONNECTED");return;}
        try{
            put("requestedDestination",name);
            RouteInfo route=new RouteInfo(lat,lon,null,null,name,"","","0",RouteOption.RECOMMENDED,"",false);
            if(waypoint==null)sdk.requestRoute(route);
            else sdk.requestRouteWithWaypoints(new RouteWithWaypointsRequest(route,java.util.List.of(waypoint)));
            emit("REQUESTED");
        }catch(Exception e){failure("DESTINATION_REQUEST_FAILED_"+e.getClass().getSimpleName());}
    }
    void reroute(){if(!ready){failure("SDK_NOT_CONNECTED");return;}try{sdk.requestReRoute();emit("REROUTE_REQUESTED");}catch(Exception e){failure("REROUTE_REQUEST_FAILED");}}
    void inspectTrip(double lat,double lon,String name){
        put("tripInspection",null);
        try{sdk.requestTrip(new TripRequest(lat,lon,"",name,"0"));emit("TRIP_REQUESTED");}
        catch(Exception e){put("tripInspection",e.getClass().getSimpleName());emit("TRIP_REQUEST_FAILED");}
    }
    void cancel(){if(!ready){failure("SDK_NOT_CONNECTED");return;}try{sdk.cancelRoute();emit("CANCEL_REQUESTED");}catch(Exception e){failure("CANCEL_REQUEST_FAILED");}}
    private void failure(String code){put("error",code);put("status","ERROR");emit("ERROR");}
    private void showWaypoint(WaypointInfo waypoint) {
        put("nextWaypoint", waypoint == null ? null : waypoint.getName());
        put("nextWaypointDistanceM", waypoint == null ? null : waypoint.getRemainDistance());
    }
    private final NaviHelperEventListener events=new NaviHelperEventListener(){
        @Override public void onRouteStarted(RouteStartInfo value){main.post(()->{
            arrived=false;
            put("arrivedWaypoint",null);
            showWaypoint(null);
            put("destination",null);
            put("remainingDistanceM",null);
            put("remainingTimeSec",null);
            put("status","SEARCHING");
            put("error",null);
            emit("ROUTE_STARTED");
        });}
        @Override public void onRoutingCompleted(){main.post(()->{arrived=false;revision++;put("error",null);put("status","ROUTE_READY");emit("ROUTING_COMPLETED");sdk.getDestinationInfo();sdk.getRouteStateInfo();sdk.getWaypointInfo();});}
        @Override public void onReRouteEnded(){main.post(()->{revision++;put("status","ROUTE_READY");emit("REROUTE_ENDED");sdk.getDestinationInfo();});}
        @Override public void onDestinationChanged(){main.post(()->{revision++;emit("DESTINATION_CHANGED");sdk.getDestinationInfo();});}
        @Override public void onRouteCancelled(){main.post(()->{arrived=false;revision++;put("status","CANCELLED");put("destination",null);showWaypoint(null);put("arrivedWaypoint",null);put("remainingDistanceM",null);put("remainingTimeSec",null);emit("ROUTE_CANCELLED");});}
        @Override public void onDestinationArrived(DestinationArrivedInfo info){main.post(()->{arrived=true;revision++;put("status","ARRIVED");showWaypoint(null);if(info.getName()!=null&&!info.getName().isEmpty())put("destination",info.getName());put("remainingDistanceM",0);put("remainingTimeSec",0);emit("DESTINATION_ARRIVED");});}
        @Override public void onWayPointArrived(WaypointArrivedInfo info){main.post(()->{
            put("arrivedWaypoint",info.getName());
            showWaypoint(null);
            emit("WAYPOINT_ARRIVED");
            sdk.getWaypointInfo();
        });}
        @Override public void onWayPointInfo(java.util.List<WaypointInfo> values){main.post(()->{
            if(arrived)return;
            showWaypoint(values.isEmpty() ? null : values.get(0));
            emit("WAYPOINT_INFO");
        });}
        @Override public void onCurrentRoadSpeedLimit(int kmh) { main.post(() -> {
            put("speedLimitKmh", kmh > 0 && kmh <= 160 ? kmh : null);
            emit("SPEED_LIMIT");
        }); }
        @Override public void onTBTInfo(java.util.List<TBTInfo> directions) { main.post(() -> {
            TBTInfo next = directions.isEmpty() ? null : directions.get(0);
            String turn = next == null ? null : next.getType() == TurnType.TURN_LEFT ? "left"
                    : next.getType() == TurnType.TURN_RIGHT ? "right" : null;
            put("nextTurn", turn);
            put("nextTurnDistanceM", turn != null && next.getDistance() >= 0 ? next.getDistance() : null);
            emit("TURN_GUIDANCE");
        }); }
        @Override public void onNavigationStatus(NavigationStatus value){main.post(()->{if(!arrived){put("status",value.name());emit("NAVIGATION_STATUS");}});}
        @Override public void onCurrentLocationInfo(CurrentLocationInfo value){main.post(()->{put("nativeLatitude",value.getLatitude());put("nativeLongitude",value.getLongitude());put("nativeRouteIndex",value.getCurrentRouteIndex());if(gnssAt==0||android.os.SystemClock.elapsedRealtime()-gnssAt>10000){put("latitude",value.getLatitude());put("longitude",value.getLongitude());put("heading",value.getHeading());put("positionSource","PLEOS_NAVI_HELPER");put("locationMeasuredAt",System.currentTimeMillis());}emit("LOCATION");});}
        @Override public void onTripInfo(TripInfo value){main.post(()->{
            JSONObject trip=new JSONObject();
            try{
                trip.put("distance",value.getDistance());
                trip.put("eta",value.getEta());
                if(value.getSummary()!=null)trip.put("routePoints",value.getSummary().getRoutePoints().size());
            }catch(JSONException ignored){}
            put("tripInspection",trip);
            emit("TRIP_INFO");
        });}
        @Override public void onDestinationInfo(DestinationInfo value){main.post(()->{if(arrived)return;String signature=value.getLatitude()+":"+value.getLongitude()+":"+value.getName();if(!signature.equals(destinationSignature)){if(destinationSignature!=null||!value.getName().isEmpty())revision++;destinationSignature=signature;}put("destination",value.getName());put("remainingDistanceM",value.getRemainDistance());put("remainingTimeSec",value.getRemainTime());emit("DESTINATION_INFO");});}
        @Override public void onRouteStateInfo(RouteStateInfo value){main.post(()->{put("termsAgreed",value.getTermsAgreement());put("routing",value.isRouting());put("routeOption",value.getRouteOption().name());emit("ROUTE_STATE");});}
        @Override public void onError(NaviErrorCode value){main.post(()->failure(value.name()));}
    };
    @Override public void close(){closed=true;main.removeCallbacks(poll);try{sdk.removeListener(events);sdk.release();}catch(Exception ignored){}}
}

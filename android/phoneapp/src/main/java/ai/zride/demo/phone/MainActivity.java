package ai.zride.demo.phone;

import ai.zride.demo.common.DemoActivity;
import android.os.Bundle;
import android.widget.LinearLayout;
import org.json.JSONObject;

public final class MainActivity extends DemoActivity {
    private Bundle initialState;
    private PhoneWorldMap worldMap;
    @Override protected boolean isCar() { return false; }
    @Override public void onCreate(Bundle state){initialState=state;super.onCreate(state);}
    @Override protected void addPhoneCollectionContent(LinearLayout container){worldMap=new PhoneWorldMap(this,container,initialState,()->client,()->room,this::passengerConfirmed,this::event);}
    @Override protected void onRoomData(JSONObject data){if(worldMap!=null)worldMap.onRoom(data);}
    @Override protected void onAdditionalTestAction(String action,String spawnId){if(worldMap==null)return;switch(action){case"mapRefresh":worldMap.refreshNearby(true);break;case"mapSnapshot":worldMap.requestSnapshot();break;case"gpsRefresh":worldMap.refreshLocation();break;case"mapFocusGPS":worldMap.focusLocation();break;case"worldClaim":worldMap.claim(spawnId);break;}}
    @Override protected void onStart(){super.onStart();if(worldMap!=null)worldMap.onStart();}
    @Override protected void onResume(){super.onResume();if(worldMap!=null)worldMap.onResume();}
    @Override protected void onPause(){if(worldMap!=null)worldMap.onPause();super.onPause();}
    @Override protected void onStop(){if(worldMap!=null)worldMap.onStop();super.onStop();}
    @Override protected void onDestroy(){if(worldMap!=null)worldMap.onDestroy();super.onDestroy();}
    @Override public void onLowMemory(){super.onLowMemory();if(worldMap!=null)worldMap.onLowMemory();}
    @Override protected void onSaveInstanceState(Bundle state){super.onSaveInstanceState(state);if(worldMap!=null)worldMap.onSave(state);}
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){super.onRequestPermissionsResult(request,permissions,results);if(worldMap!=null&&request==PhoneWorldMap.LOCATION_PERMISSION)worldMap.refreshLocation();}
}

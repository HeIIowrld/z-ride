package ai.zride.demo.car;

import android.car.Car;
import android.car.VehiclePropertyIds;
import android.car.VehicleAreaSeat;
import android.car.VehicleGear;
import android.car.drivingstate.CarUxRestrictions;
import android.car.drivingstate.CarUxRestrictionsManager;
import android.car.hardware.CarPropertyConfig;
import android.car.hardware.CarPropertyValue;
import android.car.hardware.property.CarPropertyManager;
import android.car.hardware.property.EvChargeState;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import org.json.*;
import java.util.*;
import java.util.concurrent.*;
import ai.pleos.playground.vehicle.Vehicle;
import ai.pleos.playground.vehicle.api.Seat;
import ai.pleos.playground.vehicle.api.EvBattery;
import ai.pleos.playground.vehicle.api.model.area.SeatArea;
import ai.pleos.playground.vehicle.api.model.capability.AccessType;
import ai.pleos.playground.vehicle.constant.area.SeatValue;
import ai.pleos.playground.vehicle.listener.SeatOccupancyListener;
import ai.pleos.playground.vehicle.listener.EvBatteryStateOfChargeListener;
import kotlin.Unit;

/** Read-only diagnostics. No hidden API, property setter, or driving exemption. */
final class VehicleProbe {
    interface Listener {void onVehicle(JSONObject state,boolean allowed);void onDiagnostic(JSONObject line);void onCabinState(JSONObject state);}
    private final Context context;
    private final Listener listener;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final Handler main=new Handler(Looper.getMainLooper());
    private Car car;
    private CarPropertyManager properties;
    private CarUxRestrictionsManager uxManager;
    private Vehicle pleos;
    private Seat pleosSeat;
    private EvBattery pleosBattery;
    private CabinProbe cabin;
    private EvBatteryStateOfChargeListener socListener;
    private volatile Integer socPercent;
    private volatile boolean foreground=true,connected=false,closed=false;
    private volatile String ux="UNKNOWN",gear="UNKNOWN",chargeState="UNKNOWN",portConnection="UNKNOWN";
    private final Map<String,String> seatValues=new LinkedHashMap<>();
    private final Map<String,Boolean> rawSdkSeatValues=new LinkedHashMap<>();
    private final Map<String,String> aaosSeatValues=new LinkedHashMap<>();
    private final Map<SeatArea,SeatOccupancyListener> seatListeners=new ConcurrentHashMap<>();
    private final List<Integer> registered=new ArrayList<>();
    private final int[] ids={VehiclePropertyIds.GEAR_SELECTION,VehiclePropertyIds.EV_CHARGE_PORT_CONNECTED,
        VehiclePropertyIds.EV_CHARGE_PORT_OPEN,VehiclePropertyIds.EV_CHARGE_STATE,VehiclePropertyIds.EV_CHARGE_SWITCH,
        VehiclePropertyIds.EV_BATTERY_LEVEL,VehiclePropertyIds.SEAT_OCCUPANCY};
    VehicleProbe(Context context,Listener listener){this.context=context;this.listener=listener;for(String s:new String[]{"DRIVER","FRONT_PASSENGER","REAR_LEFT","REAR_RIGHT"})seatValues.put(s,"UNKNOWN");}
    void start(){
        emit();
        try {
            car=Car.createCar(context,null,Car.CAR_WAIT_TIMEOUT_DO_NOT_WAIT,(service,ready)->{
                if(closed)return;connected=ready;diag("AAOS_SERVICE",0,0,"connection",ready?"CONNECTED":"DISCONNECTED",0);
                if(!ready){ux="UNKNOWN";gear="UNKNOWN";registered.clear();emit();return;}
                try {
                    properties=(CarPropertyManager)service.getCarManager(Car.PROPERTY_SERVICE);
                    uxManager=(CarUxRestrictionsManager)service.getCarManager(Car.CAR_UX_RESTRICTION_SERVICE);
                    uxManager.unregisterListener();uxManager.registerListener(this::onUx);
                    onUx(uxManager.getCurrentCarUxRestrictions());
                    refresh();
                }catch(Exception e){diagError("AAOS_INIT",0,0,e);ux="UNKNOWN";emit();}
            });
        }catch(Exception e){diagError("AAOS_CREATE",0,0,e);emit();}
        try {
            pleos=new Vehicle(context.getApplicationContext());pleos.initialize();pleosSeat=pleos.getSeat();pleosBattery=pleos.getEvBattery();
            cabin=new CabinProbe(pleos,new CabinProbe.Listener(){public void onState(JSONObject state){listener.onCabinState(state);}public void onLog(JSONObject event){listener.onDiagnostic(event);}});
            // initialize binds asynchronously; retry without treating a connection error as unsupported.
            main.postDelayed(this::inspectPleosSeats,1500);main.postDelayed(this::inspectPleosSeats,5000);
            main.postDelayed(this::inspectPleosSoc,1800);main.postDelayed(this::inspectPleosSoc,5500);
            main.postDelayed(this::inspectCabin,6000);
        }catch(Exception e){diagError("PLEOS_INIT",0,0,e);}
    }
    void refresh(){if(closed)return;worker.execute(()->{
        if(properties==null)return;
        for(int id:ids){
            try {
                CarPropertyConfig<?> config=properties.getCarPropertyConfig(id);
                if(config==null){diag("AAOS",id,0,"capability","UNSUPPORTED_OR_NOT_ACCESSIBLE",0);continue;}
                diag("AAOS",id,0,"capability","access="+config.getAccess()+" areas="+Arrays.toString(config.getAreaIds()),0);
                int[] areas=config.getAreaIds();if(areas.length==0)areas=new int[]{0};
                for(int area:areas){try{onProperty(properties.getProperty(id,area));}catch(Exception e){diagError("AAOS_READ",id,area,e);}}
                if(!registered.contains(id)){boolean accepted=properties.registerCallback(callback,id,CarPropertyManager.SENSOR_RATE_ONCHANGE);diag("AAOS",id,0,"subscribe",accepted,0);if(accepted)registered.add(id);}
            }catch(Exception e){diagError("AAOS_CAPABILITY",id,0,e);}
        }
        emit();
    });}
    private final CarPropertyManager.CarPropertyEventCallback callback=new CarPropertyManager.CarPropertyEventCallback(){
        @Override public void onChangeEvent(CarPropertyValue value){onProperty(value);}
        @Override public void onErrorEvent(int propertyId,int areaId){diag("AAOS",propertyId,areaId,"callback.error","UNKNOWN",0);if(propertyId==VehiclePropertyIds.GEAR_SELECTION)gear="UNKNOWN";if(propertyId==VehiclePropertyIds.EV_CHARGE_STATE)chargeState="UNKNOWN";if(propertyId==VehiclePropertyIds.EV_CHARGE_PORT_CONNECTED)portConnection="UNKNOWN";emit();}
    };
    private synchronized void onProperty(CarPropertyValue<?> value){
        if(value==null){diag("AAOS",0,0,"read",JSONObject.NULL,0);return;}
        int id=value.getPropertyId(),area=value.getAreaId();Object raw=value.getValue();
        diag("AAOS",id,area,"value.status="+value.getStatus(),raw,value.getTimestamp());
        boolean available=value.getStatus()==CarPropertyValue.STATUS_AVAILABLE;
        if(id==VehiclePropertyIds.GEAR_SELECTION)gear=available&&raw instanceof Integer?gear((Integer)raw):"UNKNOWN";
        if(id==VehiclePropertyIds.EV_CHARGE_PORT_CONNECTED)portConnection=available&&raw instanceof Boolean?((Boolean)raw?"CONNECTED":"DISCONNECTED"):"UNKNOWN";
        if(id==VehiclePropertyIds.EV_CHARGE_STATE)chargeState=available&&raw instanceof Integer?charge((Integer)raw):"UNKNOWN";
        if(id==VehiclePropertyIds.SEAT_OCCUPANCY&&raw instanceof Integer&&available){String seat=seat(area);if(seat!=null){String normalized=(Integer)raw==2?"OCCUPIED":((Integer)raw==1?"EMPTY":"UNKNOWN");aaosSeatValues.put(seat,normalized);seatValues.put(seat,normalized);}}
        emit();
    }
    private boolean seatListenersContain(String seat){for(SeatArea a:seatListeners.keySet())for(SeatValue s:a.getValues())if(Objects.equals(pleosSeatName(s),seat))return true;return false;}
    private synchronized void onUx(CarUxRestrictions value){ux=value==null?"UNKNOWN":(value.isRequiresDistractionOptimization()?"RESTRICTED":"ALLOWED");diag("AAOS_UX",0,0,"restrictions",value==null?"null":"requiresDO="+value.isRequiresDistractionOptimization()+" flags="+value.getActiveRestrictions(),0);emit();}
    private void inspectPleosSeats(){
        if(closed||pleosSeat==null)return;
        try{pleosSeat.checkSeatOccupancyCapabilities((cap,areas)->{
            diag("PLEOS_SEAT",0,0,"capability",cap==null?"null":"access="+cap.getAccessType()+" areas="+areas,0);
            if(cap==null||(cap.getAccessType()!=AccessType.READ&&cap.getAccessType()!=AccessType.READ_WRITE))return Unit.INSTANCE;
            for(SeatArea area:areas){
                if(area.getValues().length!=1){diag("PLEOS_SEAT",0,0,"area","COMPOSITE_NOT_MAPPED",0);continue;}
                final String name=pleosSeatName(area.getValues()[0]);if(name==null)continue;
                pleosSeat.getCurrentSeatOccupancy(area,value->{updatePleosSeat(name,value,"read");return Unit.INSTANCE;},error->{diagError("PLEOS_SEAT_READ",0,0,error);return Unit.INSTANCE;});
                if(!seatListeners.containsKey(area)){
                    SeatOccupancyListener watcher=new SeatOccupancyListener(){
                        @Override public void onSeatOccupancyUpdated(Boolean value){updatePleosSeat(name,value,"callback");}
                        @Override public void onFailed(Exception error){diagError("PLEOS_SEAT_CALLBACK",0,0,error);updatePleosSeat(name,null,"callback.error");}
                    };
                    seatListeners.put(area,watcher);pleosSeat.registerSeatOccupancy(area,watcher);
                }
            }
            return Unit.INSTANCE;
        },error->{diagError("PLEOS_SEAT_CAPABILITY",0,0,error);return Unit.INSTANCE;});}catch(Exception e){diagError("PLEOS_SEAT",0,0,e);}
    }
    private synchronized void updatePleosSeat(String seat,Boolean value,String event){rawSdkSeatValues.put(seat,value);seatValues.put(seat,aaosSeatValues.getOrDefault(seat,"UNKNOWN"));diag("PLEOS_SEAT_RAW",0,0,event,seat+"="+value+" semanticStatus=UNVERIFIED_SEMANTICS",0);emit();}
    private void inspectPleosSoc(){
        if(closed||pleosBattery==null)return;
        try{pleosBattery.checkEvBatteryStateOfChargeCapabilities(cap->{
            diag("PLEOS_SOC",0,0,"capability",cap==null?"null":"access="+cap.getAccessType(),0);
            if(cap==null||(cap.getAccessType()!=AccessType.READ&&cap.getAccessType()!=AccessType.READ_WRITE))return Unit.INSTANCE;
            pleosBattery.getEvBatteryStateOfCharge(value->{updateSoc(value,"read");return Unit.INSTANCE;},error->{diagError("PLEOS_SOC_READ",0,0,error);return Unit.INSTANCE;});
            if(socListener==null){socListener=new EvBatteryStateOfChargeListener(){
                @Override public void onEvBatteryStateOfChargeUpdated(Integer value){updateSoc(value,"callback");}
                @Override public void onFailed(Exception error){diagError("PLEOS_SOC_CALLBACK",0,0,error);updateSoc(null,"callback.error");}
            };pleosBattery.registerEvBatteryStateOfCharge(socListener);}
            return Unit.INSTANCE;
        },error->{diagError("PLEOS_SOC_CAPABILITY",0,0,error);return Unit.INSTANCE;});}catch(Exception e){diagError("PLEOS_SOC",0,0,e);}
    }
    private void updateSoc(Integer value,String event){socPercent=value!=null&&value>=0&&value<=100?value:null;diag("PLEOS_SOC",0,0,event,value,0);emit();}
    void inspectCabin(){if(!closed&&cabin!=null)cabin.inspect();}
    void setForeground(boolean value){foreground=value;if(value&&uxManager!=null){try{onUx(uxManager.getCurrentCarUxRestrictions());}catch(Exception e){ux="UNKNOWN";diagError("UX_RECHECK",0,0,e);}}emit();}
    private synchronized void emit(){try{
        JSONArray seats=new JSONArray();for(Map.Entry<String,String> e:seatValues.entrySet())seats.put(new JSONObject().put("seat",e.getKey()).put("occupancy",e.getValue()));
        JSONObject rawSeats=new JSONObject();for(Map.Entry<String,Boolean> e:rawSdkSeatValues.entrySet())rawSeats.put(e.getKey(),e.getValue()==null?JSONObject.NULL:e.getValue());
        JSONObject value=new JSONObject().put("ux",connected?ux:"UNKNOWN").put("foreground",foreground).put("gear",gear).put("seats",seats).put("rawSdkSeatOccupied",rawSeats).put("sdkSeatSemantics","UNVERIFIED_SEMANTICS")
            .put("charge",new JSONObject().put("state",chargeState).put("portConnection",portConnection).put("source","AAOS").put("socPercent",socPercent==null?JSONObject.NULL:socPercent).put("socSource","PLEOS_VEHICLE"))
            .put("source","AAOS_AND_PLEOS");
        listener.onVehicle(value,foreground&&connected&&ux.equals("ALLOWED")&&gear.equals("P"));
    }catch(Exception ignored){}}
    private static String gear(int value){if(value==VehicleGear.GEAR_PARK)return"P";if(value==VehicleGear.GEAR_DRIVE)return"D";if(value==VehicleGear.GEAR_REVERSE)return"R";if(value==VehicleGear.GEAR_NEUTRAL)return"N";return"UNKNOWN";}
    private static String charge(int value){switch(value){case EvChargeState.STATE_NOT_CHARGING:return"NOT_CHARGING";case EvChargeState.STATE_CHARGING:return"CHARGING";case EvChargeState.STATE_FULLY_CHARGED:return"COMPLETED";case EvChargeState.STATE_ERROR:return"ERROR";default:return"UNKNOWN";}}
    private static String seat(int area){if(area==VehicleAreaSeat.SEAT_ROW_1_LEFT)return"DRIVER";if(area==VehicleAreaSeat.SEAT_ROW_1_RIGHT)return"FRONT_PASSENGER";if(area==VehicleAreaSeat.SEAT_ROW_2_LEFT)return"REAR_LEFT";if(area==VehicleAreaSeat.SEAT_ROW_2_RIGHT)return"REAR_RIGHT";return null;}
    private static String pleosSeatName(SeatValue value){switch(value){case ROW_1_LEFT:return"DRIVER";case ROW_1_RIGHT:return"FRONT_PASSENGER";case ROW_2_LEFT:return"REAR_LEFT";case ROW_2_RIGHT:return"REAR_RIGHT";default:return null;}}
    private void diag(String source,int id,int area,String event,Object raw,long timestamp){try{listener.onDiagnostic(new JSONObject().put("source",source).put("propertyId",id).put("propertyHex","0x"+Integer.toHexString(id)).put("areaId",area).put("kind",event).put("raw",raw==null?JSONObject.NULL:String.valueOf(raw)).put("propertyTimestampNs",timestamp));}catch(Exception ignored){}}
    private void diagError(String source,int id,int area,Exception error){diag(source,id,area,error.getClass().getSimpleName(),error.getMessage(),0);}
    void close(){closed=true;main.removeCallbacksAndMessages(null);try{if(uxManager!=null)uxManager.unregisterListener();if(properties!=null)properties.unregisterCallback(callback);if(car!=null)car.disconnect();}catch(Exception ignored){}try{if(cabin!=null)cabin.close();if(pleosSeat!=null)for(Map.Entry<SeatArea,SeatOccupancyListener> e:seatListeners.entrySet())pleosSeat.unregisterSeatOccupancy(e.getKey(),e.getValue());if(pleosBattery!=null&&socListener!=null)pleosBattery.unregisterEvBatteryStateOfCharge(socListener);if(pleos!=null)pleos.release();}catch(Exception ignored){}worker.shutdownNow();}
}

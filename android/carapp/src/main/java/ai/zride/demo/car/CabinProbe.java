package ai.zride.demo.car;

import ai.pleos.playground.vehicle.Vehicle;
import ai.pleos.playground.vehicle.api.*;
import ai.pleos.playground.vehicle.api.model.area.*;
import ai.pleos.playground.vehicle.api.model.capability.CapabilityConfig;
import ai.pleos.playground.vehicle.api.model.capability.AccessType;
import ai.pleos.playground.vehicle.constant.unit.TemperatureUnit;
import ai.pleos.playground.vehicle.listener.*;
import kotlin.Unit;
import kotlin.jvm.functions.Function1;
import org.json.*;
import java.util.*;

/** Explicit read-only normal-permission cabin diagnostics, separate from game telemetry. */
final class CabinProbe {
    interface Listener {void onState(JSONObject state);void onLog(JSONObject event);}
    private final Vehicle vehicle;
    private final Listener listener;
    private final JSONObject state=new JSONObject();
    private final Map<String,Runnable> cleanup=new LinkedHashMap<>();
    private volatile boolean closed;
    CabinProbe(Vehicle vehicle,Listener listener){this.vehicle=vehicle;this.listener=listener;}
    void inspect(){if(closed)return;
        try{Seat seat=vehicle.getSeat();seat.checkSeatBeltBuckledCapabilities((cap,areas)->{
            capability("seatbelt",cap,areas);if(readable(cap))for(SeatArea area:areas){String key=key(area);
                seat.getCurrentSeatBeltBuckledState(area,value->value("seatbelt",key,"read",value),error->error("seatbelt",key,error));
                subscribe("seatbelt"+key,()->{SeatBeltBuckledStateListener watcher=new SeatBeltBuckledStateListener(){public void onSeatBeltBuckledStateUpdated(Boolean value){value("seatbelt",key,"callback",value);}public void onFailed(Exception error){error("seatbelt",key,error);}};seat.registerSeatBeltBuckledState(area,watcher);return ()->seat.unregisterSeatBeltBuckledState(area,watcher);});
            }return Unit.INSTANCE;},e->error("seatbelt","capability",e));}catch(Exception e){error("seatbelt","initialize",e);}
        try{HVAC hvac=vehicle.getHVAC();
            hvac.checkHvacPowerCapabilities((cap,areas)->{capability("hvac.power",cap,areas);if(readable(cap))for(SeatArea area:areas){String key=key(area);hvac.getHvacPowerState(area,v->value("hvac.power",key,"read",v),e->error("hvac.power",key,e));subscribe("hvac.power"+key,()->{HvacPowerStateListener w=new HvacPowerStateListener(){public void onHvacPowerStateUpdated(Boolean v){value("hvac.power",key,"callback",v);}public void onFailed(Exception e){error("hvac.power",key,e);}};hvac.registerHvacPowerState(area,w);return ()->hvac.unregisterHvacPowerState(area,w);});}return Unit.INSTANCE;},e->error("hvac.power","capability",e));
            hvac.checkHvacAcCapabilities((cap,areas)->{capability("hvac.ac",cap,areas);if(readable(cap))for(SeatArea area:areas)hvac.getHvacAcState(area,v->value("hvac.ac",key(area),"read",v),e->error("hvac.ac",key(area),e));return Unit.INSTANCE;},e->error("hvac.ac","capability",e));
            hvac.checkHvacFanSpeedCapabilities((cap,ranges)->{capability("hvac.fanSpeed",cap,ranges.keySet());if(readable(cap))for(SeatArea area:ranges.keySet()){String key=key(area);hvac.getHvacFanSpeed(area,v->value("hvac.fanSpeed",key,"read",v),e->error("hvac.fanSpeed",key,e));subscribe("hvac.fanSpeed"+key,()->{HvacFanSpeedListener w=new HvacFanSpeedListener(){public void onHvacFanSpeedUpdated(Integer v){value("hvac.fanSpeed",key,"callback",v);}public void onFailed(Exception e){error("hvac.fanSpeed",key,e);}};hvac.registerHvacFanSpeed(area,w);return ()->hvac.unregisterHvacFanSpeed(area,w);});}return Unit.INSTANCE;},e->error("hvac.fanSpeed","capability",e));
            hvac.checkHvacTemperatureCurrentCapabilities((cap,areas)->{capability("hvac.currentCelsius",cap,areas);if(readable(cap))for(SeatArea area:areas)hvac.getHvacTemperatureCurrent(area,v->value("hvac.currentCelsius",key(area),"read",v),e->error("hvac.currentCelsius",key(area),e));return Unit.INSTANCE;},e->error("hvac.currentCelsius","capability",e));
            hvac.checkHvacTemperatureCapabilities((cap,ranges,conversion)->{capability("hvac.targetCelsius",cap,ranges.keySet());if(readable(cap))for(SeatArea area:ranges.keySet())hvac.getHvacTemperature(area,TemperatureUnit.CELSIUS,v->value("hvac.targetCelsius",key(area),"read",v),e->error("hvac.targetCelsius",key(area),e));return Unit.INSTANCE;},e->error("hvac.targetCelsius","capability",e));
        }catch(Exception e){error("hvac","initialize",e);}
        try{Door doors=vehicle.getDoor();doors.checkDoorPositionCapabilities((cap,ranges)->{capability("door.position",cap,ranges.keySet());if(readable(cap))for(DoorArea area:ranges.keySet())doors.getCurrentDoorPosition(area,v->value("door.position",key(area),"read",v),e->error("door.position",key(area),e));return Unit.INSTANCE;},e->error("door.position","capability",e));}catch(Exception e){error("door.position","initialize",e);}
        try{Window windows=vehicle.getWindow();windows.checkWindowPositionCapabilities((cap,ranges)->{capability("window.position",cap,ranges.keySet());if(readable(cap))for(WindowArea area:ranges.keySet())windows.getCurrentWindowPosition(area,v->value("window.position",key(area),"read",v),e->error("window.position",key(area),e));return Unit.INSTANCE;},e->error("window.position","capability",e));}catch(Exception e){error("window.position","initialize",e);}
        try{Light lights=vehicle.getLight();
            lights.checkAmbientLightBrightnessCapabilities((cap,ranges)->{capability("ambient.brightness",cap,ranges.keySet());if(readable(cap))for(SeatArea area:ranges.keySet())lights.getAmbientLightBrightness(area,v->value("ambient.brightness",key(area),"read",v),e->error("ambient.brightness",key(area),e));return Unit.INSTANCE;},e->error("ambient.brightness","capability",e));
            lights.checkAmbientLightBrightnessColorCapabilities((cap,areas)->{capability("ambient.color",cap,areas);if(readable(cap))for(SeatArea area:areas)lights.getAmbientLightBrightnessColor(area,v->value("ambient.color",key(area),"read",v),e->error("ambient.color",key(area),e));return Unit.INSTANCE;},e->error("ambient.color","capability",e));
        }catch(Exception e){error("ambient","initialize",e);}
    }
    private boolean readable(CapabilityConfig cap){return cap!=null&&(cap.getAccessType()==AccessType.READ||cap.getAccessType()==AccessType.READ_WRITE);}
    private void capability(String name,CapabilityConfig cap,Collection<?> areas){value(name,"capability","capability",(cap==null?"UNKNOWN":cap.getAccessType())+" areas="+areas.size());}
    private synchronized Unit value(String name,String area,String kind,Object value){if(closed)return Unit.INSTANCE;try{JSONObject item=new JSONObject().put("feature",name).put("area",area).put("kind",kind).put("value",value==null?JSONObject.NULL:value).put("receivedAt",System.currentTimeMillis()).put("source","PLEOS_VEHICLE_READ_ONLY");state.put(name+" / "+area,item);listener.onLog(item);listener.onState(new JSONObject(state.toString()));}catch(Exception ignored){}return Unit.INSTANCE;}
    private Unit error(String name,String area,Exception error){return value(name,area,"ERROR",error.getClass().getSimpleName()+":"+error.getMessage());}
    private String key(SeatArea area){return Arrays.toString(area.getValues());}
    private String key(DoorArea area){return Arrays.toString(area.getValues());}
    private String key(WindowArea area){return Arrays.toString(area.getValues());}
    interface Subscription {Runnable register();}
    private synchronized void subscribe(String key,Subscription subscription){if(closed||cleanup.containsKey(key))return;try{cleanup.put(key,subscription.register());}catch(Exception e){error(key,"subscribe",e);}}
    synchronized void close(){closed=true;for(Runnable r:cleanup.values())try{r.run();}catch(Exception ignored){}cleanup.clear();}
}

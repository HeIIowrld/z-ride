package ai.zride.demo.common;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import java.lang.ref.WeakReference;

/** Registered only by debug manifests and guarded by the DUMP sender permission. */
public final class DebugCommandReceiver extends BroadcastReceiver {
    private static volatile WeakReference<DemoActivity> current=new WeakReference<>(null);
    static void attach(DemoActivity activity){current=new WeakReference<>(activity);}
    static void detach(DemoActivity activity){if(current.get()==activity)current=new WeakReference<>(null);}
    @Override public void onReceive(Context context,Intent intent){
        if((context.getApplicationInfo().flags&ApplicationInfo.FLAG_DEBUGGABLE)==0||!"ai.zride.demo.DEBUG_COMMAND".equals(intent.getAction())){setResultCode(Activity.RESULT_CANCELED);return;}
        DemoActivity activity=current.get();
        if(activity==null||activity.isFinishing()||activity.isDestroyed()){setResultCode(Activity.RESULT_CANCELED);setResultData("No existing debug Activity; launch once first");return;}
        activity.receiveDebugCommand(new Intent(intent));setResultCode(Activity.RESULT_OK);setResultData("Queued on existing debug client; real gate still applies");
    }
}

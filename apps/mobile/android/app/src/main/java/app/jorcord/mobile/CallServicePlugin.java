package app.jorcord.mobile;

import android.content.Intent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** JS: Capacitor.Plugins.CallService.start({ title, camera }) / .stop(). */
@CapacitorPlugin(name = "CallService")
public class CallServicePlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        Intent i = new Intent(getContext(), CallForegroundService.class);
        i.putExtra("title", call.getString("title", "Jorcord call"));
        i.putExtra("camera", call.getBoolean("camera", false));
        ContextCompat.startForegroundService(getContext(), i);
        call.resolve(new JSObject());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent i = new Intent(getContext(), CallForegroundService.class).setAction("stop");
        getContext().startService(i);
        call.resolve(new JSObject());
    }
}

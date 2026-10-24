package app.jorcord.mobile;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * JS: Capacitor.Plugins.CallService.start({ title, camera }) / .stop().
 * Also exposes checkPermissions() / requestPermissions({permissions:['microphone','camera']}) (inherited from Plugin, driven by the
 * annotation below) and openAppSettings() for the "blocked" state, where Android will no longer show the runtime prompt.
 */
@CapacitorPlugin(name = "CallService", permissions = {
    @Permission(strings = { android.Manifest.permission.RECORD_AUDIO }, alias = "microphone"),
    @Permission(strings = { android.Manifest.permission.CAMERA }, alias = "camera")
})
public class CallServicePlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        // A microphone-type foreground service throws SecurityException on Android 14+ without RECORD_AUDIO; the web layer asks first.
        if (androidx.core.content.ContextCompat.checkSelfPermission(getContext(), android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            JSObject r = new JSObject(); r.put("started", false); r.put("reason", "microphone-permission");
            call.resolve(r);
            return;
        }
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

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve(new JSObject());
    }
}

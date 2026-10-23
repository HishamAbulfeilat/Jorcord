package app.jorcord.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS: Capacitor.Plugins.JorcordScreenShare
 *   isSupported() -> { supported }
 *   start({ maxDimension?, fps?, quality? }) -> {}   (shows the system consent dialog; rejects with code CANCELLED if declined)
 *   stop() -> {}
 *   events: "frame" { data: base64 jpeg, width, height }, "stopped" { reason }
 */
@CapacitorPlugin(name = "JorcordScreenShare")
public class ScreenSharePlugin extends Plugin implements ScreenShareService.Callbacks {
    private volatile PluginCall pendingStart;

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject r = new JSObject();
        r.put("supported", true); // MediaProjection exists on every API level this app supports (minSdk 24)
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (ScreenShareService.instance != null || pendingStart != null) { call.reject("Already sharing", "BUSY"); return; }
        MediaProjectionManager mpm = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) { call.reject("Screen capture is unavailable", "UNSUPPORTED"); return; }
        pendingStart = call;
        // Android 14+: consent is required for every capture session and the token cannot be reused.
        startActivityForResult(call, mpm.createScreenCaptureIntent(), "onConsent");
    }

    @ActivityCallback
    private void onConsent(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            pendingStart = null;
            call.reject("Screen share was cancelled", "CANCELLED");
            return;
        }
        ScreenShareService.callbacks = this;
        Intent i = new Intent(getContext(), ScreenShareService.class);
        i.putExtra("resultCode", result.getResultCode());
        i.putExtra("data", result.getData());
        i.putExtra("maxDim", call.getInt("maxDimension", 1280));
        i.putExtra("fps", call.getInt("fps", 8));
        i.putExtra("quality", call.getInt("quality", 60));
        try {
            ContextCompat.startForegroundService(getContext(), i);
        } catch (RuntimeException e) {
            pendingStart = null;
            call.reject("Could not start the screen share service: " + e.getMessage(), "FAILED");
        }
        // pendingStart is resolved by onStarted() / rejected by onStopped() below
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ScreenShareService s = ScreenShareService.instance;
        if (s != null) s.shutdown("stopped");
        call.resolve(new JSObject());
    }

    @Override
    public void onStarted() {
        PluginCall c = pendingStart; pendingStart = null;
        if (c != null) c.resolve(new JSObject());
    }

    @Override
    public void onFrame(String jpegBase64, int width, int height) {
        JSObject o = new JSObject();
        o.put("data", jpegBase64); o.put("width", width); o.put("height", height);
        notifyListeners("frame", o);
    }

    @Override
    public void onStopped(String reason) {
        PluginCall c = pendingStart; pendingStart = null;
        if (c != null) { c.reject("Screen share failed to start (" + reason + ")", "FAILED"); return; }
        JSObject o = new JSObject();
        o.put("reason", reason);
        notifyListeners("stopped", o);
    }

    @Override
    protected void handleOnDestroy() {
        ScreenShareService s = ScreenShareService.instance;
        if (s != null) s.shutdown("destroyed");
        ScreenShareService.callbacks = null;
    }
}

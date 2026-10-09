package app.jorcord.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CallServicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}

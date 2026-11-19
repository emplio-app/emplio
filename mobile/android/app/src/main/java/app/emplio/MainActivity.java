package app.emplio;

import android.content.res.Configuration;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Android 15 and later draw the app under the status bar, the navigation bar and the keyboard. The page sits
        // between them instead, like the iPhone app: the strips show the page's colour (styles.xml), and the keyboard
        // shrinks the page to the space above it rather than covering the box being typed in.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        View page = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(page, (v, all) -> {
            Insets bars = all.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            ViewGroup.MarginLayoutParams m = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
            m.setMargins(bars.left, bars.top, bars.right, bars.bottom);
            v.setLayoutParams(m);
            return all;
        });
    }

    // Dark icons on the bars in light mode, light ones in dark mode. Set on every return, as the splash screen's
    // theme switch resets them after onCreate.
    @Override
    public void onResume() {
        super.onResume();
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(!night);
        bars.setAppearanceLightNavigationBars(!night);
    }
}

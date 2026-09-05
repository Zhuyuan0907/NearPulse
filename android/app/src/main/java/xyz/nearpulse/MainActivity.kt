package xyz.nearpulse

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import xyz.nearpulse.sensor.AltitudeEstimator
import xyz.nearpulse.sensor.CrowdMotionDetector
import xyz.nearpulse.sensor.SensorHub

/**
 * ============================================================================
 * MainActivity —— Android 版的最小可用外殼
 * ============================================================================
 * 這個 App 的定位不是「把網頁版重寫一次」，而是補上**網頁做不到的那一層**：
 *
 *   氣壓計樓層偵測   網頁完全拿不到這顆感測器；而「你在 B1 還是 B3」
 *                    決定你要往上走幾層、也決定救援要去哪一層找你
 *   人流停滯偵測     推擠事故的物理徵兆是「人不動了」，而這只需要加速度計、
 *                    不需要地下不可靠的磁力計
 *
 * 回報、場域圖資、疏散建議全部沿用同一組 server API——
 * v0.3 把業務邏輯搬到 server 的決定，讓這裡不需要重寫任何一行。
 */
class MainActivity : ComponentActivity() {

    private lateinit var hub: SensorHub

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        hub = SensorHub(this)
        setContent { MaterialTheme(colorScheme = darkColorScheme()) { Screen(hub) } }
    }

    override fun onResume() { super.onResume(); hub.start() }
    override fun onPause() { super.onPause(); hub.stop() }
}

@Composable
private fun Screen(hub: SensorHub) {
    val floor by hub.floor.collectAsState()
    val motion by hub.motion.collectAsState()
    val hasBarometer = remember { hub.hasBarometer }

    Surface(Modifier.fillMaxSize()) {
        Column(
            Modifier.padding(20.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("NearPulse", style = MaterialTheme.typography.headlineMedium)
            Text(
                "網頁版做不到的那一層：垂直定位與被動偵測",
                style = MaterialTheme.typography.bodySmall,
            )

            ElevatedCard {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("你在第幾層", style = MaterialTheme.typography.titleMedium)
                    if (!hasBarometer) {
                        Text("這支手機沒有氣壓計——樓層偵測停用，其餘功能不受影響。")
                    } else {
                        Text(AltitudeEstimator.describe(floor))
                        Text(
                            "基準點在你失去 GPS 訊號的那一刻自動記錄——" +
                                "地下收不到 GPS 不是錯誤，那正好是「你進入地下」的訊號。",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Button(onClick = { hub.calibrateNow() }) { Text("我現在在地面，重新校正") }
                    }
                }
            }

            ElevatedCard {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("人流狀態", style = MaterialTheme.typography.titleMedium)
                    Text(
                        when (motion.motion) {
                            CrowdMotionDetector.Motion.WALKING -> "移動中"
                            CrowdMotionDetector.Motion.STILL -> "靜止"
                            CrowdMotionDetector.Motion.STALLED -> "⚠️ 從走動突然停滯——人潮可能受阻"
                            else -> "偵測中…"
                        }
                    )
                    if (motion.motion == CrowdMotionDetector.Motion.STALLED) {
                        Text(
                            "系統不會自動通報——誤判的成本太高。要通報推擠嗎？",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
        }
    }
}

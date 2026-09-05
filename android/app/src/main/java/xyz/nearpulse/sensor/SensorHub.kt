package xyz.nearpulse.sensor

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * 感測器接線層：把 Android 的回呼轉成可觀察的狀態。
 *
 * 所有判斷邏輯都在 AltitudeEstimator / CrowdMotionDetector 這兩個純物件裡——
 * 它們沒有任何 Android 相依，所以能在 JVM 上做完整單元測試。
 * 這一層只負責「收取樣、維持時間窗、呼叫純函式」。
 */
class SensorHub(context: Context) : SensorEventListener {

    private val manager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val barometer: Sensor? = manager.getDefaultSensor(Sensor.TYPE_PRESSURE)
    private val accelerometer: Sensor? = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)

    val hasBarometer: Boolean get() = barometer != null

    private val pressureWindow = ArrayDeque<Double>()
    private val accelWindow = ArrayDeque<Double>()
    private var baseline: AltitudeEstimator.Baseline? = null

    private val _floor = MutableStateFlow<AltitudeEstimator.FloorEstimate?>(null)
    val floor: StateFlow<AltitudeEstimator.FloorEstimate?> = _floor

    private val _motion = MutableStateFlow(CrowdMotionDetector.State())
    val motion: StateFlow<CrowdMotionDetector.State> = _motion

    fun start() {
        barometer?.let { manager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL) }
        accelerometer?.let { manager.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
    }

    fun stop() = manager.unregisterListener(this)

    /**
     * 手動校正：使用者確認自己在地面。
     * 自動校正的時機是「GPS 從有到無」——但使用者可能一開 App 就已經在地下，
     * 那時就需要這條手動路徑（走到地面後按一下）。
     */
    fun calibrateNow() {
        val current = pressureWindow.lastOrNull() ?: return
        baseline = AltitudeEstimator.Baseline(current, System.currentTimeMillis())
        recomputeFloor()
    }

    /** 由定位層在「剛失去 GPS」時呼叫——那一刻就是進入地下的瞬間 */
    fun calibrateOnGpsLost() = calibrateNow()

    override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
            Sensor.TYPE_PRESSURE -> {
                push(pressureWindow, event.values[0].toDouble(), max = 20)
                recomputeFloor()
            }
            Sensor.TYPE_ACCELEROMETER -> {
                val m = CrowdMotionDetector.magnitude(
                    event.values[0].toDouble(), event.values[1].toDouble(), event.values[2].toDouble()
                )
                push(accelWindow, m, max = 120)
                val next = CrowdMotionDetector.step(
                    _motion.value, accelWindow.toList(), System.currentTimeMillis()
                )
                _motion.value = next
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private fun recomputeFloor() {
        _floor.value = AltitudeEstimator.estimate(
            baseline, pressureWindow.toList(), System.currentTimeMillis()
        )
    }

    private fun push(window: ArrayDeque<Double>, v: Double, max: Int) {
        window.addLast(v)
        while (window.size > max) window.removeFirst()
    }
}

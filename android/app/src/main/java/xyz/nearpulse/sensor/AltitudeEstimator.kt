package xyz.nearpulse.sensor

import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * ============================================================================
 * AltitudeEstimator —— 用氣壓計判斷「你在地下第幾層」
 * ============================================================================
 * 【這是 Android 版存在的理由】
 *
 * 地下定位最缺的是**垂直維度**：你在 B1 大廳還是 B3 月台？
 * 這件事決定你要往上走幾層才出得去，也決定救援要去哪一層找你。
 *
 * 網頁完全拿不到氣壓計——DeviceMotionEvent 只有加速度，
 * Generic Sensor API 沒有 barometer。這是原生 App 才做得到的事。
 *
 * 【原理】
 * 氣壓隨高度下降約 0.12 hPa/m（海平面附近）。捷運站的樓層間距約 4~6m，
 * 換算約 0.5~0.7 hPa/層。手機氣壓計的解析度通常是 0.01~0.06 hPa，
 * 遠比一層樓的差異細——所以分辨得出樓層。
 *
 * 【但絕對氣壓沒有意義——這是關鍵】
 * 1013 hPa 不代表任何高度，因為天氣會讓它變化好幾 hPa（比好幾層樓還多）。
 * 所以必須有基準點。
 *
 * 這裡用的基準點是：**GPS 失去訊號的那一刻，就是你進入地下的那一刻**。
 * 那時的氣壓即為「地面層」，之後的變化就是相對深度。
 *
 * ⚠️ 這個作法不是本專案的原創——文獻上已有成熟研究
 * （Scientific Reports 2024 的多建築垂直定位演算法即以 GPS 判定進入建築、
 *  由氣壓計追蹤樓層，回報樓層變化偵測敏感度 >95%）。
 * 我們的價值在於把它接到「地下事故的疏散與救援」這個用途上，
 * 而不是宣稱發明了這個方法。
 *
 * 【誠實的限制】
 * - 天氣在你待在地下期間也會變（通常每小時 < 0.5 hPa，風暴時更快）
 *   → 校正超過 STALE_MS 就標記為不可信，不再宣稱樓層
 * - 中低階手機常常沒有氣壓計 → 整個功能靜默停用
 * - 電梯與電扶梯會造成短暫的動態壓力 → 用中位數平滑，離散度大時標記為移動中
 * - **列車活塞效應**：列車進出站會把隧道裡的空氣推出來，在月台造成短暫但
 *   明顯的壓力起伏。同一份文獻明白指出，既有的樓層偵測研究**都沒有在深層
 *   捷運站驗證過**，而車站的 HVAC 加壓與活塞效應正是它們沒遇過的干擾。
 *   本實作的對策是「離散度大就不宣稱樓層」——活塞效應會讓取樣窗離散，
 *   因此會被歸類為 MOVING 而非誤報成某一層。這是保守但誠實的處理：
 *   **在月台上寧可說「不確定」，也不要說錯層數。**
 */
object AltitudeEstimator {

    /** 每公尺的氣壓變化（hPa）。海平面附近的標準值 */
    const val HPA_PER_METER = 0.12

    /** 捷運站的典型樓層間距（公尺）。用來把深度換算成層數 */
    const val METERS_PER_LEVEL = 5.0

    /** 校正值超過這段時間就不可信（天氣會漂移） */
    const val STALE_MS = 45L * 60 * 1000

    /** 小於這個深度視為仍在地面層——避免天氣雜訊被讀成「下了一層」 */
    const val MIN_DEPTH_M = 2.0

    /** 取樣離散度超過這個值代表正在垂直移動，此時不宣稱精確樓層 */
    const val MOVING_SPREAD_HPA = 0.5

    /**
     * 由氣壓差推算相對地面的深度（公尺，向下為正）。
     * 地下氣壓比地面高，所以 current > baseline 時深度為正。
     */
    fun depthMeters(baselineHpa: Double, currentHpa: Double): Double =
        (currentHpa - baselineHpa) / HPA_PER_METER

    /**
     * 由深度推算樓層（0 = 地面、-1 = B1、-2 = B2…）。
     * 淺於 MIN_DEPTH_M 一律回 0——寧可說「還在地面」也不要因天氣雜訊誤報。
     */
    fun levelFromDepth(depthM: Double): Int {
        if (abs(depthM) < MIN_DEPTH_M) return 0
        return -(depthM / METERS_PER_LEVEL).roundToInt()
    }

    /**
     * 完整估計。回傳的 level 為 null 代表「不知道」——
     * 在生命安全情境下，這是合法且必要的答案。
     *
     * @param baseline   校正資料；null 表示還沒在地面校正過
     * @param samplesHpa 近期氣壓取樣（中位數平滑）
     * @param nowMs      現在時間
     */
    fun estimate(baseline: Baseline?, samplesHpa: List<Double>, nowMs: Long): FloorEstimate? {
        if (baseline == null || samplesHpa.isEmpty()) return null

        val ageMs = nowMs - baseline.atMs
        if (ageMs > STALE_MS) {
            // 校正過期：天氣漂移可能已超過一層樓的差異，不能再宣稱樓層
            return FloorEstimate(level = null, depthM = null, confidence = Confidence.STALE)
        }

        val median = samplesHpa.sorted()[samplesHpa.size / 2]
        val depth = depthMeters(baseline.hpa, median)
        val spread = (samplesHpa.maxOrNull() ?: 0.0) - (samplesHpa.minOrNull() ?: 0.0)

        if (spread > MOVING_SPREAD_HPA) {
            return FloorEstimate(level = null, depthM = depth, confidence = Confidence.MOVING)
        }

        return FloorEstimate(
            level = levelFromDepth(depth),
            depthM = depth,
            confidence = if (ageMs > STALE_MS / 2) Confidence.LOW else Confidence.HIGH,
        )
    }

    /** 給人看的說法。不知道就說不知道。 */
    fun describe(estimate: FloorEstimate?): String = when {
        estimate == null -> "樓層未知（需要先在地面校正）"
        estimate.confidence == Confidence.STALE -> "樓層未知（校正已過期，請回地面重新校正）"
        estimate.confidence == Confidence.MOVING -> "垂直移動中（電梯或電扶梯）"
        estimate.level == null -> "樓層未知"
        estimate.level == 0 -> "地面層"
        estimate.level < 0 -> "地下 B${-estimate.level}（深約 ${estimate.depthM?.roundToInt()} 公尺）"
        else -> "地上 ${estimate.level} 樓"
    }

    /** 進入地下前記錄的基準點 */
    data class Baseline(val hpa: Double, val atMs: Long)

    data class FloorEstimate(
        val level: Int?,
        val depthM: Double?,
        val confidence: Confidence,
    )

    enum class Confidence { HIGH, LOW, MOVING, STALE }
}

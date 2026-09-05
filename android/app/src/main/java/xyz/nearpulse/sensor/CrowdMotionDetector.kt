package xyz.nearpulse.sensor

import kotlin.math.sqrt

/**
 * ============================================================================
 * CrowdMotionDetector —— 用加速度計偵測「人流停滯」
 * ============================================================================
 * 【為什麼不是拿感測器做定位】
 * 大家拿手機感測器做室內定位都卡在同一個地方：**地下的磁力計不可靠**
 * （鋼筋、第三軌、牽引電流、電扶梯全都在干擾）。沒有可靠方位，計步只能給
 * 「你走了多遠」而給不出「你往哪走」——只有半徑，沒有位置。這條路不通。
 *
 * 換個問題就通了：**推擠事故的特徵不是「人在哪」，是「人不動了」。**
 *
 * 原本在走的人潮突然全部停住，是踩踏事故成形前最明確的物理徵兆。
 * 而「這支手機在不在動」只需要加速度計的震幅變化，**完全不需要方位**。
 *
 * 多支手機在同一場域同時偵測到「從走動變成靜止」，就是群體停滯的訊號——
 * 而且完全不需要使用者做任何操作。
 *
 * 【誠實的限制】
 * - 只在 App 開著時有效（Android 可用前景服務延長，但仍需使用者曾開啟）
 * - 手機放口袋、拿在手上、講電話的訊號差很多 → 只用「相對變化」而非絕對閾值
 * - **絕不自動送出**：誤判成本太高。只能提示「你看起來停下來了，要通報嗎？」
 */
object CrowdMotionDetector {

    /** 判斷用的時間窗（毫秒）。太短會被單次晃動騙，太長會反應不及 */
    const val WINDOW_MS = 8_000L

    /** 走動的判準：加速度變異量高於此值視為在移動 */
    const val WALKING_VARIANCE = 0.35

    /** 靜止的判準：低於此值視為沒有在走 */
    const val STILL_VARIANCE = 0.12

    /** 從「走動」變成「靜止」要持續這麼久才算停滯，避免等紅燈式的短暫停下 */
    const val STALL_CONFIRM_MS = 5_000L

    /**
     * 一筆加速度取樣的「震幅」——扣掉重力後的合向量大小。
     * 用合向量而非單軸，是因為手機的方向不固定（口袋、手持、橫放都可能）。
     */
    fun magnitude(x: Double, y: Double, z: Double): Double =
        sqrt(x * x + y * y + z * z) - 9.81

    /** 一段取樣的變異量（母體變異數）。變異量比平均值更能反映「有沒有在動」 */
    fun variance(samples: List<Double>): Double {
        if (samples.size < 2) return 0.0
        val mean = samples.average()
        return samples.sumOf { (it - mean) * (it - mean) } / samples.size
    }

    /**
     * 由「先前狀態 + 目前窗內取樣」推進狀態機。
     *
     * 狀態的意義：
     *   WALKING —— 在移動
     *   STILL   —— 靜止但還不確定是不是異常（可能只是在等車）
     *   STALLED —— **從走動突然轉為持續靜止**，這才是值得提示的訊號
     */
    fun step(prev: State, samples: List<Double>, nowMs: Long): State {
        val v = variance(samples)

        return when {
            v >= WALKING_VARIANCE -> State(Motion.WALKING, sinceMs = nowMs, wasWalking = true)

            v <= STILL_VARIANCE -> {
                // 沒有走過就靜止 = 一開始就站著，不算停滯（例如在月台等車）
                if (!prev.wasWalking) return State(Motion.STILL, nowMs, wasWalking = false)

                val stillSince = if (prev.motion == Motion.WALKING) nowMs else prev.sinceMs
                val stalled = nowMs - stillSince >= STALL_CONFIRM_MS
                State(
                    motion = if (stalled) Motion.STALLED else Motion.STILL,
                    sinceMs = stillSince,
                    wasWalking = true,
                )
            }

            // 介於兩者之間：維持原狀，不在灰色地帶反覆跳動
            else -> prev
        }
    }

    /**
     * 這個狀態該不該提示使用者？
     * 只在剛進入 STALLED 時提示一次——反覆彈提示在恐慌中是幫倒忙。
     */
    fun shouldPrompt(prev: State, next: State): Boolean =
        next.motion == Motion.STALLED && prev.motion != Motion.STALLED

    data class State(
        val motion: Motion = Motion.UNKNOWN,
        val sinceMs: Long = 0,
        /** 這段期間內曾經走動過——沒走過就靜止不算停滯 */
        val wasWalking: Boolean = false,
    )

    enum class Motion { UNKNOWN, WALKING, STILL, STALLED }
}

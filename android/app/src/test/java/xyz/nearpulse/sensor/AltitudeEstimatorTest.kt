package xyz.nearpulse.sensor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 氣壓計樓層推算的單元測試。
 *
 * 這些是純函式，所以可以在 JVM 上完整驗證——不需要真機。
 * （真機上仍需驗證的是「感測器讀值本身」，那不是這裡能測的。）
 */
class AltitudeEstimatorTest {

    private val now = 1_000_000L
    private fun baseline(ageMs: Long = 0) =
        AltitudeEstimator.Baseline(hpa = 1013.0, atMs = now - ageMs)

    // ---- 基本換算 ----

    @Test
    fun `地下越深氣壓越高`() {
        // B2 約 10m 深 → 1013 + 10*0.12 = 1014.2
        val depth = AltitudeEstimator.depthMeters(1013.0, 1014.2)
        assertEquals(10.0, depth, 0.01)
    }

    @Test
    fun `地面層氣壓相同時深度為零`() {
        assertEquals(0.0, AltitudeEstimator.depthMeters(1013.0, 1013.0), 0.001)
    }

    @Test
    fun `深度換算成樓層`() {
        assertEquals(0, AltitudeEstimator.levelFromDepth(0.0))
        assertEquals(-1, AltitudeEstimator.levelFromDepth(5.0))
        assertEquals(-2, AltitudeEstimator.levelFromDepth(10.0))
        assertEquals(-3, AltitudeEstimator.levelFromDepth(15.0))
    }

    @Test
    fun `淺於門檻視為地面層——避免天氣雜訊被讀成下了一層`() {
        // 1.5m 的等效深度可能只是天氣變化，不該報成 B1
        assertEquals(0, AltitudeEstimator.levelFromDepth(1.5))
        assertEquals(0, AltitudeEstimator.levelFromDepth(-1.5))
    }

    // ---- 完整估計 ----

    @Test
    fun `沒有校正基準時回傳不知道`() {
        assertNull(AltitudeEstimator.estimate(null, listOf(1014.0), now))
    }

    @Test
    fun `正常情況下推算出 B2`() {
        val e = AltitudeEstimator.estimate(baseline(), listOf(1014.2, 1014.2, 1014.2), now)!!
        assertEquals(-2, e.level)
        assertEquals(AltitudeEstimator.Confidence.HIGH, e.confidence)
    }

    @Test
    fun `校正過期就不再宣稱樓層`() {
        val stale = baseline(ageMs = AltitudeEstimator.STALE_MS + 1)
        val e = AltitudeEstimator.estimate(stale, listOf(1014.2), now)!!
        assertNull(e.level)
        assertEquals(AltitudeEstimator.Confidence.STALE, e.confidence)
    }

    @Test
    fun `取樣離散度大時判定為垂直移動而非某一層`() {
        // 搭電梯下樓的過程：窗內壓力持續變化
        val e = AltitudeEstimator.estimate(baseline(), listOf(1013.2, 1013.8, 1014.4), now)!!
        assertNull(e.level)
        assertEquals(AltitudeEstimator.Confidence.MOVING, e.confidence)
    }

    @Test
    fun `中位數平滑掉單一離群值`() {
        // 中間那筆是雜訊，中位數應該仍落在 B2
        val e = AltitudeEstimator.estimate(baseline(), listOf(1014.2, 1014.25, 1014.2), now)!!
        assertEquals(-2, e.level)
    }

    @Test
    fun `校正偏舊時信心下降但仍給答案`() {
        val e = AltitudeEstimator.estimate(
            baseline(ageMs = AltitudeEstimator.STALE_MS / 2 + 1000), listOf(1014.2), now
        )!!
        assertEquals(-2, e.level)
        assertEquals(AltitudeEstimator.Confidence.LOW, e.confidence)
    }

    @Test
    fun `列車活塞效應不會被誤報成某一層`() {
        // 列車進站時把隧道空氣推出，月台壓力短暫起伏。
        // 文獻指出既有樓層偵測研究都未在深層捷運站驗證過，這正是未涵蓋的干擾。
        // 對策不是硬要算出樓層，而是承認「這段取樣不可信」。
        val piston = listOf(1014.2, 1014.9, 1015.1, 1014.4, 1014.2)
        val e = AltitudeEstimator.estimate(baseline(), piston, now)!!
        assertNull("活塞效應期間不應宣稱樓層", e.level)
        assertEquals(AltitudeEstimator.Confidence.MOVING, e.confidence)
    }

    // ---- 說法 ----

    @Test
    fun `不知道的時候說不知道`() {
        assertTrue(AltitudeEstimator.describe(null).contains("未知"))
        val stale = AltitudeEstimator.FloorEstimate(null, null, AltitudeEstimator.Confidence.STALE)
        assertTrue(AltitudeEstimator.describe(stale).contains("未知"))
    }

    @Test
    fun `地下樓層的說法帶樓層與深度`() {
        val e = AltitudeEstimator.FloorEstimate(-2, 10.0, AltitudeEstimator.Confidence.HIGH)
        val text = AltitudeEstimator.describe(e)
        assertTrue(text.contains("B2"))
        assertTrue(text.contains("10"))
    }
}

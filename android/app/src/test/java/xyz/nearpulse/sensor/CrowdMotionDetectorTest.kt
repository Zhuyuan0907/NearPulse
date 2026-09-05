package xyz.nearpulse.sensor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/**
 * 人流停滯偵測的單元測試。
 *
 * 重點在**防誤判**：一個誤判的「人流停滯」會讓使用者收到毫無根據的驚嚇提示，
 * 在恐慌情境下這比沒有這個功能更糟。所以測試的重心放在
 * 「什麼情況下不該觸發」，而不只是「什麼情況下會觸發」。
 */
class CrowdMotionDetectorTest {

    private val rng = Random(42)

    /** 走動：合向量震幅明顯起伏 */
    private fun walkingSamples() = List(40) { rng.nextDouble(-1.5, 1.5) }

    /** 靜止：只有極小的感測器雜訊 */
    private fun stillSamples() = List(40) { rng.nextDouble(-0.05, 0.05) }

    // ---- 基本計算 ----

    @Test
    fun `震幅扣掉重力`() {
        // 靜置時三軸合向量約等於重力，扣掉後接近 0
        assertEquals(0.0, CrowdMotionDetector.magnitude(0.0, 0.0, 9.81), 0.01)
    }

    @Test
    fun `變異量能區分走動與靜止`() {
        assertTrue(CrowdMotionDetector.variance(walkingSamples()) > CrowdMotionDetector.WALKING_VARIANCE)
        assertTrue(CrowdMotionDetector.variance(stillSamples()) < CrowdMotionDetector.STILL_VARIANCE)
    }

    // ---- 狀態機 ----

    @Test
    fun `走動被辨識為 WALKING`() {
        val s = CrowdMotionDetector.step(CrowdMotionDetector.State(), walkingSamples(), 1000)
        assertEquals(CrowdMotionDetector.Motion.WALKING, s.motion)
    }

    @Test
    fun `一直站著不算停滯——月台等車不該觸發`() {
        var s = CrowdMotionDetector.State()
        var t = 0L
        repeat(10) {
            t += 8000
            s = CrowdMotionDetector.step(s, stillSamples(), t)
        }
        assertEquals(CrowdMotionDetector.Motion.STILL, s.motion)
        assertFalse("從未走動過就不該判定為停滯", s.motion == CrowdMotionDetector.Motion.STALLED)
    }

    @Test
    fun `走動後短暫停下不算停滯——等紅燈式的停頓`() {
        var s = CrowdMotionDetector.step(CrowdMotionDetector.State(), walkingSamples(), 0)
        // 只停了 3 秒，未達 STALL_CONFIRM_MS
        s = CrowdMotionDetector.step(s, stillSamples(), 3000)
        assertEquals(CrowdMotionDetector.Motion.STILL, s.motion)
    }

    @Test
    fun `走動後持續靜止才判定為停滯`() {
        var s = CrowdMotionDetector.step(CrowdMotionDetector.State(), walkingSamples(), 0)
        s = CrowdMotionDetector.step(s, stillSamples(), 1000)   // 開始靜止
        s = CrowdMotionDetector.step(s, stillSamples(), 7000)   // 已靜止 6 秒 > 5 秒門檻
        assertEquals(CrowdMotionDetector.Motion.STALLED, s.motion)
    }

    @Test
    fun `灰色地帶維持原狀不反覆跳動`() {
        val walking = CrowdMotionDetector.step(CrowdMotionDetector.State(), walkingSamples(), 0)
        // 均勻分布 U(-a, a) 的變異數是 a^2/3，要落在 0.12 ~ 0.35 之間需要 a 約 0.6~1.0。
        // （初版用了 ±0.45 → 變異數只有 0.068，其實在「靜止」區間，測不到灰色地帶。）
        val mid = List(40) { rng.nextDouble(-0.8, 0.8) }
        val v = CrowdMotionDetector.variance(mid)
        assertTrue("測試資料本身必須落在灰色地帶，否則測不到要測的東西",
            v > CrowdMotionDetector.STILL_VARIANCE && v < CrowdMotionDetector.WALKING_VARIANCE)

        val s = CrowdMotionDetector.step(walking, mid, 1000)
        assertEquals(walking.motion, s.motion)
    }

    @Test
    fun `只在剛進入停滯時提示一次`() {
        var s = CrowdMotionDetector.step(CrowdMotionDetector.State(), walkingSamples(), 0)
        s = CrowdMotionDetector.step(s, stillSamples(), 1000)
        val beforeStall = s
        val stalled = CrowdMotionDetector.step(s, stillSamples(), 7000)
        assertTrue("剛進入停滯應提示", CrowdMotionDetector.shouldPrompt(beforeStall, stalled))

        val stillStalled = CrowdMotionDetector.step(stalled, stillSamples(), 15000)
        assertFalse("已經在停滯狀態就不該重複提示",
            CrowdMotionDetector.shouldPrompt(stalled, stillStalled))
    }

    @Test
    fun `恢復走動後狀態回到 WALKING`() {
        var s = CrowdMotionDetector.step(CrowdMotionDetector.State(), walkingSamples(), 0)
        s = CrowdMotionDetector.step(s, stillSamples(), 7000)
        s = CrowdMotionDetector.step(s, walkingSamples(), 12000)
        assertEquals(CrowdMotionDetector.Motion.WALKING, s.motion)
    }
}

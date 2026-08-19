package com.schoolerp.bustracker

import com.schoolerp.bustracker.ui.run.humanMetres
import com.schoolerp.bustracker.ui.run.niceRound
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The sketch has no basemap, so the scale bar is the only thing telling a
 * driver whether the dots are a street apart or a district apart. A bar reading
 * "437 m" reads as a measurement of something; 1, 2 or 5 times a power of ten
 * reads as a scale.
 */
class ScaleBarTest {

    @Test
    fun `a scale bar rounds down to one, two or five`() {
        assertEquals(100.0, niceRound(137.0), 0.001)
        assertEquals(200.0, niceRound(280.0), 0.001)
        assertEquals(500.0, niceRound(940.0), 0.001)
        assertEquals(1000.0, niceRound(1400.0), 0.001)
    }

    @Test
    fun `a zero or negative span produces no bar rather than a crash`() {
        assertEquals(0.0, niceRound(0.0), 0.001)
        assertEquals(0.0, niceRound(-5.0), 0.001)
    }

    @Test
    fun `distances read the way a person says them`() {
        assertEquals("450 m", humanMetres(450.0))
        assertEquals("1.2 km", humanMetres(1240.0))
    }
}

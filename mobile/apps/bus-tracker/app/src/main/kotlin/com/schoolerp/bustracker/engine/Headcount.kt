package com.schoolerp.bustracker.engine

import com.schoolerp.bustracker.data.local.StudentEntity
import com.schoolerp.bustracker.data.prefs.DIRECTION_DROP

/**
 * The numbers on a stop's row, worked out one way for the row, the next-stop
 * card and the notification so they cannot disagree.
 *
 * "Expected" excludes the children somebody already said are not coming. A
 * driver who sees "3 of 5" at a stop where two parents reported absence
 * waits for two children who are in bed; "3 of 3, 2 absent" is what happened.
 */
data class Headcount(
    val expected: Int,
    /** On for a pickup, off for a drop. */
    val done: Int,
    /** Reported absent before the run, by a parent or the class register. */
    val reportedAbsent: Int,
    /** Marked absent at the stop by the driver. */
    val markedAbsent: Int,
) {
    val outstanding: Int get() = expected - done - markedAbsent
    val complete: Boolean get() = expected > 0 && outstanding == 0

    fun summary(direction: String): String {
        val verb = if (direction == DIRECTION_DROP) "off" else "on"
        val parts = mutableListOf("$done of $expected $verb")
        if (markedAbsent > 0) parts += "$markedAbsent absent"
        if (reportedAbsent > 0) parts += "$reportedAbsent reported absent"
        return parts.joinToString(", ")
    }

    companion object {
        fun of(students: List<StudentEntity>, direction: String): Headcount {
            val doneStatus = if (direction == DIRECTION_DROP) "alighted" else "boarded"
            val expected = students.filterNot { it.absent }
            return Headcount(
                expected = expected.size,
                done = expected.count { it.effectiveStatus == doneStatus },
                reportedAbsent = students.count { it.absent },
                markedAbsent = expected.count { it.effectiveStatus == "absent" },
            )
        }
    }
}

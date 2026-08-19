package com.schoolerp.smsgateway.lint

import com.android.tools.lint.checks.infrastructure.LintDetectorTest
import com.android.tools.lint.checks.infrastructure.TestFiles.kotlin
import com.android.tools.lint.detector.api.Detector
import com.android.tools.lint.detector.api.Issue

/**
 * `LintDetectorTest` is a JUnit 3 `TestCase`, so these methods have to be named
 * `test…` to be discovered at all — a `@Test` annotation on a backtick-named
 * method is silently ignored and the suite reports "no tests found".
 */
class MessageBodyLoggingDetectorTest : LintDetectorTest() {

    override fun getDetector(): Detector = MessageBodyLoggingDetector()

    override fun getIssues(): List<Issue> = listOf(MessageBodyLoggingDetector.ISSUE)

    fun testLoggingAMessageBodyIsAnError() {
        lint().files(
            kotlin(
                """
                package com.schoolerp.smsgateway.demo

                import android.util.Log

                fun send(id: String, body: String) {
                    Log.d("tag", "sending ${'$'}id: ${'$'}body")
                }
                """,
            ).indented(),
        ).run().expectErrorCount(1)
    }

    fun testLoggingAnEntitysBodyFieldIsAnError() {
        lint().files(
            kotlin(
                """
                package com.schoolerp.smsgateway.demo

                import android.util.Log

                class Row(val id: String, val bodyRaw: String)

                fun send(row: Row) {
                    Log.w("tag", "could not send " + row.bodyRaw)
                }
                """,
            ).indented(),
        ).run().expectErrorCount(1)
    }

    fun testLoggingIdsAndOutcomesIsClean() {
        lint().files(
            kotlin(
                """
                package com.schoolerp.smsgateway.demo

                import android.util.Log

                fun send(id: String, outcome: String) {
                    Log.d("tag", "message ${'$'}id finished as ${'$'}outcome")
                }
                """,
            ).indented(),
        ).run().expectClean()
    }
}

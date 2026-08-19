package com.schoolerp.smsgateway.lint

import com.android.tools.lint.detector.api.Category
import com.android.tools.lint.detector.api.Detector
import com.android.tools.lint.detector.api.Implementation
import com.android.tools.lint.detector.api.Issue
import com.android.tools.lint.detector.api.JavaContext
import com.android.tools.lint.detector.api.Scope
import com.android.tools.lint.detector.api.Severity
import com.android.tools.lint.detector.api.SourceCodeScanner
import com.intellij.psi.PsiMethod
import org.jetbrains.uast.UCallExpression

/**
 * Fails the build when an SMS body could reach a log.
 *
 * The bodies this app carries are children's names, fee amounts and absence
 * notices. Logcat on a shared handset is readable over a USB cable by anyone
 * who picks the phone up, and crash reporters upload whatever was logged. The
 * app's own convention is that logging goes through `GwLog` and carries ids and
 * outcomes only; this is the check that keeps the convention true after the
 * fourth person has edited the file.
 */
class MessageBodyLoggingDetector : Detector(), SourceCodeScanner {

    override fun getApplicableMethodNames(): List<String> =
        listOf("d", "e", "i", "v", "w", "wtf", "println", "print", "format")

    override fun visitMethodCall(context: JavaContext, node: UCallExpression, method: PsiMethod) {
        if (!isLoggingCall(context, method)) return
        if (isExemptFile(context)) return

        val offending = node.valueArguments.firstOrNull { argument ->
            SUSPICIOUS.containsMatchIn(argument.asSourceString())
        } ?: return

        context.report(
            ISSUE,
            node,
            context.getLocation(node),
            "This log call may include an SMS body (`${offending.asSourceString().take(60)}`). " +
                "Message bodies carry children's names and fee amounts and must never be " +
                "logged — log the message id and the outcome instead.",
        )
    }

    private fun isLoggingCall(context: JavaContext, method: PsiMethod): Boolean {
        val evaluator = context.evaluator
        return evaluator.isMemberInClass(method, "android.util.Log") ||
            evaluator.isMemberInClass(method, "java.io.PrintStream") ||
            evaluator.isMemberInClass(method, "kotlin.io.ConsoleKt") ||
            evaluator.isMemberInClass(method, "com.schoolerp.smsgateway.core.GwLog")
    }

    /** `GwLog` and `MessageBody` are the redaction machinery, not users of it. */
    private fun isExemptFile(context: JavaContext): Boolean {
        val name = context.file.name
        return name == "GwLog.kt" || name == "MessageBody.kt"
    }

    companion object {
        /**
         * A deliberately blunt instrument. It catches identifiers and property
         * accesses that read like a message body, which is the shape every real
         * instance of this mistake has taken.
         */
        private val SUSPICIOUS = Regex(
            "\\b(" +
                "body|bodyRaw|messageBody|smsBody|" +
                "\\w*\\.body|\\w*\\.bodyRaw|" +
                "messageText|smsText|\\w*\\.text\\b|" +
                "expose\\(\\)" +
                ")",
            RegexOption.IGNORE_CASE,
        )

        val ISSUE: Issue = Issue.create(
            id = "SmsBodyLogged",
            briefDescription = "SMS body may be logged",
            explanation = """
                The bodies this gateway sends contain children's names, fee amounts and \
                absence notices. Anything written to logcat can be read over a USB cable \
                and is collected by crash reporters.

                Log the server's message id and the outcome instead. Everything the office \
                needs in order to diagnose a failure is derivable from those two.
            """,
            category = Category.SECURITY,
            priority = 9,
            severity = Severity.ERROR,
            implementation = Implementation(
                MessageBodyLoggingDetector::class.java,
                Scope.JAVA_FILE_SCOPE,
            ),
        )
    }
}

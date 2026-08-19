package com.schoolerp.smsgateway.lint

import com.android.tools.lint.client.api.IssueRegistry
import com.android.tools.lint.client.api.Vendor
import com.android.tools.lint.detector.api.CURRENT_API
import com.android.tools.lint.detector.api.Issue

class SmsGatewayIssueRegistry : IssueRegistry() {

    override val issues: List<Issue> = listOf(MessageBodyLoggingDetector.ISSUE)

    override val api: Int = CURRENT_API

    override val minApi: Int = 14

    override val vendor: Vendor = Vendor(
        vendorName = "School ERP",
        feedbackUrl = "https://github.com/school-erp/erp/issues",
        identifier = "sms-gateway-lint",
    )
}
